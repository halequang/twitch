/**
 * Sending mail from the Worker, via Resend.
 *
 * scripts/send-expiry-reminders.mjs talks to the same API but is a different
 * shape of job — an operator-run BCC blast. This is the transactional path: one
 * message, to one person, triggered by something they just did.
 *
 * Env:
 *   RESEND_API_KEY  required; without it sending is reported as unconfigured
 *                   rather than silently succeeding
 *   RESEND_FROM     e.g. "FunGaming VN <no-reply@fungamingvn.shop>" — the domain
 *                   must be verified in Resend or the API answers 403
 *   RESEND_REPLY_TO optional
 *   RESEND_API_BASE optional, for pointing tests at a stub
 */

export function mailerConfigured(env) {
  return Boolean(env?.RESEND_API_KEY && env?.RESEND_FROM);
}

/**
 * Sends one email. Resolves { ok, id } or { ok: false, reason }.
 * Never throws: a caller deciding what to tell the user should not have to wrap
 * this in a try/catch, and a mail failure must not read as a server crash.
 */
export async function sendMail(env, { to, subject, text, html, idempotencyKey }) {
  if (!mailerConfigured(env)) return { ok: false, reason: 'mail_not_configured' };

  const base = String(env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const payload = { from: env.RESEND_FROM, to: [to], subject, text };
  if (html) payload.html = html;
  if (env.RESEND_REPLY_TO) payload.reply_to = env.RESEND_REPLY_TO;

  const headers = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  // Resend honours this for 24h, so a retry of the same send cannot produce a
  // second copy in someone's inbox.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      let reason = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body);
        reason = parsed.message || parsed.error?.message || reason;
      } catch {
        /* keep the raw text */
      }
      return { ok: false, reason: `resend_${res.status}: ${reason}` };
    }
    let id = null;
    try {
      id = JSON.parse(body).id ?? null;
    } catch {
      /* id is only for logging */
    }
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: `resend_unreachable: ${err.message}` };
  }
}
