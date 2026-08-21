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
export const CODE_COOLDOWN_SECONDS = 45;
export const CODE_MAX_PER_RENTAL = 10;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Wording that means "this code changes the account". The first two are verbatim from
 * this shop's own mailboxes:
 *   "Here is the code you need to change your Steam login credentials: 89RXY"
 *   "Here's the confirmation code that you need to update your email address: H84G2"
 *
 * The second one is why this list is written from captured mail rather than from
 * imagination: "update your email address" does not contain the word change, and an
 * earlier version of this list missed it entirely. It only failed safe because
 * anything unrecognised is refused.
 *
 * Steam localises these, so the Chinese equivalents are here too. Those are not
 * captured samples — no Chinese change-mail has appeared yet — but a denylist entry
 * that never matches costs nothing, whereas a missing one costs an account.
 */
const CREDENTIAL_CHANGE_PATTERNS = [
  /change your steam login credentials/i,
  /change your (?:password|email|login)/i,
  /update your email address/i,
  /reset your password/i,
  /remove steam guard/i,
  /recover(?:ing)? your account/i,
  // zh: 更改/修改/重置 … 密码 | 登录凭据 | 电子邮件/邮箱
  /(?:更改|修改|重置|变更)[^。\n]{0,20}(?:密[码碼]|登录凭据|登入憑據)/,
  /(?:更改|修改|更新|变更)[^。\n]{0,20}(?:电子邮件|電子郵件|邮箱|郵箱|邮件地址)/,
  /(?:移除|删除|移除掉)[^。\n]{0,20}Steam\s*(?:令牌|驗證器|验证器)/,
  /(?:找回|恢复|恢復)[^。\n]{0,10}(?:帐户|帳戶|账户)/,
  // vi: this pool is Vietnamese-facing, so these come before the Vietnamese login
  // patterns below — a login entry in a language with no denylist entry is the one
  // mistake that hands over a credential-change code.
  /thay [đd][ổo]i[^.\n]{0,40}(?:m[ậa]t kh[ẩa]u|th[ôo]ng tin [đd][ăa]ng nh[ậa]p|email|[đd][ịi]a ch[ỉi] email)/i,
  /[đd][ặa]t l[ạa]i[^.\n]{0,30}m[ậa]t kh[ẩa]u/i,
  /c[ậa]p nh[ậa]t[^.\n]{0,40}(?:email|[đd][ịi]a ch[ỉi] email)/i,
  /(?:x[óo]a|g[ỡo] b[ỏo]|lo[ạa]i b[ỏo])[^.\n]{0,30}steam\s*guard/i,
  /kh[ôo]i ph[ụu]c[^.\n]{0,30}t[àa]i kho[ảa]n/i,
];

/**
 * Wording that means "this code lets you sign in" — the only kind handed over.
 *
 * The Chinese entries are verbatim from a real login mail on this pool, which is
 * mostly Chinese-locale:
 *   "看起来您正在尝试使用新设备登录。此处是您访问帐户所需的 Steam 令牌验证码：… V9MN7"
 *
 * Kept deliberately narrow, anchored on phrases that only make sense for a sign-in
 * ("using a new device", "token verification code"). A loose pattern here is the
 * one mistake that matters: it would let a credential-change mail through in a
 * language whose denylist entry is missing.
 */
const LOGIN_PATTERNS = [
  /steam guard code/i,
  /code you need to (?:log ?in|login|sign ?in)/i,
  /use this code to (?:log ?in|login|sign ?in)/i,
  /(?:logging|log|sign) ?in(?:g)? (?:with|from|using) a new device/i,
  // zh: 使用新设备登录 — only a sign-in mail says this.
  /使用新[设設][备備]登[录錄]/,
  // zh: Steam 令牌验证码 — the login token code, as opposed to a change confirmation.
  /Steam\s*令牌[验驗][证證]码?/,
  /[访訪][问問]帐[户戶]所需/,
  /[访訪][问問][账帳][户戶]所需/,
  // vi, verbatim from this pool's own mail:
  //   "Có vẻ như bạn đang cố đăng nhập từ một thiết bị mới. Mã Steam Guard bạn cần
  //    để đăng nhập vào tài khoản: … GFTM8"
  // Vietnamese puts the noun first, so "Mã Steam Guard" never matched the English
  // /steam guard code/ and every one of these mails was refused as unknown.
  /m[ãa]\s*steam\s*guard/i,
  /[đd][ăa]ng nh[ậa]p t[ừu] (?:m[ộo]t )?thi[ếe]t b[ịi] m[ớo]i/i,
  /[đd][ểe] [đd][ăa]ng nh[ậa]p v[àa]o t[àa]i kho[ảa]n/i,
];

