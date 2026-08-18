/**
 * Google + Apple sign-in and session handling, shared by the Cloudflare Worker
 * (worker/index.js) and the Astro dev server (astro.config.mjs) — same
 * split as src/lib/advisor.js.
 *
 * Flow (identical for both providers): the browser gets an ID token from the
 * provider's button, POSTs it to /api/auth/<provider>, we verify the JWT
 * signature against that provider's public keys, then hand back an HttpOnly
 * cookie holding a signed session. No database — the cookie is the session.
 * Neither provider needs its client *secret* here, because we only ever verify
 * an ID token; we never exchange an authorization code.
 *
 * Env:
 *   SESSION_SECRET       random string used to HMAC the session cookie (required)
 *   GOOGLE_CLIENT_ID     OAuth 2.0 Web client ID (public, served to the page)
 *   APPLE_CLIENT_ID      Apple *Services ID* (public, served to the page)
 *   APPLE_REDIRECT_URI   registered Apple return URL (defaults to the /game page)
 *
 * A provider with no client ID configured is simply not offered on the page.
 */

const PROVIDERS = {
  google: {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['accounts.google.com', 'https://accounts.google.com'],
    clientIdVar: 'GOOGLE_CLIENT_ID',
  },
  apple: {
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    clientIdVar: 'APPLE_CLIENT_ID',
  },
};

const DEFAULT_APPLE_REDIRECT_URI = 'https://fungamingvn.shop/thuegame/theisle';

export const COOKIE_NAME = 'fg_session';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

const encoder = new TextEncoder();

/* ─── base64url helpers ───────────────────────── */

function b64urlToBytes(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToString(input) {
  return new TextDecoder().decode(b64urlToBytes(input));
}

function stringToB64url(input) {
  return bytesToB64url(encoder.encode(input));
}

/* ─── ID token verification ───────────────────── */

// Both providers rotate signing keys; cache per provider per isolate and honour
// the Cache-Control max-age they ship.
const jwksCaches = { google: { keys: null, expiresAt: 0 }, apple: { keys: null, expiresAt: 0 } };

async function fetchJwks(provider, now) {
  const res = await fetch(PROVIDERS[provider].jwksUrl);
  if (!res.ok) throw new Error('jwks_unavailable');
  const data = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : 3600_000;
  jwksCaches[provider] = { keys: data.keys || [], expiresAt: now + ttl };
  return jwksCaches[provider].keys;
}

async function getSigningKey(provider, kid) {
  const now = Date.now();
  const cache = jwksCaches[provider];
  let keys = cache.keys && now < cache.expiresAt ? cache.keys : await fetchJwks(provider, now);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && jwksCaches[provider].expiresAt > now) {
    // Unknown kid with a still-warm cache means the keys just rotated.
    keys = await fetchJwks(provider, now);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('unknown_key');
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

// Apple sends email_verified as the *string* "true" rather than a boolean, so
// only an explicit negative counts as unverified.
function isEmailUnverified(claims) {
  return claims.email && (claims.email_verified === false || claims.email_verified === 'false');
}

/**
 * Verifies a provider ID token and returns its claims.
 * Throws with a short machine-readable message on any failure.
 */
export async function verifyIdToken(provider, idToken, clientId) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error('unknown_provider');

  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed_token');

  const header = JSON.parse(b64urlToString(parts[0]));
  if (header.alg !== 'RS256') throw new Error('bad_alg');

  const key = await getSigningKey(provider, header.kid);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error('bad_signature');

  const claims = JSON.parse(b64urlToString(parts[1]));
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!config.issuers.includes(claims.iss)) throw new Error('bad_issuer');
  if (!audiences.includes(clientId)) throw new Error('bad_audience');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token_expired');
  if (isEmailUnverified(claims)) throw new Error('email_unverified');

  return claims;
}

/* ─── Session cookie ──────────────────────────── */

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(user, secret, ttl = SESSION_TTL) {
  const payload = { ...user, exp: Math.floor(Date.now() / 1000) + ttl };
  const body = stringToB64url(JSON.stringify(payload));
  return `${body}.${bytesToB64url(await hmac(secret, body))}`;
}

