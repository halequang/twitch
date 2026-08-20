/**
 * Email + password sign-up and sign-in, alongside the Google/Apple flow in
 * src/lib/auth.js.
 *
 * Three steps, deliberately not two:
 *   1. /api/auth/register  {email}            → mails a 6-digit code
 *   2. /api/auth/verify    {email, code}      → returns a short-lived claim token
 *   3. /api/auth/complete  {token, password}  → creates the user, signs them in
 *
 * The claim token exists so step 3 does not have to trust the browser about
 * which address was verified. It is an HMAC over the address under
 * SESSION_SECRET, so a client cannot mint one for an address it never proved.
 *
 * Codes are stored hashed. A database dump should not let anyone finish a sign-up
 * that is halfway through, and the code is short enough to be worth guessing —
 * hence the attempt ceiling as well.
 *
 * Password hashing is PBKDF2-HMAC-SHA256 via WebCrypto, because that is what the
 * Workers runtime offers: no bcrypt, scrypt or argon2. The iteration count is
 * stored inside each hash so it can be raised later without invalidating rows
 * written under the old one, and it is settable per environment because a Worker
 * on the free plan gets 10ms of CPU per request and a slow KDF would blow it.
 */

const encoder = new TextEncoder();

export const CODE_TTL_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODE_ATTEMPTS = 5;
export const CLAIM_TTL_SECONDS = 15 * 60;
export const MIN_PASSWORD_LENGTH = 8;
// OWASP would ask for far more; a Worker request on the free plan has ~10ms of
// CPU, so this is the compromise. Raise PASSWORD_KDF_ITERATIONS on a paid plan —
// old hashes keep working because each carries the count it was made with.
export const DEFAULT_KDF_ITERATIONS = 100_000;

const now = () => Math.floor(Date.now() / 1000);

/* ─── encoding helpers ────────────────────────── */

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(input) {
  const b64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text) {
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

/** Compares without leaking where two strings diverge. */
function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ─── email + password rules ──────────────────── */

// Deliberately loose. The code that gets delivered is the real proof an address
// exists; a clever regex only ever rejects valid unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function normaliseEmail(raw) {
  const email = String(raw ?? '').trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return { email, lower: email.toLowerCase() };
}

/** Returns null when acceptable, or a machine-readable reason. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (value.length > 200) return 'password_too_long';
  // Anything that survives being trimmed to nothing is whitespace pretending to
  // be a password.
  if (!value.trim()) return 'password_too_short';
  return null;
}

/* ─── password hashing ────────────────────────── */

function kdfIterations(env) {
  const configured = Number(env?.PASSWORD_KDF_ITERATIONS);
  if (Number.isFinite(configured) && configured >= 10_000) return Math.floor(configured);
  return DEFAULT_KDF_ITERATIONS;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, env) {
  const iterations = kdfIterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  try {
    const hash = await pbkdf2(password, b64urlToBytes(parts[3]), iterations);
    return timingSafeEqual(bytesToB64url(hash), parts[4]);
  } catch {
    return false;
  }
}

/* ─── verification codes ──────────────────────── */

/** Six digits, uniformly drawn — Math.random has no place near a credential. */
export function generateCode() {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

/* ─── claim token (step 2 → step 3) ───────────── */

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToB64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

export async function signClaim(emailLower, secret, ttl = CLAIM_TTL_SECONDS) {
  const body = bytesToB64url(encoder.encode(JSON.stringify({ e: emailLower, exp: now() + ttl })));
  return `${body}.${await hmac(secret, body)}`;
}

/** Returns the verified address, or null. */
export async function readClaim(token, secret) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload?.e || !payload?.exp || payload.exp < now()) return null;
    return payload.e;
  } catch {
    return null;
  }
}

/* ─── message ─────────────────────────────────── */

export function codeEmail(code) {
  return {
    subject: `${code} là mã xác minh FunGaming VN của bạn`,
    text: [
      'Xin chào,',
      '',
      `Mã xác minh để tạo tài khoản FunGaming VN của bạn là: ${code}`,
      '',
      `Mã có hiệu lực trong ${CODE_TTL_SECONDS / 60} phút.`,
      'Nếu bạn không yêu cầu tạo tài khoản, hãy bỏ qua email này.',
      '',
      'FunGaming VN',
    ].join('\n'),
    html: `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#0c0c0e;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;margin:0 auto;background:#141416;border:1px solid #2a2a2e;border-radius:6px;">
    <tr><td style="padding:26px 24px;text-align:center;">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#c8a44a;">FunGaming VN</p>
      <h1 style="margin:0 0 18px;font-size:18px;color:#f0e6cf;">Mã xác minh của bạn</h1>
      <p style="margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:.22em;color:#f0e6cf;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</p>
      <p style="margin:0 0 6px;font-size:13px;line-height:1.7;color:#a9a29a;">Mã có hiệu lực trong ${CODE_TTL_SECONDS / 60} phút.</p>
      <p style="margin:0;font-size:12px;line-height:1.7;color:#7d7770;">Nếu bạn không yêu cầu tạo tài khoản, hãy bỏ qua email này.</p>
    </td></tr>
  </table>
</body></html>`,
  };
}

