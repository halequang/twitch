#!/usr/bin/env node
/**
 * Checks every rental account for bans: VAC, developer game bans, trade/market
 * standing, community ban, Steam Support lock, and the "limited account" flag.
 *
 * It also reports each account's mailbox, because that is the other way an account
 * stops being rentable and no ban source mentions it: Guard codes land there, and
 * whoever holds the address can reset the password and keep the account. Any run
 * that logs in compares the address Steam has against the one in the database — a
 * difference means somebody changed it. Exit status is non-zero for that as well as
 * for a ban.
 *
 * Two ways to learn an account's standing, and this uses whichever is cheapest:
 *
 *   1. GetPlayerBans — a public HTTP call, no login, safe to run on an account a
 *      customer is playing right now. Needs the account's steamID64.
 *   2. Logging in — the only way to LEARN that steamID64, since a Steam login
 *      name cannot be resolved to one by any public endpoint. Also the only
 *      source for `locked` and `limited`, which the public API does not expose.
 *
 * So the first run logs in, and writes steam_id back to the database. Every run
 * after that is free and login-free for accounts already known.
 *
 * Logging in is NOT harmless: Steam may boot a second session out of a game, and
 * it sends the account's mailbox a security alert. Accounts with a live rental are
 * therefore skipped unless you pass --include-rented, the same rule
 * steam_change_password.py follows.
 *
 * Usage:
 *   node scripts/check-account-bans.mjs --remote --login Ot2Zp7Hp8Vc0 --include-rented
 *   node scripts/check-account-bans.mjs --remote                 # check production
 *   node scripts/check-account-bans.mjs --remote --no-login      # only known steam_ids
 *   node scripts/check-account-bans.mjs --remote --login <name>  # one account
 *   node scripts/check-account-bans.mjs --remote --include-rented
 *
 * Options:
 *   --remote          read/write the deployed D1 (default: local)
 *   --no-login        skip the login step; report unknown accounts as unchecked
 *   --relogin         re-probe accounts whose steamID is already known. `locked`
 *                     and `limited` are only visible from a login, so without
 *                     this they are never re-checked after the first discovery
 *   --login <name>    only this account (still honours the live-rental guard)
 *   --include-rented  also log into accounts a customer is currently renting
 *   --limit <n>       stop after n logins (default 10, so a first run is bounded)
 *   --timeout <s>     per-login timeout in seconds (default 45)
 *   --dry-run         do not write steam_id / ban_state back
 *   --full-emails     print mailbox addresses in full instead of masked. Masking is
 *                     the default because this output gets pasted into chats
 *
 * Env (from the environment, or .dev.vars):
 *   ACCOUNT_ENC_KEY  required to decrypt the stored Steam passwords
 *   STEAM_API_KEY    optional. Adds game bans, trade standing and days-since-ban
 *                    from GetPlayerBans. Create one at
 *                    https://steamcommunity.com/dev/apikey — do NOT reuse the key
 *                    hardcoded in scripts/lend_account.js, which is committed to
 *                    this repository and must be treated as public.
 *
 * Steam Guard: a fresh login usually needs an emailed code. There is no prompt
 * here on purpose — a 48-account sweep cannot sit waiting on stdin — so such an
 * account is reported as `guard_required` and left for a targeted run.
 */

// Puts CLOUDFLARE_API_TOKEN into the environment so a `--remote` run authenticates
// with the deploy token instead of falling back to the OAuth session.
import './_cfenv.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { createRequire } from 'node:module';
// The one list of domains the code relay can actually read, so this report and
// /api/rent/steam-code cannot drift apart.
import { mailboxReadable } from '../src/lib/steamcode.js';

const require = createRequire(import.meta.url);
const SteamUser = require('steam-user');

const DB_NAME = 'fungaming-rentals';

/* ─── config ──────────────────────────────────── */

