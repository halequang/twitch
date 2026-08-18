// AES-GCM helper matching src/lib/rentals.js (WebCrypto) in the twitch project.
// Usage: ACCOUNT_ENC_KEY=... node _d1crypto.mjs <enc|dec> <value>
// Prints the result to stdout. Exit 2 = missing key, 1 = crypto error.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plaintext, secret) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`;
}

async function decryptSecret(stored, secret) {
  const [ivPart, ctPart] = String(stored || "").split(".");
  if (!ivPart || !ctPart) throw new Error("bad_ciphertext");
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(ivPart) }, key, b64urlToBytes(ctPart));
  return decoder.decode(pt);
}

const [, , mode, value] = process.argv;
const secret = process.env.ACCOUNT_ENC_KEY;
if (!secret) { console.error("NO_KEY"); process.exit(2); }
(mode === "enc" ? encryptSecret(value, secret) : decryptSecret(value, secret))
  .then((r) => process.stdout.write(r))
  .catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
