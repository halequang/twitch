/**
 * Tells you which deploy permission your API token is missing.
 *
 * Cloudflare's own errors do not: a token with no D1 grant fails the deploy with
 * "The given account is not valid or is not authorized to access this service
 * [code: 7403]", which reads like a wrong account id and is not one. This probes
 * each endpoint `npm run deploy` actually calls and names the permission behind it.
 *
 * Usage:  npm run deploy:check
 *
 * Credentials come from _cfenv.mjs, so this checks the same token every other
 * script and the deploy itself will use.
 */

import { accountId as account, sources, token } from './_cfenv.mjs';

const API = 'https://api.cloudflare.com/client/v4';

if (!token) {
  console.error('✗ No CLOUDFLARE_API_TOKEN (checked the environment and .env.deploy).');
  process.exit(1);
}
if (!account) {
  console.error('✗ No CLOUDFLARE_ACCOUNT_ID (checked the environment and .env.deploy).');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}` };
async function probe(path) {
  const resp = await fetch(`${API}${path}`, { headers });
  const data = await resp.json().catch(() => ({}));
  const errs = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
  return { ok: data.success === true, status: resp.status, errs, result: data.result };
}

// The zone is resolved by name, exactly as wrangler resolves `zone_name`.
const ZONE_NAME = 'fungamingvn.shop';
const zones = await probe(`/zones?name=${ZONE_NAME}`);
const zoneId = zones.ok ? zones.result?.[0]?.id : null;

const checks = [
  ['Account · Workers Scripts · Edit', `/accounts/${account}/workers/scripts`, 'upload the worker, its assets and cron trigger'],
  ['Account · D1 · Edit             ', `/accounts/${account}/d1/database`, 'wrangler d1 migrations apply --remote'],
  ['Zone · Zone · Read              ', zoneId ? `/zones/${zoneId}` : null, `resolve zone_name ${ZONE_NAME}`],
  ['Zone · Workers Routes · Edit    ', zoneId ? `/zones/${zoneId}/workers/routes` : null, 'the two fungamingvn.shop routes'],
];

let missing = 0;
console.log(
  `Token   from ${sources.CLOUDFLARE_API_TOKEN}\n` +
    `Account ${account}\n` +
    `Zone    ${zoneId ?? `(cannot resolve ${ZONE_NAME} — Zone · Read is missing)`}\n`
);
for (const [label, path, why] of checks) {
  if (!path) {
    console.log(`${label}  ✗ not checked (no zone id)`);
    missing++;
    continue;
  }
  const r = await probe(path);
  console.log(`${label}  ${r.ok ? '✓' : `✗ ${r.status} ${r.errs}`}   — ${why}`);
  if (!r.ok) missing++;
}

// A read on each endpoint is all this can prove. Edit is what the deploy needs, and
// there is no way to test that without writing something, so a passing check is
// "the token reaches this service", not "the token may change it".
console.log(
  missing
    ? `\n✗ ${missing} permission(s) unavailable. Cloudflare dashboard → My Profile → API Tokens\n` +
        '  → your deploy token → Edit → add the rows above. Account-level rows also need\n' +
        '  Account Resources set to include this account; a token with only zone rows\n' +
        '  fails the deploy on D1 with code 7403.'
    : '\n✓ Every endpoint the deploy calls is reachable (read access confirmed on each).'
);
process.exit(missing ? 1 : 0);