function parseArgs(argv) {
  const out = { remote: false, dryRun: false, noLogin: false, includeRented: false, fullEmails: false, limit: 10, timeout: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') out.remote = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-login') out.noLogin = true;
    else if (a === '--include-rented') out.includeRented = true;
    else if (a === '--full-emails') out.fullEmails = true;
    else if (a === '--relogin') out.relogin = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  out.limit = Math.max(Number(out.limit) || 10, 1);
  out.timeout = Math.max(Number(out.timeout) || 45, 10) * 1000;
  return out;
}

function fromDevVars(name) {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  if (start === -1) return [];
  const data = JSON.parse(out.slice(start));
  const block = Array.isArray(data) ? data[0] : data;
  return block?.results ?? [];
}

const sqlStr = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Every account, flagged with whether a customer is currently holding it. The
 * active order is the authority, not steam_accounts.status, which can lag.
 */
function loadAccounts(remote, only) {
  const filter = only ? ` WHERE lower(a.login) = lower(${sqlStr(only)})` : '';
  return d1(
    `SELECT a.id, a.login, a.email, a.password_enc, a.status, a.steam_id, a.ban_state,
            (SELECT COUNT(*) FROM orders o WHERE o.account_id = a.id AND o.status = 'active') AS live
       FROM steam_accounts a${filter}
      ORDER BY a.id`,
    remote
  );
}

function saveResult(id, { steamId, banState }, remote, ts) {
  const sets = [];
  // A null verdict means nothing answered this run. Writing it would erase a real
  // verdict an earlier login established — the one direction that must never
  // happen, since it puts a known-banned login back in the pool as "unknown".
  if (banState != null) {
    sets.push(`ban_state = ${sqlStr(banState)}`, `ban_checked_at = ${Number(ts)}`);
  }
  if (steamId) sets.push(`steam_id = ${sqlStr(steamId)}`);
  if (!sets.length) return;
  d1(`UPDATE steam_accounts SET ${sets.join(', ')} WHERE id = ${Number(id)}`, remote);
}

/* ─── decryption (mirrors decryptSecret in src/lib/rentals.js) ─── */

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function decryptSecret(payload, secret) {
  const [iv, ct] = String(payload || '').split('.');
  if (!iv || !ct) throw new Error('malformed ciphertext');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, key, fromB64url(ct));
  return new TextDecoder().decode(plain);
}

/* ─── public ban API ──────────────────────────── */

/**
 * GetPlayerBans for up to 100 steamIDs at once. Returns a Map keyed by steamID64.
 * Resolves to an empty Map on any failure — ban data is an enrichment here, and
 * losing it must not stop the sweep.
 */
async function fetchPlayerBans(steamIds, apiKey) {
  const found = new Map();
  if (!apiKey || !steamIds.length) return found;
  for (let i = 0; i < steamIds.length; i += 100) {
    const batch = steamIds.slice(i, i + 100);
    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/' +
      `?key=${encodeURIComponent(apiKey)}&steamids=${batch.join(',')}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  ! GetPlayerBans HTTP ${res.status} — continuing without public ban data`);
        continue;
      }
      const data = await res.json();
      for (const p of data.players || []) found.set(String(p.SteamId), p);
    } catch (e) {
      console.error(`  ! GetPlayerBans failed: ${e.message}`);
    }
  }
  return found;
}

/* ─── login probe ─────────────────────────────── */

/**
 * Logs in only far enough to read the account's own view of its standing, then
 * logs straight back off. Deliberately does NOT set a persona or call
 * gamesPlayed: this must disturb the account as little as possible.
 *
 * Resolves { ok, steamId, limitations, vacBans, vacApps, reason } and never rejects.
 */
