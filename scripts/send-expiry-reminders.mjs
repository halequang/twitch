#!/usr/bin/env node
/**
 * Emails renters whose rental ends soon, via Resend, using BCC.
 *
 * BCC means one message body shared by everyone in the batch, so the email is
 * deliberately generic: no login, no password, no per-person expiry time. That
 * is the right trade here — recipients cannot see each other, and credentials
 * never travel by email where they would outlive the rental in someone's inbox.
 * The exact time and the extend button live behind the customer's own login.
 *
 * Usage:
 *   node scripts/send-expiry-reminders.mjs                      # dry run, local DB
 *   node scripts/send-expiry-reminders.mjs --remote             # dry run, production DB
 *   node scripts/send-expiry-reminders.mjs --remote --send      # actually emails people
 *   node scripts/send-expiry-reminders.mjs --test me@you.com    # one real email, to you only
 *
 * Nothing is sent without --send. A dry run prints exactly who would be mailed
 * and the message they would get; --send against --remote asks for typed
 * confirmation unless --yes is passed.
 *
 * Options:
 *   --hours <n>     how far ahead to look (default 3, max 168)
 *   --cooldown <n>  hours one address must go between reminders (default 24).
 *                   0 disables it, which is only sensible in testing
 *   --remote        read the deployed D1 (default: local)
 *   --send          really call Resend; without it nothing leaves the machine
 *   --yes           skip the confirmation prompt (for cron)
 *   --test <email>  send the message to this address only, and mark nothing
 *   --many true     with --test, preview the multi-rental wording instead
 *   --from <addr>   override RESEND_FROM
 *   --subject <s>   override the subject line
 *
 * Env (from the environment, or .dev.vars):
 *   RESEND_API_KEY  required to send. Create at https://resend.com/api-keys
 *   RESEND_FROM     e.g. "FunGaming VN <no-reply@fungamingvn.shop>". The domain
 *                   must be verified in Resend or the API answers 403.
 *   RESEND_REPLY_TO optional address for replies (customers will reply)
 *   RESEND_TO       optional visible To: address; defaults to the from address.
 *                   Resend requires a To, and it must not be a customer.
 *   RESEND_API_BASE optional override, for pointing at a stub during testing
 *
 * Nobody is emailed twice, guarded at three levels — this runs on a schedule, and
 * a duplicate is the kind of mistake a customer sees:
 *   - per address, per run: rentals are grouped by email, so holding three
 *     accounts still means one email.
 *   - per address, across runs: an address reminded inside --cooldown is skipped
 *     entirely. Without this, someone whose rentals expire hours apart gets a
 *     fresh email each time the next one enters the window — different order,
 *     but an identical-looking message, which reads as spam.
 *   - per order: reminder_sent_at is written only after Resend accepts the batch,
 *     and each batch carries an Idempotency-Key derived from its recipients that
 *     Resend honours for 24h, so a crash mid-run cannot double-send either.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const DB_NAME = 'fungaming-rentals';
const PAGE_URL = 'https://fungamingvn.shop/thuegame/theisle';

// Resend documents "Max 50" recipients for `to` and says nothing about bcc, so
// bcc is chunked at the same 50 rather than assuming it is unlimited.
const MAX_BCC = 50;
// Documented limit is 10 requests/second per team; one batch per 150ms is well
// under it and irrelevant at these volumes anyway.
const BATCH_PAUSE_MS = 150;

/* ─── config ──────────────────────────────────── */

function parseArgs(argv) {
  const out = { hours: 3, cooldown: 24, remote: false, send: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remote') out.remote = true;
    else if (arg === '--send') out.send = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
  }
  out.hours = Math.min(Math.max(Number(out.hours) || 3, 1), 168);
  // 0 is a deliberate "no cooldown", so it must survive the || fallback.
  const cd = Number(out.cooldown);
  out.cooldown = Math.min(Math.max(Number.isFinite(cd) ? cd : 24, 0), 720);
  return out;
}