async function readSessionToken(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = bytesToB64url(await hmac(secret, body));
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlToString(body));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  const { exp, ...user } = payload;
  return user;
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Resolves the signed-in user from a raw Cookie header, or null.
 * Other features (e.g. rentals) use this to authenticate their own endpoints.
 */
export async function readSession(cookie, secret) {
  if (!secret) return null;
  return readSessionToken(readCookie(cookie, COOKIE_NAME), secret);
}

function cookieHeader(value, { secure, maxAge }) {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/* ─── Request handling ────────────────────────── */

export const AUTH_PATHS = [
  '/api/auth/config',
  '/api/auth/google',
  '/api/auth/apple',
  '/api/auth/me',
  '/api/auth/logout',
];

// Apple only ever sends the user's name once — on the very first authorization,
// alongside the token rather than inside it. It is therefore client-supplied and
// untrusted, so it is used for display only; identity always comes from the
// verified `sub`.
function displayName(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control characters without relying on escape sequences.
  const clean = Array.from(raw)
    .filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 127; })
    .join('')
    .trim();
  return clean ? clean.slice(0, 60) : null;
}

function appleName(body) {
  const name = body?.user?.name;
  if (!name) return null;
  return displayName([name.firstName, name.lastName].filter(Boolean).join(' '));
}

/**
 * Transport-agnostic handler for the /api/auth/* endpoints, so the Worker and
 * the Astro dev middleware share one implementation.
 *
 * @returns {{ status: number, body: object, cookie?: string }}
 */
export async function handleAuthRequest({ path, method, body, cookie, secure, env }) {
  const secret = env?.SESSION_SECRET;
  const clientIdFor = (provider) => env?.[PROVIDERS[provider].clientIdVar] || null;

  if (path === '/api/auth/config') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    // Client IDs are public by design — they ship in the page that renders the
    // buttons. Serving them here keeps configuration in one place, and a
    // provider with no client ID is simply reported as null and not offered.
    const appleClientId = clientIdFor('apple');
    return {
      status: 200,
      body: {
        google: clientIdFor('google') ? { clientId: clientIdFor('google') } : null,
        apple: appleClientId
          ? {
              clientId: appleClientId,
              redirectUri: env?.APPLE_REDIRECT_URI || DEFAULT_APPLE_REDIRECT_URI,
            }
          : null,
      },
    };
  }

  if (!secret) {
    return { status: 503, body: { error: 'auth_not_configured' } };
  }

  const providerMatch = /^\/api\/auth\/(google|apple)$/.exec(path);
  if (providerMatch) {
    const provider = providerMatch[1];
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };

    const clientId = clientIdFor(provider);
    if (!clientId) return { status: 503, body: { error: 'provider_not_configured', provider } };

    // Google's button hands back `credential`; Apple's hands back
    // `authorization.id_token`. Both are plain OIDC ID tokens.
    const idToken = provider === 'google' ? body?.credential : body?.id_token;

    let claims;
    try {
      claims = await verifyIdToken(provider, idToken, clientId);
    } catch (err) {
      return { status: 401, body: { error: 'invalid_credential', reason: err.message } };
    }

    const user = {
      provider,
      sub: claims.sub,
      email: claims.email ?? null,
      name:
        displayName(claims.name) ??
        (provider === 'apple' ? appleName(body) : null) ??
        claims.email ??
        'Exile',
      picture: claims.picture ?? null, // Apple never provides one
    };
    return {
      status: 200,
      body: { user },
      cookie: cookieHeader(await signSession(user, secret), { secure, maxAge: SESSION_TTL }),
    };
  }

  if (path === '/api/auth/me') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    const user = await readSessionToken(readCookie(cookie, COOKIE_NAME), secret);
    return { status: 200, body: { user } };
  }

  if (path === '/api/auth/logout') {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    return {
      status: 200,
      body: { ok: true },
      cookie: cookieHeader('', { secure, maxAge: 0 }),
    };
  }

  return { status: 404, body: { error: 'not_found' } };
}