function probeAccount(login, password, timeoutMs) {
  return new Promise((resolve) => {
    const client = new SteamUser({ autoRelogin: false });
    const out = {
    ok: false, steamId: null, limitations: null, vacBans: null, vacApps: null,
    email: null, emailValidated: null, reason: null,
  };
    let done = false;
    let sawLogin = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.logOff(); } catch { /* already gone */ }
      resolve(out);
    };

    // Both facts arrive as separate pushes after login. Give limitations a real
    // grace period once logged in — returning early is what made a verdict flip
    // between runs — and only shorten it once the push has actually landed.
    let grace = null;
    const settle = (ms) => {
      if (!out.steamId) return;
      if (grace) clearTimeout(grace);
      grace = setTimeout(finish, ms);
    };

    const timer = setTimeout(() => {
      out.reason = out.reason || (sawLogin ? 'timed out before Steam reported limitations' : 'login timed out');
      out.ok = Boolean(out.steamId);
      finish();
    }, timeoutMs);

    client.on('error', (err) => {
      const msg = err.message || String(err);
      // A Guard prompt means the PASSWORD was accepted; only the second factor is
      // missing. Worth distinguishing — it is not a bad credential.
      out.reason = /AccountLogonDenied|AccountLoginDeniedNeedTwoFactor|TwoFactor/i.test(msg)
        ? 'guard_required'
        : msg;
      finish();
    });

    // No code source is wired up here, so fail fast instead of hanging on stdin.
    client.on('steamGuard', () => {
      out.reason = 'guard_required';
      finish();
    });

    client.on('loggedOn', () => {
      sawLogin = true;
      out.steamId = client.steamID?.getSteamID64() ?? null;
      out.ok = true;
      // Short grace only: Steam may never send the limitations message, and the
      // steamID is the thing worth staying logged in for — bans come from the API
      // afterwards. Waiting 8s per account cost a 48-account sweep six minutes.
      settle(3000);
    });

    client.on('accountLimitations', (limited, communityBanned, locked, canInviteFriends) => {
      out.limitations = {
        limited: !!limited,
        communityBanned: !!communityBanned,
        locked: !!locked,
        canInviteFriends: !!canInviteFriends,
      };
      settle(1500);
    });

    client.on('vacBans', (numBans, appids) => {
      out.vacBans = numBans ?? 0;
      out.vacApps = (appids || []).join(', ') || null;
    });

    // The mailbox Steam itself believes the account has. Worth reading on the way
    // past: if it no longer matches the address in D1, somebody changed it, and
    // that is a takeover — which no ban source would ever report.
    //
    // Deliberately does NOT call settle(). That grace window exists for the
    // limitations push the verdict depends on, and shortening it for a field the
    // verdict does not use is how a verdict starts flipping between runs.
    client.on('emailInfo', (address, validated) => {
      out.email = address || null;
      out.emailValidated = validated == null ? null : Boolean(validated);
    });

    client.logOn({ accountName: login, password });
  });
}

/* ─── verdict ─────────────────────────────────── */

/** Worst-first list of what is wrong with an account, from both data sources. */
function banFlags({ limitations, vacBans, vacApps, publicBans }) {
  const flags = [];
  if (limitations?.locked) flags.push('LOCKED by Steam Support');
  if (limitations?.communityBanned || publicBans?.CommunityBanned) flags.push('COMMUNITY BANNED');
  const vac = vacBans ?? publicBans?.NumberOfVACBans ?? 0;
  if (vac) flags.push(`VAC ban x${vac}${vacApps ? ` (apps: ${vacApps})` : ''}`);
  if (publicBans?.NumberOfGameBans) flags.push(`${publicBans.NumberOfGameBans} game ban(s)`);
  const economy = publicBans?.EconomyBan;
  if (economy && economy !== 'none') flags.push(`TRADE ${String(economy).toUpperCase()}`);
  if (limitations?.limited) flags.push('limited account (no $5 purchase yet)');
  if (publicBans?.DaysSinceLastBan && (vac || publicBans?.NumberOfGameBans)) {
    flags.push(`last ban ${publicBans.DaysSinceLastBan}d ago`);
  }
  return flags;
}

/** A single word for the database, so the panel can filter on it later. */
function banState(flags, checked) {
  if (!checked) return 'unknown';
  if (!flags.length) return 'clean';
  const serious = flags.some((f) => /LOCKED|COMMUNITY BANNED|VAC|game ban|TRADE/.test(f));
  return serious ? 'banned' : 'restricted';
}