function fromDevVars(name) {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    // Line by line on purpose: a multiline regex with \s* around the "=" lets an
    // empty KEY= swallow the next line as its value, which would hand back a
    // comment instead of reporting the key as unset.
    for (const line of txt.split('\n')) {
      const m = /^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
      if (m && m[1] === name && m[2]) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const conf = (name) => process.env[name] || fromDevVars(name) || null;

/* ─── database ────────────────────────────────── */

function d1(sql, remote) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
  );
  // wrangler prints the JSON array last; anything before it is noise.
  const start = out.indexOf('[');
  if (start === -1) return [];
  const data = JSON.parse(out.slice(start));
  const block = Array.isArray(data) ? data[0] : data;
  return block?.results ?? [];
}

const sqlQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * Live rentals ending inside the window that nobody has been emailed about yet.
 * Apple sign-in allows a null email, so those rows are skipped here rather than
 * silently producing an empty recipient.
 */
function dueRentals(remote, hours, now) {
  return d1(
    `SELECT order_code, user_email, expires_at, hours, game
       FROM orders
      WHERE status = 'active'
        AND reminder_sent_at IS NULL
        AND user_email IS NOT NULL AND TRIM(user_email) <> ''
        AND expires_at IS NOT NULL
        AND expires_at > ${now}
        AND expires_at <= ${now + hours * 3600}
      ORDER BY expires_at`,
    remote
  );
}

/**
 * When each address was last reminded, for reminders newer than `since`.
 * Keyed on the address rather than the order, because "do not email this person
 * again yet" is a fact about the person — which order triggered it is irrelevant.
 */
function lastRemindedByEmail(remote, since) {
  const rows = d1(
    `SELECT lower(TRIM(user_email)) AS email, MAX(reminder_sent_at) AS last_at
       FROM orders
      WHERE reminder_sent_at IS NOT NULL
        AND reminder_sent_at > ${Number(since)}
        AND user_email IS NOT NULL AND TRIM(user_email) <> ''
      GROUP BY lower(TRIM(user_email))`,
    remote
  );
  return new Map(rows.map((r) => [r.email, Number(r.last_at)]));
}

/** One entry per address: the same person may hold two rentals at once. */
function groupByEmail(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    const email = String(row.user_email).trim();
    const key = email.toLowerCase();
    const entry = byEmail.get(key) || { email, orderCodes: [], soonest: row.expires_at };
    entry.orderCodes.push(row.order_code);
    entry.soonest = Math.min(entry.soonest, row.expires_at);
    byEmail.set(key, entry);
  }
  return [...byEmail.values()].sort((a, b) => a.soonest - b.soonest);
}

function markReminded(orderCodes, remote, ts) {
  if (!orderCodes.length) return;
  d1(
    `UPDATE orders SET reminder_sent_at = ${ts}
      WHERE order_code IN (${orderCodes.map((c) => Number(c)).join(',')})`,
    remote
  );
}

/* ─── message ─────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function subjectFor(hours, override, many = false) {
  if (override) return override;
  return many
    ? `Có tài khoản thuê của bạn sắp hết hạn (dưới ${hours} giờ)`
    : `Tài khoản thuê của bạn sắp hết hạn (dưới ${hours} giờ)`;
}

/**
 * `many` is for renters holding more than one rental that ends in this window.
 * BCC forbids saying *which* account, so the wording must not imply there is only
 * one — otherwise someone renting three reads it and cannot tell what is ending.
 */
