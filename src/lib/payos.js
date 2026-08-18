/**
 * Minimal PayOS client for Cloudflare Workers.
 *
 * The signature rules below mirror payOS's own SDK (@payos/node,
 * lib/crypto/subtle-crypto.js) exactly — getting either of them wrong means
 * payOS rejects our requests, or worse, that we accept a forged webhook:
 *
 *   - Payment request: HMAC-SHA256 over the fixed field order
 *     `amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..`
 *   - Webhook:         HMAC-SHA256 over the *data* object, keys sorted
 *     ascending, joined as `key=value&...`
 *
 * Env:
 *   PAYOS_CLIENT_ID     x-client-id header
 *   PAYOS_API_KEY       x-api-key header
 *   PAYOS_CHECKSUM_KEY  HMAC key for both signatures
 */

const DEFAULT_PAYOS_BASE_URL = 'https://api-merchant.payos.vn';

// Overridable via PAYOS_BASE_URL so the integration can be pointed at a stub in
// tests. Production leaves it unset.
const baseUrl = (env) => env?.PAYOS_BASE_URL || DEFAULT_PAYOS_BASE_URL;

const encoder = new TextEncoder();

async function hmacSha256Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Sorted `key=value&...` form of an object, per payOS's convertObjToQueryStr. */
export function objectToSignatureString(data) {
  return Object.keys(data)
    .sort()
    .filter((key) => data[key] !== undefined)
    .map((key) => {
      let value = data[key];
      if (Array.isArray(value)) {
        // Array elements are themselves key-sorted before stringifying.
        value = JSON.stringify(
          value.map((item) =>
            item && typeof item === 'object'
              ? Object.keys(item)
                  .sort()
                  .reduce((acc, k) => ((acc[k] = item[k]), acc), {})
              : item
          )
        );
      }
      if (value === null || value === undefined || value === 'undefined' || value === 'null') {
        value = '';
      }
      return `${key}=${value}`;
    })
    .join('&');
}