/* ─── main ────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
const where = args.remote ? 'REMOTE (production)' : 'local';
const encKey = conf('ACCOUNT_ENC_KEY');
const apiKey = conf('STEAM_API_KEY');

let accounts;
try {
  accounts = loadAccounts(args.remote, typeof args.login === 'string' ? args.login : null);
} catch (e) {
  console.error(`Failed to read the ${where} database: ${e.message}`);
  console.error('If this mentions steam_id, apply migrations/0007_account_steam_id.sql first.');
  process.exit(1);
}

if (!accounts.length) {
  console.log('No accounts found.');
  process.exit(0);
}

// A login is needed to discover an unknown steamID, and again — with --relogin —
// to re-read `locked`/`limited`, which no public endpoint exposes.
const wantLogin = accounts.filter((a) => !a.steam_id || args.relogin);
const liveHeld = wantLogin.filter((a) => a.live > 0);
const loginable = args.includeRented ? wantLogin : wantLogin.filter((a) => a.live === 0);
const loginSet = new Set(args.noLogin ? [] : loginable.slice(0, args.limit).map((a) => a.id));
// Everything with a steamID that this run is not logging into is checked over HTTP.
const known = accounts.filter((a) => a.steam_id && !loginSet.has(a.id));
const unknown = accounts.filter((a) => !a.steam_id);

console.log(
  `[db] ${where}: ${accounts.length} account(s) — ${known.length} with a known steamID, ` +
    `${unknown.length} without.`
);
if (!apiKey) {
  console.log(
    '[api] STEAM_API_KEY is unset, so BANS CANNOT BE DETECTED. Steam reports\n' +
      '      limited/locked over the login, but not reliably — kj1rt7ba4xt0 is\n' +
      '      community-banned and its login said nothing at all. Everything will be\n' +
      '      reported "unknown" rather than guessed at.\n' +
      '      Create a key at https://steamcommunity.com/dev/apikey and re-run.'
  );
}
if (liveHeld.length && !args.includeRented) {
  console.log(
    `[skip] ${liveHeld.length} unknown account(s) are rented right now and will not be\n` +
      '       logged into. Pass --include-rented to override, at the cost of possibly\n' +
      "       kicking a customer out of their game."
  );
}

// Phase 1 — free, login-free, and safe even mid-rental.
const publicBans = await fetchPlayerBans(known.map((a) => String(a.steam_id)), apiKey);

const results = [];
for (const a of known) {
  const p = publicBans.get(String(a.steam_id)) || null;
  const flags = banFlags({ publicBans: p });
  results.push({ account: a, steamId: a.steam_id, flags, checked: Boolean(p), source: p ? 'api' : 'cached-id only' });
}

// Phase 2 — log in to learn the steamIDs we do not have yet.
let logins = 0;
if (!args.noLogin && encKey) {
  for (const a of loginable) {
    if (!loginSet.has(a.id)) {
      console.log(`\n[limit] stopping after ${args.limit} login(s); re-run to continue.`);
      break;
    }
    logins++;
    let password;
    try {
      password = await decryptSecret(a.password_enc, encKey);
    } catch (e) {
      console.error(`  ! ${a.login}: decrypt failed (${e.message})`);
      results.push({ account: a, steamId: null, flags: [], checked: false, source: `decrypt failed` });
      continue;
    }
    const step = `  … logging into ${a.login} (${logins}/${Math.min(args.limit, loginable.length)})`;
    process.stdout.write(process.stdout.isTTY ? `${step}\r` : `${step}\n`);
    const probe = await probeAccount(a.login, password, args.timeout);
    if (!probe.ok) {
      results.push({ account: a, steamId: null, flags: [], checked: false, source: probe.reason || 'login failed' });
      continue;
    }
    const p = (await fetchPlayerBans([probe.steamId], apiKey)).get(String(probe.steamId)) || null;
    const flags = banFlags({ ...probe, publicBans: p });
    // Finding a problem is conclusive. Finding none is only conclusive if some
    // source actually answered: GetPlayerBans, or the limitations Steam may or may
    // not send. Without either, "clean" would be a guess dressed up as a result —
    // and that guess is the dangerous direction, since it puts a banned login back
    // in the rental pool.
    const conclusive = flags.length > 0 || p != null || probe.limitations != null;
    results.push({
      account: a,
      steamId: probe.steamId,
      flags,
      checked: conclusive,
      // Only a login can report these; the HTTP pass leaves them null.
      steamEmail: probe.email,
      steamEmailValidated: probe.emailValidated,
      source: p
        ? probe.limitations
          ? 'ban api + login'
          : 'ban api'
        : probe.limitations
          ? 'login only (no ban api key)'
          : 'steamID learned, but no ban source — set STEAM_API_KEY',
    });
  }
} else if (!encKey) {
  console.log('[key] ACCOUNT_ENC_KEY unset — cannot decrypt passwords, so no logins were attempted.');
}

for (const a of loginable.slice(logins)) {
  if (a.steam_id) continue; // already reported from the API pass
  results.push({ account: a, steamId: null, flags: [], checked: false, source: 'not checked yet' });
}
if (!args.includeRented) {
  for (const a of liveHeld) {
    if (a.steam_id) continue; // the API pass covered it without a login
    results.push({ account: a, steamId: null, flags: [], checked: false, source: 'skipped (live rental)' });
  }
}

/* ─── report ──────────────────────────────────── */

