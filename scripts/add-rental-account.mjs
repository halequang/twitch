#!/usr/bin/env node
/**
 * Adds Steam accounts to the rental pool.
 *
 * Passwords are stored encrypted (AES-GCM under ACCOUNT_ENC_KEY) — the exact
 * scheme src/lib/rentals.js uses — so you cannot just INSERT a plaintext one by
 * hand. This script does the encryption and runs the INSERT for you.
 *
 * Single account:
 *   node scripts/add-rental-account.mjs --login isle_01 --password 'pw' [options]
 *
 * Bulk, from a text file (one account per line):
 *   node scripts/add-rental-account.mjs --file scripts/steam_accounts.txt [--remote]
 *
 *   Line format — fields separated by "----", optional trailing " -> note":
 *     login----password----email                                    -> note
 *     login----password----email----emailPassword                   -> note
 *     login----password----email----emailPassword----internalNote    -> note
 *
 *   The email and its password are stored for shop administration only; they are
 *   never returned to a renter (handing them over would give away the account
 *   permanently). The 5th field and the trailing "-> note" are the same private
 *   annotation written two ways — a flag like "red_flag" belongs there, and both
 *   land in internal_note, which is never shown to a renter. The renter-facing
 *   message is set with --note. If a line carries both, they are joined.
 *
 * Options:
 *   --login     <string>   Steam login (single mode)
 *   --password  <string>   Steam password (single mode)
 *   --file      <path>     Bulk import from a text file
 *   --note      <string>   Renter-facing message shown with the credentials
 *   --game      <id>       Defaults to the-isle
 *   --remote               Write to the deployed D1 (default: local)
 *   --sql-only             Print the SQL instead of running wrangler
 *   --dry-run              Parse and report only; touch nothing
 *   --replace              Overwrite existing logins (re-encrypt) instead of skipping
 *
 * ACCOUNT_ENC_KEY is read from the environment, or from .dev.vars.
 * It must be the SAME value as the deployed secret, or the Worker will not be
 * able to decrypt what this script writes.
 */

// Puts CLOUDFLARE_API_TOKEN into the environment so a `--remote` run authenticates
// with the deploy token instead of falling back to the OAuth session.
import './_cfenv.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const DB_NAME = 'fungaming-rentals';