export function paymentRequestSignatureString({ amount, cancelUrl, description, orderCode, returnUrl }) {
  return `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
}

export function payosConfigured(env) {
  return Boolean(env?.PAYOS_CLIENT_ID && env?.PAYOS_API_KEY && env?.PAYOS_CHECKSUM_KEY);
}

function payosHeaders(env) {
  return {
    'x-client-id': env.PAYOS_CLIENT_ID,
    'x-api-key': env.PAYOS_API_KEY,
    'content-type': 'application/json',
  };
}

/**
 * Creates a payment link. Returns payOS's `data` object, which carries
 * `checkoutUrl`, `paymentLinkId`, `qrCode`, ...
 */
export async function createPaymentLink(
  env,
  { orderCode, amount, description, returnUrl, cancelUrl, expiredAt, items, buyerName, buyerEmail, buyerPhone }
) {
  // Only these five fields are signed, in this exact order — items/buyer* are
  // deliberately excluded (see @payos/node createSignatureOfPaymentRequest).
  const signature = await hmacSha256Hex(
    env.PAYOS_CHECKSUM_KEY,
    paymentRequestSignatureString({ amount, cancelUrl, description, orderCode, returnUrl })
  );

  const res = await fetch(`${baseUrl(env)}/v2/payment-requests`, {
    method: 'POST',
    headers: payosHeaders(env),
    body: JSON.stringify({
      orderCode,
      amount,
      description,
      returnUrl,
      cancelUrl,
      signature,
      ...(expiredAt ? { expiredAt } : {}),
      ...(items ? { items } : {}),
      ...(buyerName ? { buyerName } : {}),
      ...(buyerEmail ? { buyerEmail } : {}),
      ...(buyerPhone ? { buyerPhone } : {}),
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== '00') {
    // Carry payOS's own code through — "code 214 desc ..." is what their support
    // and docs are indexed by, so a bare message is not actionable.
    const code = json?.code ?? `http_${res.status}`;
    const detail = json?.desc || json?.message || 'no detail';
    const err = new Error(`payos_create_failed (code ${code}): ${detail}`);
    err.payosCode = String(code);
    throw err;
  }
  return json.data;
}

/**
 * Errors that mean *the shop* is misconfigured, not that the customer did
 * anything wrong. Worth separating: a customer cannot act on "your payment
 * channel is paused", so they get a plain apology while the detail is logged.
 *
 *   214 — payment channel missing or suspended
 *   20/21 — malformed request / bad credentials
 *   231 — invalid signature
 */
const MERCHANT_CONFIG_CODES = new Set(['20', '21', '214', '231', 'http_401', 'http_403']);

export function isMerchantConfigError(err) {
  return MERCHANT_CONFIG_CODES.has(String(err?.payosCode ?? ''));
}

/** Reads the current state of a payment link, by orderCode or paymentLinkId. */
export async function getPaymentInfo(env, id) {
  const res = await fetch(`${baseUrl(env)}/v2/payment-requests/${id}`, {
    headers: payosHeaders(env),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== '00') {
    const detail = json?.desc || json?.message || `http_${res.status}`;
    throw new Error(`payos_lookup_failed: ${detail}`);
  }
  return json.data;
}

export async function cancelPaymentLink(env, id, cancellationReason) {
  const res = await fetch(`${baseUrl(env)}/v2/payment-requests/${id}/cancel`, {
    method: 'POST',
    headers: payosHeaders(env),
    body: JSON.stringify(cancellationReason ? { cancellationReason } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== '00') {
    throw new Error(`payos_cancel_failed: ${json?.desc || `http_${res.status}`}`);
  }
  return json.data;
}

/**
 * Verifies a webhook body and returns its `data`, or null if the signature does
 * not match. Everything downstream of this MUST treat an unverified body as
 * hostile — a forged webhook would hand out Steam credentials for free.
 */
export async function verifyWebhook(body, checksumKey) {
  const data = body?.data;
  const signature = body?.signature;
  if (!data || typeof signature !== 'string' || !checksumKey) return null;
  const expected = await hmacSha256Hex(checksumKey, objectToSignatureString(data));
  return timingSafeEqualHex(signature, expected) ? data : null;
}

/** payOS marks a payment settled with code "00" / status PAID. */
export function isPaid(info) {
  return info?.status === 'PAID' || info?.code === '00';
}

/* ─── embedded checkout availability ──────────── */

// payOS serves a compact, chrome-light checkout at /web/<id>?embedded=true, and
// sends no X-Frame-Options or frame-ancestors, so it can be framed directly in
// our page.
//
// NOTE: the official SDK instead rewrites the path to /embedded/<id>. That route
// returns "Thông tin truyền lên không hợp lệ" on this merchant account — and,
// critically, that error page posts NO message to the parent window, so the
// SDK's onExit never fires and a customer would stare at it forever. Hence the
// direct iframe plus this probe, which falls back to the hosted page if payOS
// ever stops serving the embedded variant too.
const EMBEDDED_ERROR_MARKERS = ['không hợp lệ', 'khong hop le'];
const EMBEDDED_PROBE_TTL = 10 * 60 * 1000;

let embeddedProbe = { available: null, checkedAt: 0 };

export function embeddedUrlFor(checkoutUrl) {
  const url = String(checkoutUrl || '');
  if (!url) return '';
  return url + (url.includes('?') ? '&' : '?') + 'embedded=true';
}

export async function embeddedCheckoutAvailable(checkoutUrl) {
  const now = Date.now();
  if (embeddedProbe.available !== null && now - embeddedProbe.checkedAt < EMBEDDED_PROBE_TTL) {
    return embeddedProbe.available;
  }

  let available = false;
  try {
    const res = await fetch(embeddedUrlFor(checkoutUrl));
    if (res.ok) {
      const html = (await res.text()).toLowerCase();
      available = !EMBEDDED_ERROR_MARKERS.some((m) => html.includes(m));
    }
  } catch {
    // Unreachable — assume unavailable. The hosted page always works, so the
    // safe default is the one that cannot strand a paying customer.
    available = false;
  }

  embeddedProbe = { available, checkedAt: now };
  return available;
}