/* ─── storage ─────────────────────────────────── */

export async function findUserByEmail(db, emailLower) {
  return db.prepare(`SELECT * FROM users WHERE email_lower = ?`).bind(emailLower).first();
}

/**
 * Records a freshly issued code, replacing any in flight for that address.
 * Returns { ok } or { ok: false, retryAfter } when still inside the cooldown.
 */
export async function storeCode(db, { email, lower, code, purpose = 'register' }) {
  const ts = now();
  const existing = await db
    .prepare(`SELECT sent_at FROM email_codes WHERE email_lower = ?`)
    .bind(lower)
    .first();
  if (existing && ts - existing.sent_at < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, retryAfter: RESEND_COOLDOWN_SECONDS - (ts - existing.sent_at) };
  }

  await db
    .prepare(
      `INSERT INTO email_codes (email_lower, email, code_hash, purpose, created_at, expires_at, sent_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (email_lower) DO UPDATE SET
         email = excluded.email, code_hash = excluded.code_hash, purpose = excluded.purpose,
         created_at = excluded.created_at, expires_at = excluded.expires_at,
         sent_at = excluded.sent_at, attempts = 0`
    )
    .bind(lower, email, await sha256(code), purpose, ts, ts + CODE_TTL_SECONDS, ts)
    .run();
  return { ok: true };
}

/**
 * Checks a submitted code. Returns a reason string on failure so the caller can
 * decide what to reveal; the attempt counter rises on every wrong guess and the
 * row is spent once accepted.
 */
export async function checkCode(db, lower, code) {
  const row = await db.prepare(`SELECT * FROM email_codes WHERE email_lower = ?`).bind(lower).first();
  if (!row) return { ok: false, reason: 'no_code' };
  if (row.expires_at < now()) return { ok: false, reason: 'code_expired' };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (!timingSafeEqual(await sha256(String(code ?? '')), row.code_hash)) {
    await db
      .prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email_lower = ?`)
      .bind(lower)
      .run();
    const left = MAX_CODE_ATTEMPTS - (row.attempts + 1);
    return { ok: false, reason: 'code_incorrect', attemptsLeft: Math.max(left, 0) };
  }
  return { ok: true, email: row.email };
}

export async function consumeCode(db, lower) {
  await db.prepare(`DELETE FROM email_codes WHERE email_lower = ?`).bind(lower).run();
}

export async function createUser(db, { email, lower, passwordHash, name }) {
  const ts = now();
  const row = await db
    .prepare(
      `INSERT INTO users (email, email_lower, password_hash, name, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(email, lower, passwordHash, name ?? null, ts, ts)
    .first();
  return row?.id ?? null;
}

export async function touchLogin(db, id) {
  await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now(), id).run();
}

/** The shape src/lib/auth.js puts in the session cookie. */
/**
 * Placeholder password for a row created by a provider sign-in.
 *
 * Safe by construction, not convention: verifyPassword() requires exactly
 * `pbkdf2$sha256$<iterations>$<salt>$<hash>` and bails on the format before
 * comparing anything, so a value with no '$' cannot authenticate whatever is typed.
 * Asserted in the tests, because that is the whole security argument.
 */
export const OAUTH_ONLY_PASSWORD = 'oauth-only';

/**
 * Records a successful Google / Apple sign-in in `users`.
 *
 * Keyed on the email, so a customer who signs in with Google and later sets a
 * password is one account rather than two — orders are attributed by user_email, and
 * splitting the identity would split their rental history.
 *
 * Never overwrites an existing password_hash: someone who already has a password
 * keeps it after signing in with Google.
 *
 * Returns the row id, or null when there is nothing to record (no database bound, or
 * a provider that gave us no email — Apple private relay can withhold it, and the
 * email column is the key here).
 */
export async function recordOauthLogin(db, { provider, sub, email, name, picture }) {
  if (!db || !email) return null;
  // normaliseEmail returns {email, lower} — and null for anything malformed, which
  // doubles as validation: a provider address we cannot parse is not stored.
  const parsed = normaliseEmail(email);
  if (!parsed) return null;
  const ts = Math.floor(Date.now() / 1000);

  const row = await db
    .prepare(
      `INSERT INTO users
         (email, email_lower, password_hash, name, picture, provider, provider_sub,
          created_at, last_login_at, login_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (email_lower) DO UPDATE SET
         last_login_at = excluded.last_login_at,
         login_count   = users.login_count + 1,
         provider      = excluded.provider,
         provider_sub  = excluded.provider_sub,
         -- Only fill these in; a name the customer set themselves should not be
         -- replaced by whatever the provider currently returns.
         name          = COALESCE(users.name, excluded.name),
         picture       = COALESCE(excluded.picture, users.picture)
       RETURNING id`
    )
    .bind(parsed.email, parsed.lower, OAUTH_ONLY_PASSWORD, name ?? null, picture ?? null,
          provider, sub ?? null, ts, ts)
    .first();
  return row?.id ?? null;
}

export function sessionUser(row) {
  return {
    provider: 'email',
    sub: String(row.id),
    email: row.email,
    name: row.name || row.email.split('@')[0] || 'Exile',
    picture: null,
  };
}