function textBody(hours, many = false) {
  return [
    'Xin chào,',
    '',
    many
      ? `Bạn đang thuê nhiều tài khoản Steam tại FunGaming VN, và có tài khoản sẽ hết hạn trong khoảng ${hours} giờ tới.`
      : `Tài khoản Steam bạn đang thuê tại FunGaming VN sẽ hết hạn trong khoảng ${hours} giờ tới.`,
    ...(many
      ? ['', 'Hãy đăng nhập để xem chính xác tài khoản nào sắp hết hạn — thời gian còn lại hiện riêng cho từng tài khoản.']
      : []),
    '',
    'Khi hết hạn, tài khoản được thu hồi và mật khẩu sẽ được đổi ngay, nên bạn hãy:',
    '  · Lưu tiến trình và thoát game trước khi hết giờ.',
    '  · Gia hạn nếu muốn tiếp tục chơi — giữ nguyên tài khoản đang dùng.',
    '',
    `Xem thời gian còn lại chính xác và gia hạn tại: ${PAGE_URL}`,
    'Đăng nhập bằng đúng Google/Apple bạn đã dùng khi thuê để thấy tài khoản của mình.',
    '',
    'Email này không chứa thông tin đăng nhập — thông tin đó chỉ hiện trong trang sau khi bạn đăng nhập.',
    '',
    'Cảm ơn bạn đã sử dụng dịch vụ.',
    'FunGaming VN',
  ].join('\n');
}

