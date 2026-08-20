/**
 * Hands a renter the Steam Guard code for the account they are renting, so they can
 * sign in without the shop relaying it by hand.
 *
 * The danger, and the reason this file is careful: Steam emails a code for *both*
 * signing in and changing login credentials, from the same address with the same
 * subject ("Steam Account Verification"). Only the body distinguishes them. Handing
 * over the wrong one is not a leak, it is an account transfer — the holder can change
 * the password and keep the account.
 *
 * Worse, the mailboxes in this shop mostly contain credential-change codes, because
 * scripts/steam_change_password.py generates them during rotation. So "return the
 * newest code" would frequently return precisely the wrong one.
 *
 * Hence classifyCode(): a positive allowlist for login wording, a denylist for
 * credential-change wording, and refusal for anything unrecognised. Fail closed —
 * a renter told to contact support is a support ticket; a renter handed a
 * credential-change code is a stolen account.
 */

const MAIL_API_URL = 'https://poe-mail.fungamingvn.workers.dev/api/read-code';

// The endpoint reads mailboxes over Microsoft Graph, so nothing else can be served.
const READABLE_MAIL_DOMAINS = ['outlook.com', 'hotmail.com'];

// One code per minute per rental, and a ceiling per rental. A renter needs a code
// once or twice; a hundred requests is somebody working on the account, not playing.
export const CODE_COOLDOWN_SECONDS = 60;
export const CODE_MAX_PER_RENTAL = 10;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Wording that means "this code changes the account", verified against real emails
 * in this shop's own mailboxes:
 *   "Here is the code you need to change your Steam login credentials: 89RXY"
 */
const CREDENTIAL_CHANGE_PATTERNS = [
  /change your steam login credentials/i,
  /change your (?:password|email|login)/i,
  /reset your password/i,
  /remove steam guard/i,
  /recover(?:ing)? your account/i,
];

/**
 * Wording that means "this code lets you sign in". Steam's login mail reads
 * "Here is the Steam Guard code you need to login to account <name>".
 *
 * This half is not verified against a captured sample: the mailboxes held no login
 * code when this was written, because the accounts were not being signed into from
 * new devices. If the wording differs, the outcome is a refusal — safe, and
 * visible in steam_code_requests as refused_purpose.
 */
const LOGIN_PATTERNS = [
  /steam guard code/i,
  /code you need to (?:log ?in|login|sign ?in)/i,
  /use this code to (?:log ?in|login|sign ?in)/i,
];

/**
 * Decides whether a code may be handed over.
 * @returns {'login' | 'credential_change' | 'unknown'}
 */
export function classifyCode(body) {
  const text = String(body ?? '');
  // Denylist first: if an email somehow matches both, the dangerous reading wins.
  if (CREDENTIAL_CHANGE_PATTERNS.some((re) => re.test(text))) return 'credential_change';
  if (LOGIN_PATTERNS.some((re) => re.test(text))) return 'login';
  return 'unknown';
}

export function mailboxReadable(email) {
  const domain = String(email ?? '').trim().toLowerCase().split('@').pop();
  return READABLE_MAIL_DOMAINS.includes(domain);
}

export function steamCodeConfigured(env) {
  return Boolean(env?.MAIL_API_KEY);
}

async function fetchMailboxCodes(env, email) {
  const res = await fetch(env.MAIL_API_BASE || MAIL_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.MAIL_API_KEY,
      // Cloudflare's bot protection answers 1010 to an unfamiliar agent before the
      // request reaches the Worker at all.
      'user-agent': 'fungaming-shop/1.0',
      accept: 'application/json',
    },
    // `full` rather than `code`: the plain mode returns a bare code with no body, and
    // without the body there is no way to tell a login code from a takeover.
    body: JSON.stringify({ email, refreshToken: '', clientId: '', mode: 'full', numEmails: 5 }),
  });
  if (!res.ok) throw new Error(`mail_api_http_${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.emails) ? data.emails : [];
}

async function logRequest(db, { orderCode, accountId, userKey, userEmail, outcome }) {
  try {
    await db
      .prepare(
        `INSERT INTO steam_code_requests
           (order_code, account_id, user_key, user_email, outcome, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(orderCode, accountId ?? null, userKey, userEmail ?? null, outcome, now())
      .run();
  } catch (err) {
    // An unlogged hand-over is worse than a failed one, so this is loud.
    console.error('could not log steam code request:', err?.message || err);
  }
}

