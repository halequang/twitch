#!/usr/bin/env node
/**
 * Checks that the payOS credentials and payment channel are actually usable,
 * without going through the Worker or deploying anything.
 *
 * Usage:
 *   node scripts/payos-check.mjs              # read-only probe (safe)
 *   node scripts/payos-check.mjs --create      # also creates a 2,000đ test link
 *
 * Reads PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY from the
 * environment, falling back to .dev.vars. Nothing is printed except the last 4
 * characters of each key.
 *
 * Common results:
 *   code 214  Cổng thanh toán không tồn tại hoặc đã tạm dừng
 *             → the channel behind these keys is missing, paused, or not yet
 *               activated. Fix it in the payOS dashboard (Kênh thanh toán),
 *               then re-copy ALL THREE keys from that same channel.
 *   code 401/403  wrong client id or api key.
 *   code 231  signature mismatch → the checksum key belongs to a different
 *             channel than the client id / api key.
 */

import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const BASE = process.env.PAYOS_BASE_URL || 'https://api-merchant.payos.vn';

function fromDevVars(name) {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    // Split into lines first. A multiline regex with \s* around the "=" lets an
    // EMPTY value swallow the following line as its value, which would silently
    // hand back a comment instead of reporting the key as unset.
    for (const line of txt.split('\n')) {
      const m = /^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
      if (m && m[1] === name && m[2]) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const conf = (name) => process.env[name] || fromDevVars(name);

const clientId = conf('PAYOS_CLIENT_ID');
const apiKey = conf('PAYOS_API_KEY');
const checksumKey = conf('PAYOS_CHECKSUM_KEY');

const missing = [
  ['PAYOS_CLIENT_ID', clientId],
  ['PAYOS_API_KEY', apiKey],
  ['PAYOS_CHECKSUM_KEY', checksumKey],
].filter(([, v]) => !v);

if (missing.length) {
  console.error('Missing: ' + missing.map(([k]) => k).join(', '));
  console.error('Set them in the environment or .dev.vars. In production they are');
  console.error('Worker secrets — this script cannot read those, so paste the same');
  console.error('values into .dev.vars to test them.');
  process.exit(1);
}

const tail = (s) => '…' + String(s).slice(-4);
console.log(`payOS  base=${BASE}`);
console.log(`       clientId=${tail(clientId)}  apiKey=${tail(apiKey)}  checksumKey=${tail(checksumKey)}`);

const headers = { 'x-client-id': clientId, 'x-api-key': apiKey, 'content-type': 'application/json' };

function report(label, json, status) {
  const code = json?.code ?? `http_${status}`;
  const desc = json?.desc || json?.message || '(no message)';
  const ok = json?.code === '00';
  console.log(`\n${label}: ${ok ? 'OK' : 'FAILED'}  code=${code}`);
  if (!ok) console.log(`  ${desc}`);
  return ok;
}

/* 1. Read-only probe: look up an order code that cannot exist. Valid keys on a
      live channel answer "not found"; a dead channel complains about the
      channel instead, which is the signal we want. */
const probeCode = 999999999;
let res = await fetch(`${BASE}/v2/payment-requests/${probeCode}`, { headers });
let json = await res.json().catch(() => null);
const lookupCode = json?.code ?? `http_${res.status}`;

console.log(`\nCredential / channel probe: code=${lookupCode}`);
if (lookupCode === '214') {
  console.log('  ✘ Cổng thanh toán không tồn tại hoặc đã tạm dừng.');
  console.log('    The channel behind these keys is missing, paused, or not activated.');
  console.log('    Fix: payOS dashboard → Kênh thanh toán → check the channel is active,');
  console.log('    then re-copy Client ID, API Key AND Checksum Key from that same channel.');
  process.exit(2);
} else if (['401', '403', 'http_401', 'http_403'].includes(String(lookupCode))) {
  console.log('  ✘ Credentials rejected — wrong Client ID or API Key.');
  process.exit(2);
} else {
  console.log(`  ✓ Channel responded (${json?.desc || 'no message'}).`);
  console.log('    "not found" here is expected — the probe order does not exist.');
}

/* 2. Optional: actually create a link, which is the operation that was failing. */
if (!process.argv.includes('--create')) {
  console.log('\nRe-run with --create to also attempt a real 2,000đ payment link.');
  process.exit(0);
}

const orderCode = Math.floor(Date.now() / 1000) - 1735689600;
const body = {
  orderCode,
  amount: 2000,
  description: 'payOS check',
  returnUrl: 'https://fungamingvn.shop/game?rent=success',
  cancelUrl: 'https://fungamingvn.shop/game?rent=cancel',
};

const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode(checksumKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sigBytes = await crypto.subtle.sign(
  'HMAC',
  key,
  enc.encode(
    `amount=${body.amount}&cancelUrl=${body.cancelUrl}&description=${body.description}&orderCode=${body.orderCode}&returnUrl=${body.returnUrl}`
  )
);
body.signature = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, '0')).join('');

res = await fetch(`${BASE}/v2/payment-requests`, { method: 'POST', headers, body: JSON.stringify(body) });
json = await res.json().catch(() => null);

if (report('Create payment link', json, res.status)) {
  console.log(`  checkoutUrl: ${json.data?.checkoutUrl}`);
  console.log(`  orderCode:   ${orderCode}  (cancel it in the dashboard if unused)`);
} else {
  process.exit(2);
}
