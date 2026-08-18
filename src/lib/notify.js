/**
 * Tells the shop owner when a rental has ended.
 *
 * Why this exists: expiry is otherwise only noticed lazily, when a customer
 * happens to load /game and sweepExpired() runs. A rental could end at 3am and
 * nobody would know. The Worker's scheduled() handler calls this on a cron so
 * detection does not depend on traffic.
 *
 * The message matters more than the mechanism: once a rental ends the previous
 * renter STILL KNOWS that Steam password, so the account must not go back out
 * until it is rotated (scripts/steam_change_password.py --db).
 *
 * Channel is Telegram — the shop already runs on @fungamingvnbot.
 *   TELEGRAM_BOT_TOKEN  from @BotFather
 *   TELEGRAM_CHAT_ID    the owner's chat/group id
 *
 * With those unset nothing is sent and nothing is marked, so switching the vars
 * on later still announces whatever is outstanding rather than losing it.
 */

const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';

// Overridable so a local stub can stand in for Telegram during testing.
const telegramApi = (env) => env?.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API;

export function telegramConfigured(env) {
  return Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID);
}

function fmtDate(seconds) {
  if (!seconds) return '—';
  // Asia/Ho_Chi_Minh — the shop reads these, not a server.
  return new Date(seconds * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/** Telegram MarkdownV2 is fussy; plain text with HTML escaping is safer. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildExpiryMessage(rows) {
  const lines = ['⏰ <b>Hết hạn thuê</b>', ''];
  for (const row of rows) {
    lines.push(
      `• Đơn <code>${escapeHtml(row.order_code)}</code> — ${escapeHtml(row.plan_id)} (${row.hours}h)`,
      `  Khách: ${escapeHtml(row.user_email || row.user_key)}`,
      `  Tài khoản: <code>${escapeHtml(row.account_login || '(đã xoá)')}</code>`,
      `  Hết hạn: ${escapeHtml(fmtDate(row.expires_at))}`,
      ''
    );
  }
  lines.push(
    '⚠️ <b>Đổi mật khẩu Steam trước khi cho thuê lại</b> — khách cũ vẫn biết mật khẩu hiện tại.',
    '',
    'Chạy: <code>python scripts/steam_change_password.py --db --remote</code>'
  );
  return lines.join('\n');
}

async function sendTelegram(env, text) {
  const res = await fetch(`${telegramApi(env)}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`telegram_failed: ${json?.description || `http_${res.status}`}`);
  }
  return json;
}

/**
 * Rentals that have ended but not yet been announced.
 * Read-only — safe to call from the admin panel too.
 */
export async function pendingExpiryNotices(env, limit = 20) {
  const rows = await env.DB.prepare(
    `SELECT o.order_code, o.user_key, o.user_email, o.plan_id, o.hours, o.expires_at,
            a.login AS account_login
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
      WHERE o.status = 'expired' AND o.notified_at IS NULL
      ORDER BY o.expires_at DESC
      LIMIT ?`
  )
    .bind(Math.min(Number(limit) || 20, 100))
    .all();
  return rows?.results ?? [];
}

/**
 * Finds newly ended rentals, announces them, and marks them so the next cron
 * run stays quiet.
 *
 * Marking happens ONLY after a successful send — a failed Telegram call leaves
 * the rows outstanding so the next run retries instead of silently losing them.
 *
 * @returns {{ found: number, sent: number, skipped?: string }}
 */
export async function notifyExpiredRentals(env) {
  const rows = await pendingExpiryNotices(env);
  if (!rows.length) return { found: 0, sent: 0 };

  if (!telegramConfigured(env)) {
    // Left unmarked on purpose: configure the vars later and these still go out.
    console.warn(
      `${rows.length} ended rental(s) to announce, but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset`
    );
    return { found: rows.length, sent: 0, skipped: 'telegram_not_configured' };
  }

  await sendTelegram(env, buildExpiryMessage(rows));

  const ts = Math.floor(Date.now() / 1000);
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(`UPDATE orders SET notified_at = ? WHERE order_code = ?`).bind(ts, row.order_code)
    )
  );

  return { found: rows.length, sent: rows.length };
}