function htmlBody(hours, many = false) {
  return `<!doctype html>
<html lang="vi">
<body style="margin:0;padding:24px;background:#0c1a10;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#101f14;border:1px solid #2c4a2f;border-radius:6px;">
    <tr><td style="padding:26px 24px;">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7fae63;">FunGaming VN</p>
      <h1 style="margin:0 0 16px;font-size:20px;color:#f3e3b3;">Tài khoản thuê sắp hết hạn</h1>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#f3e3b3;">
        ${
          many
            ? `Bạn đang thuê nhiều tài khoản Steam, và có tài khoản sẽ hết hạn trong khoảng <strong style="color:#e8c877;">${esc(hours)} giờ</strong> tới.`
            : `Tài khoản Steam bạn đang thuê sẽ hết hạn trong khoảng <strong style="color:#e8c877;">${esc(hours)} giờ</strong> tới.`
        }
      </p>
      ${
        many
          ? '<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#f3e3b3;">Hãy đăng nhập để xem chính xác tài khoản nào sắp hết hạn — thời gian còn lại hiện riêng cho từng tài khoản.</p>'
          : ''
      }
      <p style="margin:0 0 8px;font-size:14px;line-height:1.7;color:#f3e3b3;">
        Khi hết hạn, tài khoản được thu hồi và mật khẩu sẽ được đổi ngay. Bạn hãy:
      </p>
      <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.8;color:#f3e3b3;">
        <li>Lưu tiến trình và thoát game trước khi hết giờ.</li>
        <li>Gia hạn nếu muốn chơi tiếp — vẫn giữ đúng tài khoản đang dùng.</li>
      </ul>
      <p style="margin:0 0 22px;">
        <a href="${PAGE_URL}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#0c1a10;background:#e8c877;border-radius:4px;text-decoration:none;">Xem &amp; gia hạn</a>
      </p>
      <p style="margin:0 0 14px;font-size:13px;line-height:1.7;color:#7fae63;">
        Đăng nhập bằng đúng Google/Apple bạn đã dùng khi thuê để thấy thời gian còn lại chính xác.
      </p>
      <p style="margin:0;padding-top:14px;border-top:1px solid #2c4a2f;font-size:12px;line-height:1.7;color:#7fae63;">
        Email này không chứa thông tin đăng nhập — thông tin đó chỉ hiện trong trang sau khi bạn đăng nhập.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

/* ─── Resend ──────────────────────────────────── */

/**
 * A key derived from the recipients, so a retry of the same batch is collapsed by
 * Resend while a genuinely different batch still goes out. Time is not part of it
 * on purpose: a retry minutes later must still be recognised as the same send.
 */
function idempotencyKey(hours, emails, many = false) {
  const digest = createHash('sha256')
    .update(`expiry-reminder|${hours}|${many ? 'many' : 'one'}|${[...emails].sort().join(',')}`)
    .digest('hex');
  return `expiry-${hours}h-${digest.slice(0, 32)}`;
}

async function sendBatch({ base, apiKey, from, to, replyTo, bcc, subject, hours, many = false }) {
  const payload = {
    from,
    to: [to],
    bcc,
    subject,
    text: textBody(hours, many),
    html: htmlBody(hours, many),
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(hours, bcc.length ? bcc : [to], many),
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) {
    let reason = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      reason = parsed.message || parsed.error?.message || reason;
    } catch {
      /* keep the raw text */
    }
    throw new Error(`Resend HTTP ${res.status}: ${reason}`);
  }
  let id = null;
  try {
    id = JSON.parse(body).id ?? null;
  } catch {
    /* id is only for the log */
  }
  return id;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim().toLowerCase()))));
}

/* ─── main ────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
const where = args.remote ? 'REMOTE (production)' : 'local';
const now = Math.floor(Date.now() / 1000);
// Per-group subjects are computed with the send plan; these are for --test.
const testMany = args.many === 'true' || args.many === '1';
const testSubject = subjectFor(args.hours, args.subject, testMany);

const apiKey = conf('RESEND_API_KEY');
const from = args.from || conf('RESEND_FROM');
const replyTo = conf('RESEND_REPLY_TO');
const base = (conf('RESEND_API_BASE') || 'https://api.resend.com').replace(/\/+$/, '');
// Resend requires a visible To. It must never be a customer, so it defaults to
// the sender rather than to the first person in the list.
const visibleTo = conf('RESEND_TO') || from;

if (args.test) {
  if (!apiKey || !from) {
    console.error('--test needs RESEND_API_KEY and RESEND_FROM (env or .dev.vars).');
    process.exit(1);
  }
  console.log(`[test] one email to ${args.test} via ${base}; the database is not touched.`);
  const id = await sendBatch({
    base, apiKey, from, to: args.test, replyTo, bcc: [], subject: testSubject, hours: args.hours,
    many: testMany,
  });
  console.log(`✓ sent${id ? ` (id ${id})` : ''}.`);
  process.exit(0);
}

let rows;
try {
  rows = dueRentals(args.remote, args.hours, now);
} catch (e) {
  console.error(`Failed to read the ${where} database: ${e.message}`);
  console.error('If this mentions reminder_sent_at, apply migrations/0006_expiry_reminder.sql first.');
  process.exit(1);
}

const grouped = groupByEmail(rows);
const fmt = (ts) => new Date(ts * 1000).toLocaleString('vi-VN', { hour12: false });

// Hold back anyone already emailed inside the cooldown, whichever rental it was
// about. This is the guard that stops staggered expiries reading as repeat spam.
const cooldownSeconds = Math.round(args.cooldown * 3600);
const lastSent = cooldownSeconds ? lastRemindedByEmail(args.remote, now - cooldownSeconds) : new Map();
const recipients = [];
const suppressed = [];
for (const r of grouped) {
  const seenAt = lastSent.get(r.email.toLowerCase());
  if (seenAt) suppressed.push({ ...r, seenAt });
  else recipients.push(r);
}

console.log(
  `[db] ${where}: ${rows.length} rental(s) ending within ${args.hours}h and not yet reminded ` +
    `→ ${grouped.length} recipient(s).`
);

if (suppressed.length) {
  console.log(
    `[cooldown] holding back ${suppressed.length} recipient(s) emailed in the last ` +
      `${args.cooldown}h — one reminder per customer, not one per rental:`
  );
  for (const r of suppressed) {
    console.log(
      `  · ${r.email}  ·  last emailed ${fmt(r.seenAt)}  ·  ` +
        `eligible again ${fmt(r.seenAt + cooldownSeconds)}`
    );
  }
}

if (!recipients.length) {
  console.log('Nothing to send.');
  process.exit(0);
}

for (const r of recipients) {
  const n = r.orderCodes.length;
  console.log(
    `  · ${r.email}  ·  hết hạn ${fmt(r.soonest)}  ·  ` +
      `${n} đơn: ${r.orderCodes.join(', ')}`
  );
}

// One address gets one email however many rentals it holds — but the two cases
// cannot share a body, because BCC leaves no room to say *which* account is
// ending. So the run is split by rental count and each half gets wording that is
// true for it. Every group is chunked separately, so a group never exceeds the
// BCC cap by riding along with another.
const groups = [
  { many: false, recipients: recipients.filter((r) => r.orderCodes.length === 1) },
  { many: true, recipients: recipients.filter((r) => r.orderCodes.length > 1) },
].filter((g) => g.recipients.length);

const plan = groups.map((g) => ({
  ...g,
  subject: subjectFor(args.hours, args.subject, g.many),
  batches: chunk(g.recipients, MAX_BCC),
}));

console.log(
  `\nFrom:    ${from || '(RESEND_FROM unset)'}\n` +
    `To:      ${visibleTo || '(unset)'}   (visible; recipients go in BCC)`
);
for (const g of plan) {
  console.log(
    `\n[${g.many ? 'nhiều tài khoản' : 'một tài khoản'}] ${g.recipients.length} recipient(s), ` +
      `${g.batches.length} batch(es) × up to ${MAX_BCC} BCC\n  Subject: ${g.subject}`
  );
}

// Belt and braces: the grouping above should make this impossible, but a
// duplicate address here would mean a customer gets two copies of the same
// message in one run, so it is worth proving rather than assuming.
const everyRecipient = plan.flatMap((g) => g.batches.flat().map((r) => r.email.toLowerCase()));
const duplicated = everyRecipient.filter((e, i) => everyRecipient.indexOf(e) !== i);
if (duplicated.length) {
  console.error(
    `\nBUG: ${[...new Set(duplicated)].join(', ')} appears in more than one batch. ` +
      'Refusing to send rather than double-emailing a customer.'
  );
  process.exit(1);
}

if (!args.send) {
  for (const g of plan) {
    console.log(`\n─── message for [${g.many ? 'nhiều tài khoản' : 'một tài khoản'}] (text part) ───`);
    console.log(textBody(args.hours, g.many));
  }
  console.log('\nDry run — nothing sent. Add --send to email these people.');
  process.exit(0);
}

if (!apiKey || !from) {
  console.error('\nRESEND_API_KEY and RESEND_FROM must be set (env or .dev.vars) to send.');
  process.exit(1);
}

if (args.remote && !args.yes) {
  const answer = await ask(
    `\nAbout to email ${recipients.length} real customer(s) from PRODUCTION data. Type 'yes' to proceed: `
  );
  if (answer !== 'yes' && answer !== 'y') {
    console.log('Aborted. Nothing sent.');
    process.exit(0);
  }
}

let sent = 0;
let failed = 0;
let pause = false;
for (const g of plan) {
  const label = g.many ? 'nhiều' : 'một';
  for (const [i, batch] of g.batches.entries()) {
    if (pause) await sleep(BATCH_PAUSE_MS);
    pause = true;
    const bcc = batch.map((r) => r.email);
    try {
      const id = await sendBatch({
        base, apiKey, from, to: visibleTo, replyTo, bcc,
        subject: g.subject, hours: args.hours, many: g.many,
      });
      // Marked only now: an unsent batch must stay due, and a batch sent but not
      // marked is at worst re-sent once, where the Idempotency-Key absorbs it.
      markReminded(batch.flatMap((r) => r.orderCodes), args.remote, Math.floor(Date.now() / 1000));
      sent += bcc.length;
      console.log(`  ✓ [${label}] batch ${i + 1}/${g.batches.length}: ${bcc.length} recipient(s)${id ? ` (id ${id})` : ''}`);
    } catch (e) {
      failed += bcc.length;
      console.error(`  ⚠️  [${label}] batch ${i + 1}/${g.batches.length} failed, left due for the next run: ${e.message}`);
    }
  }
}

console.log(`\nDone: ${sent} emailed, ${failed} still due.`);
process.exit(failed ? 1 : 0);