/**
 * Serves the Steam Guard code for the caller's own live rental.
 *
 * @returns {{ status: number, body: object }}
 */
export async function requestSteamCode(env, user, orderCode) {
  const db = env?.DB;
  if (!db) return { status: 503, body: { error: 'rentals_not_configured' } };
  if (!steamCodeConfigured(env)) {
    return { status: 503, body: { error: 'code_service_unconfigured' } };
  }

  const key = `${user.provider}:${user.sub}`;
  const code = Number(orderCode);
  if (!Number.isFinite(code)) return { status: 404, body: { error: 'unknown_order' } };

  const order = await db
    .prepare(
      `SELECT o.order_code, o.user_key, o.user_email, o.status, o.expires_at,
              a.id AS account_id, a.login, a.email
         FROM orders o
         LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.order_code = ?`
    )
    .bind(code)
    .first();

  // Same answer for "no such order" and "not yours", so this cannot enumerate orders.
  if (!order || order.user_key !== key) return { status: 404, body: { error: 'unknown_order' } };

  // Only while the rental is live. A lapsed rental means the password is about to be
  // rotated, and a code then would be a code into somebody else's account.
  if (order.status !== 'active' || (order.expires_at ?? 0) <= now()) {
    return { status: 409, body: { error: 'rental_not_active', status: order.status } };
  }
  if (order.account_id == null) return { status: 409, body: { error: 'no_account_yet' } };

  const audit = {
    orderCode: code,
    accountId: order.account_id,
    userKey: key,
    userEmail: order.user_email ?? null,
  };

  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(MAX(requested_at), 0) AS last_at
         FROM steam_code_requests WHERE order_code = ?`
    )
    .bind(code)
    .first();

  const sinceLast = now() - Number(recent?.last_at ?? 0);
  if (Number(recent?.last_at ?? 0) && sinceLast < CODE_COOLDOWN_SECONDS) {
    await logRequest(db, { ...audit, outcome: 'rate_limited' });
    return {
      status: 429,
      body: { error: 'too_soon', retryAfter: CODE_COOLDOWN_SECONDS - sinceLast },
    };
  }
  if (Number(recent?.total ?? 0) >= CODE_MAX_PER_RENTAL) {
    await logRequest(db, { ...audit, outcome: 'rate_limited' });
    return { status: 429, body: { error: 'limit_reached', limit: CODE_MAX_PER_RENTAL } };
  }

  if (!mailboxReadable(order.email)) {
    await logRequest(db, { ...audit, outcome: 'unreadable_mailbox' });
    return { status: 409, body: { error: 'mailbox_not_readable' } };
  }

  let emails;
  try {
    emails = await fetchMailboxCodes(env, order.email);
  } catch (err) {
    await logRequest(db, { ...audit, outcome: 'error' });
    console.error('steam code fetch failed:', err?.message || err);
    return { status: 502, body: { error: 'mail_unavailable' } };
  }

  const withCode = emails.filter((m) => m?.code);
  if (!withCode.length) {
    await logRequest(db, { ...audit, outcome: 'no_code' });
    return { status: 404, body: { error: 'no_code_yet' } };
  }

  // Newest first, as the endpoint returns them. Only the newest is considered: an
  // older login code has almost certainly expired, and reaching further back is how
  // a stale code gets served.
  const newest = withCode[0];
  const purpose = classifyCode(`${newest.readable ?? ''}\n${newest.subject ?? ''}`);
  if (purpose !== 'login') {
    await logRequest(db, { ...audit, outcome: 'refused_purpose' });
    return {
      status: 409,
      body: {
        error: 'code_not_for_login',
        // Named so a renter knows this is deliberate, without describing what the
        // code would have done.
        purpose,
      },
    };
  }

  await logRequest(db, { ...audit, outcome: 'served' });
  return {
    status: 200,
    body: {
      code: newest.code,
      // The mailbox address is deliberately not returned: handing it over would let
      // a renter reset the password directly.
      login: order.login,
      cooldownSeconds: CODE_COOLDOWN_SECONDS,
      remaining: Math.max(0, CODE_MAX_PER_RENTAL - Number(recent?.total ?? 0) - 1),
    },
  };
}