function parseArgs(argv) {
  const out = { game: 'the-isle', remote: false, sqlOnly: false, dryRun: false, replace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remote') out.remote = true;
    else if (arg === '--sql-only') out.sqlOnly = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--replace') out.replace = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function loadEncKey() {
  if (process.env.ACCOUNT_ENC_KEY) return process.env.ACCOUNT_ENC_KEY;
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    // Line by line on purpose. A multiline regex with \s* around the "=" lets an
    // EMPTY ACCOUNT_ENC_KEY= swallow the next line as its value — which would
    // encrypt every account under a comment string, leaving rows production can
    // never decrypt. Better to report the key as unset.
    for (const line of txt.split('\n')) {
      const m = /^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
      if (m && m[1] === 'ACCOUNT_ENC_KEY' && m[2]) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mirrors encryptSecret() in src/lib/rentals.js.
async function encryptSecret(plaintext, secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

const sqlQuote = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Parses one line of the bulk file.
 * Returns null for blanks/comments, or { error } for a malformed line.
 */
export function parseAccountLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  // Split the private annotation off the end first: "fields -> note".
  const arrow = line.indexOf('->');
  const fieldPart = arrow === -1 ? line : line.slice(0, arrow);
  const internalNote = arrow === -1 ? null : line.slice(arrow + 2).trim() || null;

  const fields = fieldPart
    .split('----')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  if (fields.length < 2) return { error: 'need at least login----password' };
  if (fields.length > 5) return { error: `unexpected extra field(s): ${fields.length} found, max 5` };

  const [login, password, email, emailPassword, noteField] = fields;

  return {
    login,
    password,
    email: email ?? null,
    emailPassword: emailPassword ?? null,
    // A 5th field and a trailing "-> note" mean the same thing; keep both rather
    // than letting one silently win, since each is someone's warning about the
    // account. internal_note is admin-only, so nothing here reaches a renter.
    internalNote: [noteField, internalNote].filter(Boolean).join(' · ') || null,
  };
}

function insertSql(account, { game, note, passwordEnc, emailPasswordEnc, replace }) {
  const values =
    `${sqlQuote(game)}, ${sqlQuote(account.login)}, ${sqlQuote(passwordEnc)}, ${sqlQuote(note)}, ` +
    `'available', strftime('%s','now'), ${sqlQuote(account.email)}, ${sqlQuote(emailPasswordEnc)}, ` +
    `${sqlQuote(account.internalNote)}`;
  const columns =
    `(game, login, password_enc, note, status, created_at, email, email_password_enc, internal_note)`;

  if (!replace) {
    // OR IGNORE so re-running the import is safe — (game, login) is unique.
    return `INSERT OR IGNORE INTO steam_accounts ${columns} VALUES (${values});`;
  }

  // --replace re-encrypts an existing row in place. This is the escape hatch for
  // "I imported under the wrong ACCOUNT_ENC_KEY" — a plain re-import would be
  // silently ignored and leave the undecryptable rows behind. `status` and
  // `created_at` are deliberately left alone so a live rental is not disturbed.
  return (
    `INSERT INTO steam_accounts ${columns} VALUES (${values}) ` +
    `ON CONFLICT (game, login) DO UPDATE SET ` +
    `password_enc = excluded.password_enc, ` +
    `email = excluded.email, ` +
    `email_password_enc = excluded.email_password_enc, ` +
    `internal_note = excluded.internal_note;`
  );
}

function runSql(sql, remote) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local', '--command', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/* ─── main ────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));

if (!args.file && (!args.login || !args.password)) {
  console.error(
    'Usage:\n' +
      "  node scripts/add-rental-account.mjs --login <login> --password <password> [--note '...'] [--remote]\n" +
      '  node scripts/add-rental-account.mjs --file scripts/steam_accounts.txt [--remote] [--dry-run]'
  );
  process.exit(1);
}

const encKey = loadEncKey();
if (!encKey && !args.dryRun) {
  console.error('ACCOUNT_ENC_KEY not found. Set it in the environment or in .dev.vars.');
  process.exit(1);
}

const accounts = [];
if (args.file) {
  const lines = readFileSync(args.file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const parsed = parseAccountLine(line);
    if (!parsed) return;
    if (parsed.error) {
      console.error(`  line ${i + 1}: SKIPPED — ${parsed.error}`);
      return;
    }
    accounts.push(parsed);
  });
} else {
  accounts.push({
    login: args.login,
    password: args.password,
    email: args.email ?? null,
    emailPassword: null,
    internalNote: null,
  });
}

if (!accounts.length) {
  console.error('No usable accounts found.');
  process.exit(1);
}

// Duplicate logins inside the source file itself.
const seen = new Set();
const unique = accounts.filter((a) => {
  if (seen.has(a.login)) {
    console.error(`  duplicate login in file, skipping later copy: ${a.login}`);
    return false;
  }
  seen.add(a.login);
  return true;
});

console.log(`Parsed ${unique.length} account(s) for game "${args.game}".`);
for (const a of unique) {
  // Never print passwords.
  const bits = [a.login];
  if (a.email) bits.push(a.email);
  if (a.emailPassword) bits.push('(+mail pw)');
  if (a.internalNote) bits.push(`note: ${a.internalNote}`);
  console.log('  · ' + bits.join('  ·  '));
}

if (args.dryRun) {
  console.log('\nDry run — nothing written.');
  process.exit(0);
}

const statements = [];
for (const account of unique) {
  statements.push(
    insertSql(account, {
      game: args.game,
      note: args.note ?? null,
      replace: args.replace,
      passwordEnc: await encryptSecret(account.password, encKey),
      emailPasswordEnc: account.emailPassword ? await encryptSecret(account.emailPassword, encKey) : null,
    })
  );
}

if (args.sqlOnly) {
  console.log('\n' + statements.join('\n'));
  process.exit(0);
}

try {
  // One statement per call keeps a single bad row from taking the batch down.
  let ok = 0;
  for (const [i, sql] of statements.entries()) {
    try {
      runSql(sql, args.remote);
      ok += 1;
    } catch {
      console.error(`  failed to insert ${unique[i].login}`);
    }
  }
  console.log(`\n✓ Wrote ${ok}/${statements.length} account(s) to the ${args.remote ? 'remote' : 'local'} database.`);
  console.log(
    args.replace
      ? '  (Existing logins were re-encrypted in place.)'
      : '  (Existing logins are left untouched — re-running this import is safe.'
        + ' Use --replace to re-encrypt them.)'
  );
} catch (err) {
  console.error('\nwrangler failed:', err.message);
  console.error('Re-run with --sql-only and execute the statements yourself.');
  process.exit(1);
}