/**
 * Sentences that give advice rather than state the email's purpose.
 *
 * These must be removed before classifying. A real login mail on this pool ends with
 * "如果这不是您尝试登录，建议您重置自己的 Steam 密码。" — "if this wasn't you, reset
 * your password" — and matching that as intent refused every genuine login code. The
 * English change mail mirrors it ("If you are not trying to change..."), so stripping
 * advice helps both directions: what is left is what the mail is *for*.
 */
const ADVISORY_SENTENCE = [
  // zh: conditionals and cautions
  /^\s*(?:如果|若|倘若|建议|不是您|切勿|请勿|您会收到)/,
  // en
  /^\s*if\b/i,
  /if (?:you are|this was ?n[o']?t|it was ?n[o']?t)/i,
  /you are receiving this/i,
  /please ignore/i,
  /(?:never|do not|don't) share/i,
  // vi: "Nếu đây không phải là bạn…", "Vui lòng bỏ qua…", "Không chia sẻ mã này…"
  /^\s*(?:n[ếe]u|vui l[òo]ng|[đd][ừu]ng|kh[ôo]ng chia s[ẻe]|b[ạa]n nh[ậa]n [đd][ưu][ợo]c)/i,
];

/** Splits into sentences on both Latin and CJK terminators, plus line breaks. */
function sentences(text) {
  return String(text ?? '')
    .split(/[\n\r]+|(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Decides whether a code may be handed over.
 *
 * Classified on the purpose sentences only — advice is stripped first, because
 * Steam's login mail advises resetting the password and its change mail advises
 * ignoring the message, so the advice describes the opposite of the intent as often
 * as not.
 *
 * @returns {'login' | 'credential_change' | 'unknown'}
 */
export function classifyCode(body) {
  const purpose = sentences(body)
    .filter((line) => !ADVISORY_SENTENCE.some((re) => re.test(line)))
    .join('\n');

  // Denylist still first, but now against intent rather than against the footer: an
  // email that *states* it changes credentials is refused even if it also mentions
  // signing in.
  if (CREDENTIAL_CHANGE_PATTERNS.some((re) => re.test(purpose))) return 'credential_change';
  if (LOGIN_PATTERNS.some((re) => re.test(purpose))) return 'login';
  return 'unknown';
}

/**
 * Whether this account is marked as using email Steam Guard.
 *
 * Most accounts do not ask for a code at all, and offering the button on those
 * invites confused renters to request codes that will never arrive. The marker is
 * the word "guard" in either note field — internal_note in practice, which is where
 * the existing one lives and where it belongs, since `note` is printed to the renter.
 *
 * Word-boundary matched because these fields hold space-separated tags
 * ("day 2", "red_flag", "80k 1 tuan"), so "guard" is one token among others and a
 * substring test would also fire on something like "guardian".
 */
/**
 * How many of the newest mails are considered.
 *
 * Two, not one: this pool has one mailbox behind 28 accounts, so an unrelated Steam
 * mail can land between the renter triggering a login and pressing the button,
 * burying the code they need under one they cannot use.
 *
 * And two, not five: the further back this reaches, the likelier the code has
 * expired or belongs to somebody else's attempt entirely — either way the renter
 * burns an attempt on a code Steam rejects.
 */
export const CODE_SCAN_DEPTH = 2;

/**
 * Chooses which mail's code to hand over.
 *
 * Returns { mail, depth } for the newest mail that is a login code, where depth 0 is
 * the newest of all. A credential-change mail is never chosen — it is skipped past,
 * not served — so looking deeper cannot turn a refusal into a takeover.
 *
 * With nothing eligible, `mail` is null and `purpose` describes the NEWEST mail,
 * since that is the one the renter's own action most likely produced.
 */
export function pickLoginCode(emails, depth = CODE_SCAN_DEPTH) {
  const withCode = (Array.isArray(emails) ? emails : []).filter((m) => m?.code);
  const scanned = withCode.slice(0, Math.max(1, depth)).map((mail) => ({
    mail,
    purpose: classifyCode(`${mail.readable ?? ''}\n${mail.subject ?? ''}`),
  }));
  const at = scanned.findIndex((c) => c.purpose === 'login');
  if (at === -1) {
    return { mail: null, depth: -1, purpose: scanned[0]?.purpose ?? 'unknown', scanned: scanned.length };
  }
  return { mail: scanned[at].mail, depth: at, purpose: 'login', scanned: scanned.length };
}

export function hasGuardFlag(note, internalNote) {
  return /(^|\s)guard(\s|$)/i.test(`${note ?? ''} ${internalNote ?? ''}`.trim());
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
              a.id AS account_id, a.login, a.email, a.note, a.internal_note
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
  //
  // Reported as three distinct cases. Collapsing them produced
  // {"error":"rental_not_active","status":"active"} — a contradiction that sends
  // whoever reads it looking at the wrong thing, when the actual fault was a row
  // with no expiry at all.
  const audit = {
    orderCode: code,
    accountId: order.account_id,
    userKey: key,
    userEmail: order.user_email ?? null,
  };

  if (order.status !== 'active') {
    await logRequest(db, { ...audit, outcome: 'rental_not_active' });
    return { status: 409, body: { error: 'rental_not_active', status: order.status } };
  }
  if (order.expires_at == null) {
    // Not the renter's problem: an active rental with no end date never went
    // through fulfilOrder, which always stamps one. Logged because it is a data
    // fault somebody has to fix, and an unlogged one is a fault nobody sees.
    await logRequest(db, { ...audit, outcome: 'rental_has_no_expiry' });
    return { status: 409, body: { error: 'rental_has_no_expiry' } };
  }
  if (order.expires_at <= now()) {
    await logRequest(db, { ...audit, outcome: 'rental_expired' });
    return { status: 409, body: { error: 'rental_expired', expiresAt: order.expires_at } };
  }
  if (order.account_id == null) {
    await logRequest(db, { ...audit, outcome: 'no_account_yet' });
    return { status: 409, body: { error: 'no_account_yet' } };
  }

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

  // Checked here and not only in the page: the button is a hint, this is the rule.
  // Reading a mailbox is the sensitive act, so it does not happen for an account
  // nobody marked as needing it.
  if (!hasGuardFlag(order.note, order.internal_note)) {
    await logRequest(db, { ...audit, outcome: 'not_guard_account' });
    return { status: 409, body: { error: 'not_guard_account' } };
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

  // Newest first, as the endpoint returns them.
  const picked = pickLoginCode(withCode);
  if (!picked.mail) {
    await logRequest(db, { ...audit, outcome: 'refused_purpose' });
    return {
      status: 409,
      body: {
        error: 'code_not_for_login',
        // Named so a renter knows this is deliberate, without describing what the
        // code would have done.
        purpose: picked.purpose,
      },
    };
  }

  // Recorded separately when the newest mail was not the one used: on a shared
  // mailbox that is the visible symptom of contention, and the shop has no other
  // way to see how often two renters are colliding.
  await logRequest(db, { ...audit, outcome: picked.depth === 0 ? 'served' : 'served_older' });
  return {
    status: 200,
    body: {
      code: picked.mail.code,
      // The mailbox address is deliberately not returned: handing it over would let
      // a renter reset the password directly.
      login: order.login,
      cooldownSeconds: CODE_COOLDOWN_SECONDS,
      remaining: Math.max(0, CODE_MAX_PER_RENTAL - Number(recent?.total ?? 0) - 1),
    },
  };
}