const ts = Math.floor(Date.now() / 1000);
// GetPlayerBans cannot see `locked` or `limited`, so an HTTP-only pass may make a
// verdict worse but must never clear one a login established — otherwise a cheap
// run silently downgrades a known-bad account to "clean".
const LOGIN_ONLY_VERDICT = new Set(['banned', 'restricted']);
const byState = { banned: [], restricted: [], clean: [], unknown: [] };
for (const r of results) {
  const fresh = banState(r.flags, r.checked);
  if (r.source === 'api' && fresh === 'clean' && LOGIN_ONLY_VERDICT.has(r.account.ban_state)) {
    r.state = r.account.ban_state;
    r.kept = true;
  } else {
    r.state = fresh;
  }
  byState[r.state].push(r);
  // A steamID is expensive — it costs a login and usually a Steam Guard email — so
  // it is saved even when no verdict was reached. Gating the write on `checked`
  // threw away the one thing the login was for, and made every re-run pay again.
  // The verdict itself is only written when something actually answered.
  if (!args.dryRun && (r.checked || r.steamId)) {
    try {
      saveResult(
        r.account.id,
        { steamId: r.steamId, banState: r.checked ? r.state : null },
        args.remote,
        ts
      );
    } catch (e) {
      console.error(`  ! could not save ${r.account.login}: ${e.message}`);
    }
  }
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`\n=== Ban check (${where}) ===`);
console.log(`  ${pad('LOGIN', 16)}${pad('STATE', 11)}${pad('STEAMID64', 19)}DETAIL`);
for (const state of ['banned', 'restricted', 'clean', 'unknown']) {
  for (const r of byState[state]) {
    const detail = r.kept
      ? 'kept from an earlier login (--relogin to re-check)'
      : r.flags.length
        ? r.flags.join('; ')
        : r.checked
          ? 'no bans'
          : r.source;
    const mark = state === 'banned' ? '!!' : state === 'restricted' ? ' !' : '  ';
    console.log(`${mark} ${pad(r.account.login, 16)}${pad(state, 11)}${pad(r.steamId || '—', 19)}${detail}`);
  }
}

console.log(
  `\nSummary: ${byState.banned.length} banned, ${byState.restricted.length} restricted, ` +
    `${byState.clean.length} clean, ${byState.unknown.length} unknown.` +
    (args.dryRun ? '  (dry run — nothing written)' : '')
);
/* ─── mailboxes ───────────────────────────────── */

