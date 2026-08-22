#!/usr/bin/env node
/**
 * Creates (or re-passwords) an email sign-in account, so you can log in without
 * Google or Apple — mainly to reach /admin on a local `wrangler dev`.
 *
 *   node scripts/create-user.mjs --email you@shop.vn --password 'something long'
 *   node scripts/create-user.mjs --email you@shop.vn                 # generates one
 *   node scripts/create-user.mjs --email you@shop.vn --manager --groups 1,2
 *   node scripts/create-user.mjs --email you@shop.vn --password x --remote
 *
 * Whether the account can open /admin is NOT decided here: the owner list is the
 * ADMIN_EMAILS variable, deliberately outside the database so a compromised table
 * cannot mint an owner. This script reports whether the address is on that list,
 * and --manager adds the scoped-manager row instead.
 *
 * Local by default. --remote creates a REAL customer login in production and asks
 * for confirmation first.
 *
 * The password is hashed with the same PBKDF2 helper the Worker verifies against
 * (src/lib/email-auth.js), so the iteration count travels inside the hash and a
 * later change to PASSWORD_KDF_ITERATIONS cannot strand this row.
 */

// Puts CLOUDFLARE_API_TOKEN into the environment so a `--remote` run authenticates
// with the deploy token instead of falling back to the OAuth session.
import './_cfenv.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hashPassword, normaliseEmail, passwordProblem } from '../src/lib/email-auth.js';

const DB_NAME = 'fungaming-rentals';

function parseArgs(argv) {
  const out = { remote: false, manager: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') out.remote = true;
    else if (a === '--manager') out.manager = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function fromDevVars(name) {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
      if (m && m[1] === name && m[2]) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const conf = (name) => process.env[name] || fromDevVars(name) || null;

function d1(sql, remote) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  if (start === -1) return [];
  const data = JSON.parse(out.slice(start));
  const block = Array.isArray(data) ? data[0] : data;
  return block?.results ?? [];
}

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** Readable but not guessable — printed once, so it has to be typeable. */
function generatePassword() {
  const words = ['isle', 'raptor', 'jungle', 'amber', 'delta', 'ember', 'north', 'quartz'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `${pick()}-${pick()}-${n}`;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim().toLowerCase()))));
}

/* ─── main ────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
const where = args.remote ? 'REMOTE (production)' : 'local';

const parsed = normaliseEmail(args.email);
if (!parsed) {
  console.error('Usage: node scripts/create-user.mjs --email you@shop.vn [--password pw] [--manager --groups 1,2] [--remote]');
  process.exit(1);
}

const password = args.password || generatePassword();
const generated = !args.password;
const problem = passwordProblem(password);
if (problem) {
  console.error(`Password rejected: ${problem}`);
  process.exit(1);
}

// A production login belongs to a real person; do not create one by accident.
if (args.remote) {
  const answer = await ask(`About to create/repassword ${parsed.email} in PRODUCTION. Type 'yes': `);
  if (answer !== 'yes' && answer !== 'y') {
    console.log('Aborted.');
    process.exit(0);
  }
}

let existing;
try {
  existing = d1(`SELECT id, email FROM users WHERE email_lower = ${q(parsed.lower)}`, args.remote)[0] || null;
} catch (e) {
  console.error(`Could not read the ${where} database: ${e.message}`);
  console.error('If this mentions "users", apply migrations/0008_email_accounts.sql first.');
  process.exit(1);
}

const hash = await hashPassword(password, { PASSWORD_KDF_ITERATIONS: conf('PASSWORD_KDF_ITERATIONS') });
const ts = Math.floor(Date.now() / 1000);

if (existing) {
  d1(`UPDATE users SET password_hash = ${q(hash)} WHERE id = ${Number(existing.id)}`, args.remote);
  console.log(`[${where}] ${existing.email} already existed (id ${existing.id}) — password replaced.`);
} else {
  const row = d1(
    `INSERT INTO users (email, email_lower, password_hash, name, created_at, last_login_at)
     VALUES (${q(parsed.email)}, ${q(parsed.lower)}, ${q(hash)}, ${q(parsed.email.split('@')[0])}, ${ts}, NULL)
     RETURNING id`,
    args.remote
  )[0];
  console.log(`[${where}] created ${parsed.email} (id ${row?.id ?? '?'}).`);
}

/* ─── access ──────────────────────────────────── */

// The owner list lives in ADMIN_EMAILS on purpose, so report rather than grant.
const adminList = String(conf('ADMIN_EMAILS') || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const isOwner = adminList.includes(parsed.lower);

if (args.manager) {
  // ''.split(',') is [''], and Number('') is 0 — which sailed past Number.isFinite
  // and tried to insert group_id 0, breaking the foreign key. Drop the blanks
  // before converting, and require a real row id.
  const groupIds = String(args.groups || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  d1(
    `INSERT INTO managers (identity, label, created_at) VALUES (${q(parsed.lower)}, ${q(parsed.email)}, ${ts})
     ON CONFLICT (identity) DO UPDATE SET label = excluded.label`,
    args.remote
  );
  const mgr = d1(`SELECT id FROM managers WHERE identity = ${q(parsed.lower)}`, args.remote)[0];
  if (mgr && groupIds.length) {
    d1(`DELETE FROM manager_groups WHERE manager_id = ${Number(mgr.id)}`, args.remote);
    for (const gid of groupIds) {
      d1(
        `INSERT OR IGNORE INTO manager_groups (manager_id, group_id) VALUES (${Number(mgr.id)}, ${gid})`,
        args.remote
      );
    }
  }
  console.log(
    `  manager row ${mgr ? `id ${mgr.id}` : '(?)'}` +
      (groupIds.length ? `, scoped to group(s) ${groupIds.join(', ')}` : ' — NO groups assigned, so it sees nothing yet')
  );
}

console.log('');
console.log(`  sign in at  /thuegame/theisle  →  "Đăng nhập" tab`);
console.log(`  email       ${parsed.email}`);
if (generated) console.log(`  password    ${password}      <- generated, shown once`);
console.log(
  `  /admin      ${
    isOwner
      ? 'owner (listed in ADMIN_EMAILS)'
      : args.manager
        ? 'manager — only their assigned groups'
        : `NO access. Add it to ADMIN_EMAILS${args.remote ? '' : ' in .dev.vars'}, or re-run with --manager`
  }`
);
if (!args.remote) console.log('  note        local only — `wrangler dev` has D1, `npm run dev` does not');
