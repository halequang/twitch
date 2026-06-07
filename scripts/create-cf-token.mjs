/**
 * Create a Cloudflare API token with full access to this account (and its zones).
 *
 * Bootstrap auth comes from a gitignored `.cf-bootstrap` file at the repo root:
 *
 *   CF_EMAIL=you@example.com
 *   CF_GLOBAL_KEY=<your Global API Key>
 *
 * (Alternatively, set CF_API_TOKEN=<token with "API Tokens: Edit"> instead of the pair.)
 *
 * Usage:  node scripts/create-cf-token.mjs ["Token name"]
 *
 * The script enumerates every permission group, scopes the account-level ones to
 * this account and the zone-level ones to all zones in the account, then creates
 * the token and prints its value once.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = "9a0bdae942498efd47e7c1337b0d964f";

function loadBootstrap() {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".cf-bootstrap"), "utf8");
  } catch {
    fail(
      "Missing .cf-bootstrap file. Create it at the repo root with:\n" +
        "  CF_EMAIL=you@example.com\n  CF_GLOBAL_KEY=<Global API Key>\n" +
        "(or CF_API_TOKEN=<token with API Tokens: Edit>)"
    );
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function authHeaders(env) {
  if (env.CF_API_TOKEN) {
    return { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  }
  if (env.CF_EMAIL && env.CF_GLOBAL_KEY) {
    return { "X-Auth-Email": env.CF_EMAIL, "X-Auth-Key": env.CF_GLOBAL_KEY };
  }
  fail("Provide either CF_API_TOKEN, or both CF_EMAIL and CF_GLOBAL_KEY, in .cf-bootstrap");
}

async function cf(path, headers, init = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...headers, ...(init.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.success === false) {
    const errs = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    fail(`API ${resp.status} on ${path} — ${errs || "unknown error"}`);
  }
  return data.result;
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const env = loadBootstrap();
const headers = authHeaders(env);
const name = process.argv[2] || "full-account-access (scripted)";

// 1. Enumerate all permission groups (paginated).
const groups = [];
for (let page = 1; ; page++) {
  const batch = await cf(
    `/user/tokens/permission_groups?per_page=100&page=${page}`,
    headers
  );
  groups.push(...batch);
  if (batch.length < 100) break;
}

// 2. Partition by scope. Account-owned tokens can't include user-scoped groups.
const accountGroups = [];
const zoneGroups = [];
for (const g of groups) {
  const scopes = g.scopes || [];
  if (scopes.includes("com.cloudflare.api.account.zone")) zoneGroups.push({ id: g.id });
  else if (scopes.includes("com.cloudflare.api.account")) accountGroups.push({ id: g.id });
}

console.log(
  `Found ${groups.length} permission groups → ${accountGroups.length} account-level, ${zoneGroups.length} zone-level.`
);

// 3. Build policies. Account groups scoped to this account; zone groups to all
//    zones within it.
const policies = [];
if (accountGroups.length) {
  policies.push({
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*" },
    permission_groups: accountGroups,
  });
}
if (zoneGroups.length) {
  policies.push({
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: { "com.cloudflare.api.account.zone.*": "*" } },
    permission_groups: zoneGroups,
  });
}

// 4. Create the token.
const result = await cf("/user/tokens", headers, {
  method: "POST",
  body: JSON.stringify({ name, policies, status: "active" }),
});

console.log("\n✓ Token created.");
console.log(`  id:    ${result.id}`);
console.log(`  name:  ${name}`);
console.log("\n  VALUE (shown once — copy it now):\n");
console.log(`    ${result.value}\n`);
console.log("  Store it as a secret, e.g.:  echo -n '<value>' | npx wrangler secret put SOME_NAME");
