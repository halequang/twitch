/**
 * Cloudflare credentials for scripts that shell out to `wrangler … --remote`.
 *
 * Importing this module puts CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID into
 * process.env, so the wrangler child process authenticates with the deploy token.
 * Without it a `--remote` script inherits an environment with no token, wrangler
 * falls back to the OAuth session, and — with no usable one stored — the run dies
 * on "Failed to fetch auth token: 400 Bad Request" instead of reading the database.
 *
 * Precedence, and why:
 *   1. .env.deploy   — the deploy token. Wins even over an exported value, because
 *                      the value most likely already exported is the R2-only token
 *                      from .env (scripts/upload-images.sh needs it), and that one
 *                      cannot read D1. scripts/deploy.sh loads it last for the same
 *                      reason; this is that rule for the node scripts.
 *   2. the environment — a token exported by hand, for a one-off.
 *   3. .env          — last resort, so a repo that only has the R2 token still
 *                      reaches Cloudflare and fails with a permissions error that
 *                      says so, rather than an OAuth error that does not.
 *
 * Only those two names are read; nothing else in the files is touched.
 */

import { readFileSync } from 'node:fs';

const KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];

function readEnvFile(name) {
  const found = {};
  let text;
  try {
    text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  } catch {
    return found;
  }
  for (const line of text.split(/\r?\n/)) {
    // `export FOO=bar` as well as `FOO=bar`: .env is also sourced by a shell.
    const m = /^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m && KEYS.includes(m[1]) && m[2]) found[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return found;
}

const deploy = readEnvFile('.env.deploy');
const fallback = readEnvFile('.env');

/** Where each value came from, for a script that wants to say so. */
export const sources = {};

for (const key of KEYS) {
  const candidates = [
    ['.env.deploy', deploy[key]],
    ['environment', process.env[key]],
    ['.env', fallback[key]],
  ];
  const hit = candidates.find(([, value]) => value);
  if (!hit) continue;
  [sources[key], process.env[key]] = hit;
}

export const token = process.env.CLOUDFLARE_API_TOKEN ?? null;
export const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