// Reported beside the bans because the mailbox is what makes a rental account
// recoverable: Guard codes land there, and whoever holds it can reset the password
// and keep the account. Three things are worth knowing, and none of them is a ban:
// whether the address on Steam still matches the one on record, whether Steam has
// validated it, and whether the code relay can read it at all.
//
// Addresses are masked by default — this output gets pasted into chats — and
// `--full-emails` prints them whole for when you need to act on one.
function maskEmail(address) {
  if (!address) return '—';
  if (args.fullEmails) return address;
  const [local, domain] = String(address).split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(3, local.length - head.length))}@${domain}`;
}

const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const mailboxes = results.map((r) => {
  const stored = r.account.email || null;
  const onSteam = r.steamEmail || null;
  return {
    login: r.account.login,
    stored,
    onSteam,
    validated: r.steamEmailValidated ?? null,
    // Judged on the stored address, since that is the one the relay would query.
    readable: stored ? mailboxReadable(stored) : null,
    changed: Boolean(stored && onSteam && !same(stored, onSteam)),
  };
});

const changed = mailboxes.filter((m) => m.changed);
const unreadable = mailboxes.filter((m) => m.stored && !m.readable);
const unrecorded = mailboxes.filter((m) => !m.stored);
const unvalidated = mailboxes.filter((m) => m.validated === false);

console.log(`\n=== Mailboxes (${where}) ===`);
console.log(`   ${pad('LOGIN', 16)}${pad('EMAIL (D1)', 28)}${pad('STEAM SAYS', 28)}${pad('VALIDATED', 11)}RELAY`);
for (const m of mailboxes) {
  // Same marker column as the ban table above, so both scan the same way.
  const mark = m.changed ? '!!' : !m.stored || m.validated === false ? ' !' : '  ';
  const validated = m.validated == null ? '—' : m.validated ? 'yes' : 'NO';
  const relay = m.readable == null ? '—' : m.readable ? 'readable' : 'not readable';
  console.log(
    `${mark} ${pad(m.login, 16)}${pad(maskEmail(m.stored), 28)}${pad(m.onSteam ? maskEmail(m.onSteam) : '—', 28)}` +
      `${pad(validated, 11)}${relay}`
  );
}

console.log(
  `\nMailboxes: ${changed.length} changed on Steam, ${unreadable.length} the relay cannot read, ` +
    `${unrecorded.length} with no address on record, ${unvalidated.length} unvalidated.` +
    (args.fullEmails ? '' : '\n           (masked — pass --full-emails to print them in full)')
);
console.log(
  '           A "—" under STEAM SAYS just means this run did not log in, so only\n' +
    '           the stored address is known. --relogin re-checks those.'
);

if (changed.length) {
  console.log('\nCHANGED MAILBOX — Steam has an address the database does not. Somebody edited');
  console.log('the account, which is a takeover rather than a ban, and no ban source reports it:');
  for (const m of changed) {
    console.log(`  ${m.login}: on record ${maskEmail(m.stored)} → on Steam ${maskEmail(m.onSteam)}`);
  }
  console.log('  Rotate the password (scripts/steam_change_password.py) and keep them out of the');
  console.log('  pool until the mailbox is yours again — the holder of that address can reset it back.');
}

if (byState.banned.length) {
  const ids = byState.banned.map((r) => Number(r.account.id)).join(',');
  const live = byState.banned.filter((r) => r.account.live > 0);
  console.log('\nBanned accounts must not be rented out. To pull them from the pool:');
  console.log(
    `  npx wrangler d1 execute ${DB_NAME} ${args.remote ? '--remote' : '--local'} --command \\\n` +
      `    "UPDATE steam_accounts SET status='disabled' WHERE id IN (${ids})"`
  );
  // Never suggest yanking an account out from under someone mid-rental.
  if (live.length) {
    console.log(
      `\n  ${live.length} of them is rented RIGHT NOW (${live.map((r) => r.account.login).join(', ')}).\n` +
        '  Disabling does not end a live rental, but that customer is on a banned\n' +
        '  account — refund or replace them rather than waiting for it to lapse.'
    );
  }
}
// Non-zero for a ban OR a changed mailbox: both mean an account must not go back
// out, and a caller checking the exit status should hear about either.
process.exit(byState.banned.length || changed.length ? 1 : 0);
