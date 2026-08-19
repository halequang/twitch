/**
 * Renter-side problem reports: "someone else is logged into my account", "I can't
 * log in", and so on. Shared by the Cloudflare Worker and the Astro dev
 * middleware, same split as src/lib/rentals.js.
 *
 * The admin side (listing and resolving) lives in src/lib/admin.js, where the
 * group-scoping helper is, so a manager only ever sees reports about their own
 * accounts.
 *
 * Why a table and not just a Telegram ping: an intruder report is the one signal
 * that means a previous renter kept the password, and it must not be lost because
 * nobody happened to read a chat message. The row stays until someone resolves it;
 * the notification is best-effort on top.
 */

import { telegramConfigured, sendReportNotice } from './notify.js';

/** Renter-facing reasons. Keys are stored; labels are shown on the page. */
export const REPORT_REASONS = {
  intruder: 'Có người khác đăng nhập vào tài khoản',
  cannot_login: 'Không đăng nhập được',
  wrong_password: 'Mật khẩu không đúng',
  guard_code: 'Bị hỏi mã Steam Guard',
  banned: 'Tài khoản bị khoá / ban',
  other: 'Vấn đề khác',
};

/** Reasons that mean the account is compromised, not merely inconvenient. */
export const URGENT_REASONS = new Set(['intruder', 'wrong_password']);

const now = () => Math.floor(Date.now() / 1000);

// A renter may only report after their rental lapses — an intrusion is often
// noticed late — but not indefinitely, or old orders become a spam surface.
const REPORTABLE_AFTER_EXPIRY = 48 * 3600;

const MAX_MESSAGE = 600;

/** Trim, strip control characters, cap length. Mirrors cleanText in admin.js. */
function cleanText(value, max = MAX_MESSAGE) {
  if (typeof value !== 'string') return null;
  const clean = Array.from(value)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 31 || c === 10 || c === 9; // keep newlines and tabs
    })
    .join('')
    .trim();
  return clean ? clean.slice(0, max) : null;
}

export function reportPaths(path) {
  return path === '/api/rent/report';
}

/**
 * Records a report against the caller's own rental.
 *
 * Ownership is checked against user_key rather than the order code alone, so a
 * customer cannot report — or reveal the existence of — somebody else's rental.
 *
 * @returns {{ status: number, body: object }}
 */
export async function submitReport(env, user, { orderCode, reason, message }) {
  const db = env?.DB;
  if (!db) return { status: 503, body: { error: 'rentals_not_configured' } };

  const key = `${user.provider}:${user.sub}`;
  if (!REPORT_REASONS[reason]) {
    return { status: 400, body: { error: 'unknown_reason', reasons: Object.keys(REPORT_REASONS) } };
  }

  const code = Number(orderCode);
  if (!Number.isFinite(code)) return { status: 400, body: { error: 'unknown_order' } };

  // The login comes along for the notice: an intruder report is actionable only
  // if it names the account whose password has to be rotated.
  const order = await db
    .prepare(
      `SELECT o.order_code, o.user_key, o.user_email, o.account_id, o.status, o.expires_at,
              a.login AS account_login
         FROM orders o
         LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.order_code = ?`
    )
    .bind(code)
    .first();

  // Same 404 for "no such order" and "not yours", so this cannot be used to probe
  // which order codes exist.
  if (!order || order.user_key !== key) return { status: 404, body: { error: 'unknown_order' } };

  const ts = now();
  const lapsedTooLongAgo =
    order.status !== 'active' && (order.expires_at ?? 0) + REPORTABLE_AFTER_EXPIRY < ts;
  if (order.status === 'pending' || lapsedTooLongAgo) {
    return { status: 409, body: { error: 'not_reportable', status: order.status } };
  }

  const text = cleanText(message);
  // "Other" without a description gives the owner nothing to act on.
  if (reason === 'other' && !text) return { status: 400, body: { error: 'message_required' } };

  // An impatient renter pressing the button twice must not produce two tickets.
  const open = await db
    .prepare(`SELECT id FROM account_reports WHERE order_code = ? AND status = 'open'`)
    .bind(code)
    .first();

  let id;
  if (open) {
    await db
      .prepare(`UPDATE account_reports SET reason = ?, message = ?, updated_at = ? WHERE id = ?`)
      .bind(reason, text, ts, open.id)
      .run();
    id = open.id;
  } else {
    const row = await db
      .prepare(
        `INSERT INTO account_reports
           (order_code, account_id, user_key, user_email, reason, message, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
         RETURNING id`
      )
      .bind(code, order.account_id ?? null, key, order.user_email ?? null, reason, text, ts, ts)
      .first();
    id = row?.id ?? null;
  }

  // Best-effort push on top of the row. A failed send must not lose the report or
  // make the renter think their report did not go through.
  let notified = false;
  if (telegramConfigured(env)) {
    try {
      notified = await sendReportNotice(env, {
        reason,
        label: REPORT_REASONS[reason],
        urgent: URGENT_REASONS.has(reason),
        message: text,
        orderCode: code,
        userEmail: order.user_email ?? null,
        accountId: order.account_id ?? null,
        accountLogin: order.account_login ?? null,
      });
    } catch {
      notified = false;
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      id,
      updated: Boolean(open),
      urgent: URGENT_REASONS.has(reason),
      notified,
    },
  };
}

/** The renter's own reports, so the page can show "we have this open". */
export async function listOwnReports(env, user) {
  const db = env?.DB;
  if (!db) return [];
  const key = `${user.provider}:${user.sub}`;
  const rows = await db
    .prepare(
      `SELECT id, order_code, reason, message, status, created_at, resolved_at, resolution
         FROM account_reports WHERE user_key = ? ORDER BY created_at DESC LIMIT 20`
    )
    .bind(key)
    .all();
  return (rows?.results ?? []).map((r) => ({
    id: r.id,
    orderCode: r.order_code,
    reason: r.reason,
    reasonLabel: REPORT_REASONS[r.reason] || r.reason,
    message: r.message ?? null,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
    resolution: r.resolution ?? null,
  }));
}
