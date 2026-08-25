/**
 * Shop-owner admin: manage the Steam account pool and inspect orders.
 *
 * Authorisation reuses the existing Google/Apple session — an admin is simply a
 * signed-in user whose identity appears in ADMIN_EMAILS. It FAILS CLOSED: with
 * the var unset nobody is an admin, so a misconfigured deploy locks the panel
 * rather than opening it to every logged-in customer.
 *
 * Steam passwords are never included in list responses. Revealing one is a
 * separate, explicit call so it cannot leak into a page load or a log.
 *
 * Env:
 *   ADMIN_EMAILS  comma-separated. Entries are either an email
 *                 ("me@shop.vn") or a provider-scoped id ("google:1234").
 */

import { decryptSecret, encryptSecret, sweepExpiredRentals } from './rentals.js';
import { DEFAULT_GAME, GAMES } from '../data/rental-plans.js';
import { pendingExpiryNotices, telegramConfigured } from './notify.js';
import { REPORT_REASONS, URGENT_REASONS } from './reports.js';
import { GAME_REQUEST_STATUSES } from './game-requests.js';

export const ADMIN_PREFIX = '/api/admin/';

function adminList(env) {
  return String(env?.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The identities a session can be matched on: its email, and provider:sub. */
function identitiesOf(user) {
  const out = [];
  const email = String(user?.email || '').toLowerCase();
  if (email) out.push(email);
  if (user?.sub) out.push(`${user.provider || ''}:${user.sub}`.toLowerCase());
  return out;
}

/** The shop owner — from ADMIN_EMAILS. No list means no owner (fails closed). */
export function isAdmin(user, env) {
  if (!user) return false;
  const allowed = adminList(env);
  if (!allowed.length) return false;
  return identitiesOf(user).some((id) => allowed.includes(id));
}

/**
 * Who is calling and what they may touch.
 *
 *   owner   — listed in ADMIN_EMAILS. Sees everything, manages groups/managers.
 *   manager — a row in `managers`. Scoped to the groups assigned to them.
 *   null    — neither.
 *
 * The owner deliberately comes from the env var rather than the table: if the
 * owner were a row, deleting it would lock everyone out with no way back in.
 */
export async function resolveActor(env, user) {
  if (!user) return null;
  if (isAdmin(user, env)) return { role: 'owner', managerId: null, groupIds: null };
  if (!env?.DB) return null;

  const ids = identitiesOf(user);
  if (!ids.length) return null;

  const placeholders = ids.map(() => '?').join(', ');
  const row = await env.DB.prepare(
    `SELECT id FROM managers WHERE identity IN (${placeholders})`
  )
    .bind(...ids)
    .first();
  if (!row) return null;

  const groups = await env.DB.prepare(`SELECT group_id FROM manager_groups WHERE manager_id = ?`)
    .bind(row.id)
    .all();

  // groupIds is an ARRAY for a manager (possibly empty) and NULL for the owner.
  // Empty array => scoped to nothing, which every query below must honour rather
  // than falling back to "everything".
  return { role: 'manager', managerId: row.id, groupIds: (groups?.results ?? []).map((g) => g.group_id) };
}

const isOwner = (actor) => actor?.role === 'owner';

/**
 * SQL fragment + binds restricting a query to what the actor may see.
 * The owner gets no restriction; a manager is limited to their groups, and a
 * manager with no groups matches nothing (never everything).
 */
function scope(actor, column) {
  if (isOwner(actor)) return { sql: '', binds: [] };
  const ids = actor?.groupIds ?? [];
  if (!ids.length) return { sql: ' AND 1 = 0', binds: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => '?').join(', ')})`, binds: ids };
}

/** Whether this actor may act on a specific account row. */
function mayTouchAccount(actor, account) {
  if (isOwner(actor)) return true;
  if (account?.group_id == null) return false; // ungrouped stock is owner-only
  return (actor?.groupIds ?? []).includes(account.group_id);
}

const now = () => Math.floor(Date.now() / 1000);

// Statuses an admin may set by hand. 'pending' is deliberately absent: that is
// payOS's to own, and forcing an order back to it would orphan a paid payment.
// 'refunded' is here rather than only in the filter list because it is a decision an
// admin makes by hand: the money went back, so the order ends, the account returns to
// the pool, and the sale stops counting. Distinct from 'cancelled', which was never
// paid — telling them apart is the difference between "never bought" and "bought and
// we gave it back".
const ORDER_STATUSES = ['active', 'expired', 'cancelled', 'awaiting_stock', 'refunded'];

// Statuses that were paid but must not count as income. Kept as a set because three
// separate revenue sums have to agree, and a fourth is one refactor away.
const NON_REVENUE_STATUSES = ['refunded'];
const revenueStatusSql = (alias = '') =>
  ` AND ${alias}status NOT IN (${NON_REVENUE_STATUSES.map((s) => `'${s}'`).join(', ')})`;

// Every status an order row can actually hold, for the list filter. Deliberately
// wider than ORDER_STATUSES, which is what an admin may SET by hand: you can want
// to see the pending and payment_expired orders without being allowed to create
// one, and a filter that silently rejected them would look broken.
const ORDER_STATUS_FILTERS = [
  'pending',
  'active',
  'extended',
  // The rental a paid upgrade replaced. Filterable for the same reason 'extended'
  // is: it is a real paid row, and an admin looking for it must be able to.
  'upgraded',
  'expired',
  'cancelled',
  'payment_expired',
  'awaiting_stock',
  'sold',
  'refunded',
  'error',
];

/**
 * What customers want the shop to carry next, grouped by game.
 *
 * Grouped rather than listed row by row because the decision is per game, not per
 * customer: "six people want Rust" is what justifies buying Rust accounts. The
 * newest note is carried along so the tally is not just a number with no colour.
 *
 * Owner-only, like the rest of the demand reporting — a manager's scope is their own
 * accounts, and a game nobody stocks yet belongs to no group.
 */
async function listGameRequests(env) {
  const rows = await env.DB
    .prepare(
      `SELECT game_key,
              -- The most recently typed spelling, so the display is not stuck with
              -- whatever the first asker wrote.
              (SELECT g2.game_name FROM game_requests g2
                WHERE g2.game_key = g.game_key ORDER BY g2.updated_at DESC LIMIT 1) AS game_name,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
              MIN(created_at) AS first_at,
              MAX(updated_at) AS last_at,
              (SELECT g3.status FROM game_requests g3
                WHERE g3.game_key = g.game_key ORDER BY g3.replied_at DESC, g3.updated_at DESC LIMIT 1) AS status,
              (SELECT g4.reply FROM game_requests g4
                WHERE g4.game_key = g.game_key AND g4.reply IS NOT NULL
                ORDER BY g4.replied_at DESC LIMIT 1) AS reply,
              (SELECT g5.note FROM game_requests g5
                WHERE g5.game_key = g.game_key AND g5.note IS NOT NULL
                ORDER BY g5.updated_at DESC LIMIT 1) AS note
         FROM game_requests g
        GROUP BY game_key
        ORDER BY total DESC, last_at DESC
        LIMIT 100`
    )
    .all();

  return (rows?.results ?? []).map((r) => ({
    gameKey: r.game_key,
    name: r.game_name,
    total: Number(r.total ?? 0),
    open: Number(r.open_count ?? 0),
    status: r.status || 'open',
    statusLabel: GAME_REQUEST_STATUSES[r.status] || r.status || 'open',
    reply: r.reply ?? null,
    note: r.note ?? null,
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

/**
 * Answers every request for one game at once.
 *
 * Per game rather than per row on purpose: "we added Rust" is true for everyone who
 * asked for Rust, and making the owner reply to each asker separately would mean
 * most of them never hear back.
 */
async function replyToGameRequests(env, body) {
  const gameKey = cleanText(body?.gameKey, 80);
  if (!gameKey) return bad('bad_game_key');

  const status = String(body?.status ?? '');
  if (!GAME_REQUEST_STATUSES[status]) {
    return bad('bad_status', 400, { allowed: Object.keys(GAME_REQUEST_STATUSES) });
  }
  const reply = body?.reply === undefined ? null : cleanText(body.reply, 400);

  const ts = now();
  const result = await env.DB
    .prepare(
      `UPDATE game_requests
          SET status = ?, reply = COALESCE(?, reply), replied_at = ?, updated_at = ?
        WHERE game_key = ?`
    )
    .bind(status, reply, ts, ts, gameKey)
    .run();

  if (!result.meta.changes) return bad('unknown_game_key', 404);
  return { status: 200, body: { ok: true, gameKey, status, changed: result.meta.changes, requests: await listGameRequests(env) } };
}

function bad(error, status = 400, extra = {}) {
  return { status, body: { error, ...extra } };
}

/** Trim, drop control characters, and cap length. */
function cleanText(value, max = 200) {
  if (value == null) return null;
  const s = Array.from(String(value))
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 31 && c !== 127;
    })
    .join('')
    .trim();
  return s ? s.slice(0, max) : null;
}

/* ─── accounts ────────────────────────────────── */

// Deliberately omits password_enc / email_password_enc: a listing must never
// carry credentials, encrypted or not.
const ACCOUNT_COLUMNS = `
  a.id, a.game, a.login, a.email, a.note, a.internal_note, a.status, a.ban_state, a.created_at,
  (SELECT GROUP_CONCAT(g.game) FROM steam_account_games g WHERE g.account_id = a.id) AS games,
  a.reserved_for,
  (a.email_password_enc IS NOT NULL) AS has_email_password,
  a.group_id, g.name AS group_name,
  o.order_code AS rented_order, o.user_key AS rented_by, o.user_email AS rented_email,
  o.expires_at AS rented_until`;

const ACCOUNT_FROM = `
  FROM steam_accounts a
  LEFT JOIN account_groups g ON g.id = a.group_id
  LEFT JOIN orders o ON o.account_id = a.id AND o.status = 'active'`;

/**
 * Escapes the LIKE wildcards inside a search term.
 *
 * Binding the value stops injection but does NOT stop `%` and `_` from behaving as
 * wildcards, so typing a single `%` in the search box matched every row. Paired with
 * `ESCAPE '\\'` in the query so a typed wildcard searches for itself.
 */
function likeTerm(value) {
  return `%${String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Page and search parameters from the query string, clamped.
 *
 * `q` is always bound, never interpolated: it is user input reaching a LIKE clause.
 */
// defaultLimit matches PAGE_SIZE in admin.astro, so hitting the API by hand shows
// the same page the panel does. maxLimit stays high on purpose: the order editor
// asks for `limit=200` to list every assignable account, and clamping that to a
// page size would silently truncate the dropdown it builds from.
function paging(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(Number(query?.limit) || defaultLimit, 1), maxLimit);
  const page = Math.max(Number(query?.page) || 1, 1);
  const raw = typeof query?.q === 'string' ? query.q.trim().slice(0, 80) : '';
  return { limit, page, offset: (page - 1) * limit, q: raw };
}

function pageMeta({ total, limit, page }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return { total, page: Math.min(page, pages), pages, limit };
}

async function listAccounts(env, actor, query) {
  const where = scope(actor, 'a.group_id');
  const { limit, page, offset, q } = paging(query);

  // Account name is what an operator has in hand; email is free to include and is
  // the other thing written on a sticky note.
  const search = q ? " AND (a.login LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\')" : '';
  const searchBinds = q ? [likeTerm(q), likeTerm(q)] : [];
  // Lets the order editor pull the assignable pool without paging through
  // everything, since an available account may sit on any page.
  const statusFilter = typeof query?.status === 'string' && query.status ? ' AND a.status = ?' : '';
  const statusBinds = statusFilter ? [query.status] : [];

  // Group filter. 'none' is a real choice, not an absent one — "which accounts has
  // nobody filed yet" is the question this answers most often — so it cannot be
  // expressed by leaving the parameter off.
  let groupFilter = '';
  let groupBinds = [];
  const rawGroup = query?.group;
  if (typeof rawGroup === 'string' && rawGroup !== '') {
    if (rawGroup === 'none') {
      groupFilter = ' AND a.group_id IS NULL';
    } else {
      const gid = Number(rawGroup);
      if (!Number.isFinite(gid)) return { error: 'bad_group' };
      // Still inside the actor's scope: `where` above is ANDed, so a manager asking
      // for someone else's group id gets nothing rather than a peek.
      groupFilter = ' AND a.group_id = ?';
      groupBinds = [gid];
    }
  }

  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS n ${ACCOUNT_FROM} WHERE 1 = 1${where.sql}${search}${statusFilter}${groupFilter}`
  )
    .bind(...where.binds, ...searchBinds, ...statusBinds, ...groupBinds)
    .first();

  const rows = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM}
      WHERE 1 = 1${where.sql}${search}${statusFilter}${groupFilter}
      ORDER BY a.id
      LIMIT ? OFFSET ?`
  )
    .bind(...where.binds, ...searchBinds, ...statusBinds, ...groupBinds, limit, offset)
    .all();
  const meta = pageMeta({ total: Number(counted?.n ?? 0), limit, page });
  const items = (rows?.results ?? []).map((r) => ({
    id: r.id,
    groupId: r.group_id ?? null,
    groupName: r.group_name ?? null,
    game: r.game,
    // Every pool this login is in. One account can own several games — see
    // migrations/0014_account_games.sql.
    games: String(r.games || r.game || '').split(',').filter(Boolean),
    login: r.login,
    email: r.email ?? null,
    note: r.note ?? null,
    internalNote: r.internal_note ?? null,
    status: r.status,
    banState: r.ban_state ?? null,
    createdAt: r.created_at,
    reservedFor: r.reserved_for ?? null,
    hasEmailPassword: Boolean(r.has_email_password),
    rental: r.rented_order
      ? {
          orderCode: r.rented_order,
          userKey: r.rented_by,
          // Nullable: orders.user_email is whatever the provider gave at
          // checkout, and Apple accounts can have none. Callers should fall
          // back to userKey.
          userEmail: r.rented_email ?? null,
          expiresAt: r.rented_until,
        }
      : null,
  }));
  return { items, meta };
}

async function createAccount(env, actor, body) {
  const login = cleanText(body?.login, 100);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!login) return bad('login_required');
  if (!password) return bad('password_required');

  // A manager can only file an account under a group they hold; without one the
  // account would be ungrouped and invisible even to its creator.
  const groupId = body?.groupId == null || body.groupId === '' ? null : Number(body.groupId);
  if (!isOwner(actor)) {
    if (groupId == null) return bad('group_required');
    if (!(actor?.groupIds ?? []).includes(groupId)) return bad('forbidden_group', 403);
  }
  if (groupId != null) {
    const exists = await env.DB.prepare(`SELECT id FROM account_groups WHERE id = ?`).bind(groupId).first();
    if (!exists) return bad('unknown_group', 404);
  }

  const game = cleanText(body?.game, 50) || DEFAULT_GAME;
  const exists = await env.DB.prepare(`SELECT id FROM steam_accounts WHERE game = ? AND login = ?`)
    .bind(game, login)
    .first();
  if (exists) return bad('duplicate_login', 409, { id: exists.id });

  const emailPassword = typeof body?.emailPassword === 'string' ? body.emailPassword : '';
  await env.DB.prepare(
    `INSERT INTO steam_accounts
       (game, login, password_enc, note, status, created_at, email, email_password_enc, internal_note, group_id)
     VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?)`
  )
    .bind(
      game,
      login,
      await encryptSecret(password, env.ACCOUNT_ENC_KEY),
      cleanText(body?.note, 300),
      now(),
      cleanText(body?.email, 200),
      emailPassword ? await encryptSecret(emailPassword, env.ACCOUNT_ENC_KEY) : null,
      cleanText(body?.internalNote, 300),
      groupId
    )
    .run();

  // Which pools this login belongs to. `games` may list several — a Steam account
  // owns a library — and the home game is always included, since that column is
  // what the row is keyed by. Written as its own statement because the id is only
  // known after the insert.
  const games = [
    ...new Set([
      game,
      ...(Array.isArray(body?.games) ? body.games : [])
        .map((g) => cleanText(g, 50))
        .filter(Boolean),
    ]),
  ];
  for (const g of games) {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO steam_account_games (account_id, game)
         SELECT id, ? FROM steam_accounts WHERE game = ? AND login = ?`
      )
      .bind(g, game, login)
      .run();
  }

  return { status: 200, body: { ok: true, accounts: (await listAccounts(env, actor)).items } };
}

/**
 * Replaces which games an account's library covers.
 *
 * A whole-set write rather than add/remove calls: the admin panel edits a list, and
 * "these are the games" cannot leave a stale membership behind the way a missed
 * remove could. Never empty — an account in no pool is invisible to every query and
 * looks like it has vanished — so the home game is always kept.
 */
async function setAccountGames(env, actor, body) {
  const id = Number(body?.id);
  if (!Number.isFinite(id)) return bad('bad_id');
  const account = await env.DB
    .prepare(`SELECT id, game, login FROM steam_accounts WHERE id = ?`)
    .bind(id)
    .first();
  if (!account) return bad('unknown_account', 404);

  const wanted = [
    ...new Set([
      account.game,
      ...(Array.isArray(body?.games) ? body.games : []).map((g) => cleanText(g, 50)).filter(Boolean),
    ]),
  ].filter((g) => GAMES[g]);
  if (!wanted.length) return bad('no_games');

  const statements = [
    env.DB.prepare(`DELETE FROM steam_account_games WHERE account_id = ?`).bind(id),
    ...wanted.map((g) =>
      env.DB
        .prepare(`INSERT OR IGNORE INTO steam_account_games (account_id, game) VALUES (?, ?)`)
        .bind(id, g)
    ),
  ];
  // Atomic: a delete that landed without its inserts would drop the account out of
  // every pool.
  await env.DB.batch(statements);

  return { status: 200, body: { ok: true, id, games: wanted, accounts: (await listAccounts(env, actor)).items } };
}

async function updateAccount(env, actor, id, body) {
  const account = await env.DB.prepare(`SELECT * FROM steam_accounts WHERE id = ?`).bind(id).first();
  if (!account) return bad('unknown_account', 404);
  // 404 rather than 403 for a row outside the manager's groups: telling them it
  // exists would leak another group's inventory.
  if (!mayTouchAccount(actor, account)) return bad('unknown_account', 404);

  const sets = [];
  const binds = [];
  const push = (sql, value) => {
    sets.push(sql);
    binds.push(value);
  };

  if (body?.login !== undefined) {
    const login = cleanText(body.login, 100);
    if (!login) return bad('login_required');
    const clash = await env.DB.prepare(
      `SELECT id FROM steam_accounts WHERE game = ? AND login = ? AND id != ?`
    )
      .bind(account.game, login, id)
      .first();
    if (clash) return bad('duplicate_login', 409, { id: clash.id });
    push('login = ?', login);
  }
  if (body?.email !== undefined) push('email = ?', cleanText(body.email, 200));
  if (body?.note !== undefined) push('note = ?', cleanText(body.note, 300));
  if (body?.internalNote !== undefined) push('internal_note = ?', cleanText(body.internalNote, 300));
  if (body?.reservedFor !== undefined) {
    // Empty clears the hold. Stored lower-cased because allocation matches on it
    // case-insensitively, and a stored "Ha@X.com" would be a trap for anyone
    // reading the column directly.
    const raw = cleanText(body.reservedFor, 200);
    const email = raw ? raw.toLowerCase() : null;
    // Not a full address check — the customer's real address is whatever their
    // orders carry, and a strict regex here would only reject valid odd ones. But
    // something without an @ can never match a session email, so it is a typo.
    if (email && !email.includes('@')) return bad('reserved_for_not_an_email');
    push('reserved_for = ?', email);
  }

  if (body?.status !== undefined) {
    const status = String(body.status);
    // 'sold' means gone for good — the account left the rental business. Every
    // allocation query filters on 'available', so a sold account is never rented,
    // counted as stock, or reclaimed by an extension.
    if (!['available', 'rented', 'sold', 'disabled'].includes(status)) return bad('bad_status');
    // Moving an account anywhere other than 'rented' while a rental still holds it
    // would hand the same login to a second customer, or sell it from under the
    // renter.
    //
    // The active order is the only authority. This used to also require
    // `account.status === 'rented'`, which reads as a cheap short-circuit and is
    // exactly wrong: the status is unreliable precisely when it matters. A botched
    // UPDATE once left inasmX6543 on status '0' while a week-long rental was
    // running, so the check was skipped, the account went back to 'available', and
    // a second customer was sold the same login the next day.
    if (status !== 'rented') {
      const live = await env.DB.prepare(
        `SELECT order_code FROM orders WHERE account_id = ? AND status = 'active'`
      )
        .bind(id)
        .first();
      if (live) return bad('rental_active', 409, { orderCode: live.order_code });
    }
    push('status = ?', status);
  }

  // Empty string means "leave unchanged" — only a non-empty value re-encrypts.
  if (body?.password) {
    push('password_enc = ?', await encryptSecret(String(body.password), env.ACCOUNT_ENC_KEY));
  }
  // Same rule as the Steam password: "" means leave it alone, so a form that
  // always submits the field cannot silently wipe a stored mail password.
  // Clearing it deliberately is an explicit null.
  if (body?.emailPassword !== undefined && body.emailPassword !== '') {
    push(
      'email_password_enc = ?',
      body.emailPassword === null ? null : await encryptSecret(String(body.emailPassword), env.ACCOUNT_ENC_KEY)
    );
  }

  if (!sets.length) return bad('nothing_to_update');

  binds.push(id);
  await env.DB.prepare(`UPDATE steam_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  return { status: 200, body: { ok: true, accounts: (await listAccounts(env, actor)).items } };
}

async function deleteAccount(env, actor, id, force) {
  const account = await env.DB.prepare(`SELECT id, status, group_id FROM steam_accounts WHERE id = ?`)
    .bind(id)
    .first();
  if (!account) return bad('unknown_account', 404);
  if (!mayTouchAccount(actor, account)) return bad('unknown_account', 404);

  // Deleting an account someone is currently renting would strip the login from
  // a paying customer mid-rental, so it takes an explicit override.
  const live = await env.DB.prepare(
    `SELECT order_code, expires_at FROM orders WHERE account_id = ? AND status = 'active'`
  )
    .bind(id)
    .first();
  if (live && !force) {
    return bad('rental_active', 409, { orderCode: live.order_code, expiresAt: live.expires_at });
  }

  // Orders keep account_id only as a historical reference, so null it rather
  // than cascade-deleting — order history must survive.
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET account_id = NULL WHERE account_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM steam_accounts WHERE id = ?`).bind(id),
  ]);

  return { status: 200, body: { ok: true, accounts: (await listAccounts(env, actor)).items } };
}

/** Explicit, separate call — credentials never ride along with a listing. */
async function revealAccount(env, actor, id) {
  const row = await env.DB.prepare(
    `SELECT login, password_enc, email, email_password_enc, group_id FROM steam_accounts WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return bad('unknown_account', 404);
  // The most sensitive call in the panel — never serve another group's password.
  if (!mayTouchAccount(actor, row)) return bad('unknown_account', 404);

  try {
    return {
      status: 200,
      body: {
        login: row.login,
        password: await decryptSecret(row.password_enc, env.ACCOUNT_ENC_KEY),
        email: row.email ?? null,
        emailPassword: row.email_password_enc
          ? await decryptSecret(row.email_password_enc, env.ACCOUNT_ENC_KEY)
          : null,
      },
    };
  } catch {
    return bad('decrypt_failed', 500, {
      hint: 'ACCOUNT_ENC_KEY does not match the key this row was encrypted with',
    });
  }
}

/* ─── orders ──────────────────────────────────── */

async function listAllOrders(env, actor, query) {
  // A manager sees orders that used one of THEIR accounts. Orders with no
  // account yet (pending, or whose account was deleted) are shop-wide, so they
  // stay with the owner rather than leaking across groups.
  const where = scope(actor, 'a.group_id');
  const { limit, page, offset, q } = paging(query);

  // An order id is the thing customers quote, so a bare number matches the code
  // exactly rather than as a substring — searching "51523907" should not also
  // return every order whose code contains those digits. Anything else is treated
  // as text and matched against the customer's email and the account login, which
  // is how "who has account X?" gets answered.
  const numeric = /^\d+$/.test(q);
  const search = q
    ? numeric
      ? " AND (o.order_code = ? OR o.user_email LIKE ? ESCAPE '\\' OR a.login LIKE ? ESCAPE '\\')"
      : " AND (o.user_email LIKE ? ESCAPE '\\' OR a.login LIKE ? ESCAPE '\\')"
    : '';
  const searchBinds = q
    ? numeric
      ? [Number(q), likeTerm(q), likeTerm(q)]
      : [likeTerm(q), likeTerm(q)]
    : [];

  // Validated against a list rather than bound blindly: an unknown status would
  // otherwise return an empty table, which reads as "no such orders" instead of
  // "you asked for something that cannot exist".
  const rawStatus = typeof query?.status === 'string' ? query.status.trim() : '';
  if (rawStatus && !ORDER_STATUS_FILTERS.includes(rawStatus)) return { error: 'bad_status' };
  const statusFilter = rawStatus ? ' AND o.status = ?' : '';
  const statusBinds = rawStatus ? [rawStatus] : [];

  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
      WHERE 1 = 1${where.sql}${search}${statusFilter}`
  )
    .bind(...where.binds, ...searchBinds, ...statusBinds)
    .first();

  const rows = await env.DB.prepare(
    `SELECT o.*, a.login AS account_login, a.group_id AS account_group
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
      WHERE 1 = 1${where.sql}${search}${statusFilter}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...where.binds, ...searchBinds, ...statusBinds, limit, offset)
    .all();
  const meta = pageMeta({ total: Number(counted?.n ?? 0), limit, page });

  const items = (rows?.results ?? []).map((o) => ({
    orderCode: o.order_code,
    userKey: o.user_key,
    userEmail: o.user_email ?? null,
    game: o.game,
    planId: o.plan_id,
    hours: o.hours,
    amount: o.amount,
    status: o.status,
    // Shop-side note on the order (why it was refunded, what was agreed). Never
    // shown to the customer — see migrations/0015_order_refund_note.sql.
    note: o.note ?? null,
    accountLogin: o.account_login ?? null,
    extendsOrder: o.extends_order ?? null,
    createdAt: o.created_at,
    paidAt: o.paid_at ?? null,
    expiresAt: o.expires_at ?? null,
  }));
  return { items, meta };
}

async function summary(env, actor) {
  if (isOwner(actor)) {
    return (
      (await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM steam_accounts) AS accounts,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'available') AS available,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'rented') AS rented,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'sold') AS sold,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'disabled') AS disabled,
           (SELECT COUNT(*) FROM orders WHERE status = 'active') AS activeRentals,
           (SELECT COUNT(*) FROM orders WHERE status = 'awaiting_stock') AS awaitingStock,
           (SELECT COUNT(*) FROM orders WHERE status = 'active'
              AND expires_at > strftime('%s','now')
              AND expires_at <= strftime('%s','now') + 86400) AS expiringSoon,
           (SELECT COUNT(*) FROM account_reports WHERE status = 'open') AS openReports,
           (SELECT COALESCE(SUM(amount), 0) FROM orders
             WHERE paid_at IS NOT NULL${revenueStatusSql()}) AS revenue,
           -- Shown beside it: money that came in and went back out. Without this the
           -- drop in revenue after a refund has no explanation on the page.
           (SELECT COALESCE(SUM(amount), 0) FROM orders
             WHERE paid_at IS NOT NULL AND status = 'refunded') AS refunded`
      ).first()) ?? {}
    );
  }

  // Manager: everything counted through their own groups, including revenue —
  // shop-wide takings are not theirs to see.
  const ids = actor?.groupIds ?? [];
  if (!ids.length) {
    return { accounts: 0, available: 0, rented: 0, sold: 0, disabled: 0, activeRentals: 0,
             awaitingStock: 0, expiringSoon: 0, openReports: 0, revenue: 0, refunded: 0 };
  }
  const list = ids.map(() => '?').join(', ');
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list})) AS accounts,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'available') AS available,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'rented') AS rented,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'sold') AS sold,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'disabled') AS disabled,
       (SELECT COUNT(*) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.status = 'active') AS activeRentals,
       (SELECT COUNT(*) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.status = 'awaiting_stock') AS awaitingStock,
       (SELECT COUNT(*) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.status = 'active'
           AND o.expires_at > strftime('%s','now')
           AND o.expires_at <= strftime('%s','now') + 86400) AS expiringSoon,
       (SELECT COUNT(*) FROM account_reports r JOIN steam_accounts a ON a.id = r.account_id
         WHERE a.group_id IN (${list}) AND r.status = 'open') AS openReports,
       (SELECT COALESCE(SUM(o.amount), 0) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.paid_at IS NOT NULL${revenueStatusSql('o.')}) AS revenue,
       (SELECT COALESCE(SUM(o.amount), 0) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.paid_at IS NOT NULL AND o.status = 'refunded') AS refunded`
  )
    .bind(...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids)
    .first();
  return row ?? {};
}

/* ─── groups & managers (owner only) ──────────── */

async function listGroups(env, actor) {
  const where = scope(actor, 'g.id');
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, g.note, g.created_at,
            (SELECT COUNT(*) FROM steam_accounts a WHERE a.group_id = g.id) AS accounts
       FROM account_groups g
      WHERE 1 = 1${where.sql}
      ORDER BY g.name`
  )
    .bind(...where.binds)
    .all();
  return (rows?.results ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    note: g.note ?? null,
    accounts: g.accounts,
    createdAt: g.created_at,
  }));
}

async function createGroup(env, body) {
  const name = cleanText(body?.name, 80);
  if (!name) return bad('name_required');
  const clash = await env.DB.prepare(`SELECT id FROM account_groups WHERE name = ?`).bind(name).first();
  if (clash) return bad('duplicate_group', 409, { id: clash.id });
  await env.DB.prepare(`INSERT INTO account_groups (name, note, created_at) VALUES (?, ?, ?)`)
    .bind(name, cleanText(body?.note, 200), now())
    .run();
  return { status: 200, body: { ok: true, groups: await listGroups(env, { role: 'owner' }) } };
}

async function deleteGroup(env, id) {
  const group = await env.DB.prepare(`SELECT id FROM account_groups WHERE id = ?`).bind(id).first();
  if (!group) return bad('unknown_group', 404);

  // Refuse while accounts still belong to it: silently orphaning them would make
  // them ungrouped and vanish from every manager's view.
  const held = await env.DB.prepare(`SELECT COUNT(*) AS n FROM steam_accounts WHERE group_id = ?`)
    .bind(id)
    .first();
  if ((held?.n ?? 0) > 0) return bad('group_not_empty', 409, { accounts: held.n });

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM manager_groups WHERE group_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM account_groups WHERE id = ?`).bind(id),
  ]);
  return { status: 200, body: { ok: true, groups: await listGroups(env, { role: 'owner' }) } };
}

async function listManagers(env) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.identity, m.label, m.created_at,
            (SELECT GROUP_CONCAT(g.name, ', ') FROM manager_groups mg
               JOIN account_groups g ON g.id = mg.group_id
              WHERE mg.manager_id = m.id) AS group_names,
            (SELECT GROUP_CONCAT(mg.group_id) FROM manager_groups mg WHERE mg.manager_id = m.id) AS group_ids
       FROM managers m
      ORDER BY m.identity`
  ).all();
  return (rows?.results ?? []).map((m) => ({
    id: m.id,
    identity: m.identity,
    label: m.label ?? null,
    groupNames: m.group_names ?? '',
    groupIds: m.group_ids ? String(m.group_ids).split(',').map(Number) : [],
    createdAt: m.created_at,
  }));
}

async function upsertManager(env, body) {
  const identity = cleanText(body?.identity, 200)?.toLowerCase();
  if (!identity) return bad('identity_required');

  const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.map(Number).filter(Number.isFinite) : [];
  if (groupIds.length) {
    const list = groupIds.map(() => '?').join(', ');
    const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM account_groups WHERE id IN (${list})`)
      .bind(...groupIds)
      .first();
    if ((found?.n ?? 0) !== groupIds.length) return bad('unknown_group', 404);
  }

  const existing = await env.DB.prepare(`SELECT id FROM managers WHERE identity = ?`).bind(identity).first();
  let managerId = existing?.id;
  if (managerId) {
    await env.DB.prepare(`UPDATE managers SET label = ? WHERE id = ?`)
      .bind(cleanText(body?.label, 100), managerId)
      .run();
  } else {
    await env.DB.prepare(`INSERT INTO managers (identity, label, created_at) VALUES (?, ?, ?)`)
      .bind(identity, cleanText(body?.label, 100), now())
      .run();
    managerId = (await env.DB.prepare(`SELECT id FROM managers WHERE identity = ?`).bind(identity).first())?.id;
  }

  const statements = [env.DB.prepare(`DELETE FROM manager_groups WHERE manager_id = ?`).bind(managerId)];
  for (const groupId of groupIds) {
    statements.push(
      env.DB
        .prepare(`INSERT INTO manager_groups (manager_id, group_id) VALUES (?, ?)`)
        .bind(managerId, groupId)
    );
  }
  await env.DB.batch(statements);

  return { status: 200, body: { ok: true, managers: await listManagers(env) } };
}

async function deleteManager(env, id) {
  const row = await env.DB.prepare(`SELECT id FROM managers WHERE id = ?`).bind(id).first();
  if (!row) return bad('unknown_manager', 404);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM manager_groups WHERE manager_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM managers WHERE id = ?`).bind(id),
  ]);
  return { status: 200, body: { ok: true, managers: await listManagers(env) } };
}

/* ─── routing ─────────────────────────────────── */

/**
 * Handles /api/admin/*. Re-checks admin rights itself, so no route can be
 * reached unauthorised even if the caller forgets.
 *
 * @returns {{ status: number, body: object }}
 */
export async function handleAdminRequest(env, { path, method, body, user, query }) {
  const actor = await resolveActor(env, user);

  // The one route anyone may call. It reveals only your own status.
  if (path === '/api/admin/session') {
    return {
      status: 200,
      body: {
        admin: Boolean(actor),
        role: actor?.role ?? null,
        email: user?.email ?? null,
        // A manager needs to know its scope to render sensibly.
        groupIds: actor?.groupIds ?? null,
      },
    };
  }

  if (!user) return bad('unauthorized', 401);
  if (!actor) return bad('forbidden', 403);
  if (!env.DB || !env.ACCOUNT_ENC_KEY) return bad('rentals_not_configured', 503);

  if (path === '/api/admin/summary' && method === 'GET') {
    return { status: 200, body: await summary(env, actor) };
  }

  // Fix an order by hand: change its status, and/or put a specific account on it.
  //
  // Three real situations had no remedy in the panel before: an order paid when the
  // pool was empty (awaiting_stock, account_id NULL), a customer holding an account
  // that later turned out to be banned, and accounts left 'rented' with no order
  // behind them. All three are "reassign or restate", which is what this does.
  const orderPatch = /^\/api\/admin\/orders\/(\d+)$/.exec(path);
  if (orderPatch && method === 'PATCH') {
    const code = Number(orderPatch[1]);
    const order = await env.DB.prepare(
      `SELECT o.*, a.group_id AS account_group, a.login AS account_login, a.status AS account_status
         FROM orders o
         LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.order_code = ?`
    )
      .bind(code)
      .first();
    if (!order) return bad('unknown_order', 404);

    // An order already holding one of the actor's accounts is theirs to fix. One
    // holding nothing is only theirs if they are assigning an account they own,
    // which is checked below — otherwise unassigned orders would be a hole in the
    // scoping.
    const ownsCurrent = order.account_id != null && mayTouchAccount(actor, { group_id: order.account_group });
    if (order.account_id != null && !ownsCurrent) return bad('forbidden', 403);

    const wantStatus = body?.status === undefined ? null : String(body.status);
    if (wantStatus !== null && !ORDER_STATUSES.includes(wantStatus)) {
      return bad('bad_status', 400, { allowed: ORDER_STATUSES });
    }
    const wantAccount = body?.accountId === undefined || body.accountId === null
      ? null
      : Number(body.accountId);
    if (wantAccount !== null && !Number.isFinite(wantAccount)) return bad('bad_account', 400);

    // Extra time on a rental that is ALREADY running. Distinct from `hours`, which
    // only sets the length of a fresh activation — there was previously no way to
    // give a live rental more time from here at all.
    let wantAddHours = null;
    if (body?.addHours !== undefined && body.addHours !== null && body.addHours !== '') {
      wantAddHours = Number(body.addHours);
      if (!Number.isFinite(wantAddHours) || wantAddHours <= 0) return bad('bad_add_hours', 400);
      wantAddHours = Math.min(Math.floor(wantAddHours), 24 * 90);
    }
    // Editable on its own: recording why an order was refunded should not require
    // touching its status again.
    const wantNote = body?.note === undefined ? null : cleanText(body.note, 500);
    if (wantStatus === null && wantAccount === null && wantAddHours === null && wantNote === null) {
      return bad('nothing_to_do', 400);
    }

    const ts = now();
    const statements = [];
    let assigned = null;

    if (wantAccount !== null && wantAccount !== order.account_id) {
      const account = await env.DB.prepare(
        `SELECT id, login, game, status, group_id, ban_state FROM steam_accounts WHERE id = ?`
      )
        .bind(wantAccount)
        .first();
      if (!account) return bad('unknown_account', 404);
      if (!mayTouchAccount(actor, account)) return bad('forbidden', 403);
      // Membership, not the home game: an account whose library covers the order's
      // game can serve it even when that is not the game it was imported under.
      const owns = await env.DB
        .prepare(`SELECT 1 AS ok FROM steam_account_games WHERE account_id = ? AND game = ?`)
        .bind(account.id, order.game)
        .first();
      if (!owns?.ok) return bad('wrong_game', 409, { game: account.game });

      // Today this shop handed two customers accounts that were locked by Steam.
      // Refuse by default; --force stays available for a deliberate override.
      if (account.ban_state === 'banned' && !body?.force) {
        return bad('account_banned', 409, { login: account.login, hint: 'pass force: true to override' });
      }

      // Claim it the same way checkout does — a nested SELECT inside one UPDATE —
      // so two admins (or an admin and a paying customer) cannot both take it.
      const claimed = await env.DB.prepare(
        `UPDATE steam_accounts SET status = 'rented'
          WHERE id = (SELECT id FROM steam_accounts
                       WHERE id = ? AND status = 'available'
                         AND NOT EXISTS (SELECT 1 FROM orders o
                                          WHERE o.account_id = steam_accounts.id AND o.status = 'active'))
          RETURNING id, login`
      )
        .bind(wantAccount)
        .first();
      if (!claimed) return bad('account_unavailable', 409, { status: account.status });
      assigned = claimed;

      // Hand the previous one back, but only if nothing else is live on it.
      if (order.account_id != null) {
        statements.push(
          env.DB.prepare(
            `UPDATE steam_accounts SET status = 'available'
              WHERE id = ? AND status = 'rented'
                AND NOT EXISTS (SELECT 1 FROM orders o
                                 WHERE o.account_id = ? AND o.status = 'active' AND o.order_code <> ?)`
          ).bind(order.account_id, order.account_id, code)
        );
      }
      statements.push(
        env.DB.prepare(`UPDATE orders SET account_id = ? WHERE order_code = ?`).bind(wantAccount, code)
      );
    }

    const finalAccount = wantAccount !== null ? wantAccount : order.account_id;

    if (wantAddHours !== null) {
      // Only a live rental has a clock to extend. Reactivating a lapsed one is the
      // `hours` field's job, and mixing both in one save would be ambiguous about
      // which won.
      if (order.status !== 'active' || (wantStatus !== null && wantStatus !== 'active')) {
        return bad('not_active', 409, { status: order.status, hint: 'activate it first, then add hours' });
      }
      // A purchase is stored with expires_at NULL precisely because it never ends.
      // Adding hours would give it an expiry and quietly take ownership away.
      if (order.expires_at == null) {
        return bad('no_expiry', 409, { hint: 'this order never expires (a purchase) — nothing to extend' });
      }
      // Extend from now if it already lapsed, so the customer gets the full time
      // rather than hours that were already spent.
      const base = order.expires_at > ts ? order.expires_at : ts;
      statements.push(
        env.DB.prepare(
          `UPDATE orders SET expires_at = ?, reminder_sent_at = NULL WHERE order_code = ?`
        ).bind(base + wantAddHours * 3600, code)
      );
    }

    if (wantStatus !== null && wantStatus !== order.status) {
      if (wantStatus === 'active') {
        // Activating without an account would tell the customer their rental is
        // ready and then show them nothing.
        if (finalAccount == null) return bad('needs_account', 409);
        // A paid-but-unstocked order has no expires_at, and one that lapsed has a
        // past one. Either way the clock starts now: the customer has been waiting,
        // so charging them for time they could not use is not on.
        const hours = Math.min(Math.max(Number(body?.hours) || order.hours || 24, 1), 24 * 90);
        const expiresAt =
          order.expires_at && order.expires_at > ts && order.status === 'active'
            ? order.expires_at
            : ts + hours * 3600;
        statements.push(
          env.DB.prepare(
            `UPDATE orders SET status = 'active', expires_at = ?, paid_at = COALESCE(paid_at, ?)
              WHERE order_code = ?`
          ).bind(expiresAt, ts, code)
        );
        // A fresh delivery is a fresh reminder cycle; the old marker would silence it.
        statements.push(
          env.DB.prepare(`UPDATE orders SET reminder_sent_at = NULL WHERE order_code = ?`).bind(code)
        );
      } else {
        statements.push(
          env.DB.prepare(`UPDATE orders SET status = ? WHERE order_code = ?`).bind(wantStatus, code)
        );
        // Ending an order releases its account unless it was just reassigned away.
        if (finalAccount != null && wantAccount === null) {
          statements.push(
            env.DB.prepare(
              `UPDATE steam_accounts SET status = 'available'
                WHERE id = ? AND status = 'rented'
                  AND NOT EXISTS (SELECT 1 FROM orders o
                                   WHERE o.account_id = ? AND o.status = 'active' AND o.order_code <> ?)`
            ).bind(finalAccount, finalAccount, code)
          );
        }
      }
    }

    if (wantNote !== null) {
      statements.push(
        env.DB.prepare(`UPDATE orders SET note = ? WHERE order_code = ?`).bind(wantNote || null, code)
      );
    }

    if (statements.length) await env.DB.batch(statements);

    const after = await env.DB.prepare(
      `SELECT o.order_code, o.status, o.expires_at, o.account_id, a.login AS account_login
         FROM orders o LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.order_code = ?`
    )
      .bind(code)
      .first();

    return {
      status: 200,
      body: {
        ok: true,
        order: {
          orderCode: after.order_code,
          status: after.status,
          expiresAt: after.expires_at ?? null,
          accountId: after.account_id ?? null,
          accountLogin: after.account_login ?? null,
        },
        assignedLogin: assigned?.login ?? null,
      },
    };
  }

  // One day's trading, as the shop reads it. Everything here is REVENUE, not
  // profit: nothing in the schema records what an account cost or what a manager's
  // cut is, so a margin cannot be derived and is not implied.
  if (path === '/api/admin/report' && method === 'GET') {
    // Vietnam local day. A UTC day boundary would cut the evening in half and move
    // sales into the wrong report.
    const TZ = '+7 hours';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(query?.date || '')) ? String(query.date) : null;
    const dayExpr = day ? '?' : `date('now', '${TZ}')`;
    const dayBinds = day ? [day] : [];

    const where = scope(actor, 'a.group_id');
    // A manager gets their groups only. Orders with no account cannot be attributed
    // to a group at all, so they stay owner-only rather than leaking shop-wide.
    const ownerWide = isOwner(actor);

    const rows = await env.DB.prepare(
      `SELECT
         CASE
           WHEN o.account_id IS NULL THEN NULL
           ELSE COALESCE(g.name, '')
         END AS group_name,
         o.account_id IS NULL AS undelivered,
         o.plan_id,
         o.amount,
         COALESCE(a.ban_state, '') = 'banned' AS on_banned
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
       LEFT JOIN account_groups g ON g.id = a.group_id
      WHERE o.paid_at IS NOT NULL${revenueStatusSql('o.')}
        AND date(o.paid_at, 'unixepoch', '${TZ}') = ${dayExpr}
        ${ownerWide ? '' : 'AND o.account_id IS NOT NULL'}${where.sql}`
    )
      .bind(...dayBinds, ...where.binds)
      .all();

    const orders = rows?.results ?? [];
    const buckets = new Map();
    const plans = new Map();
    let revenue = 0;
    let onBanned = 0;
    let bannedRevenue = 0;
    let undelivered = 0;
    let undeliveredRevenue = 0;

    for (const r of orders) {
      revenue += r.amount;
      // '' is a real account with no group — the shop's own stock. NULL means no
      // account was ever attached, which is a different problem entirely.
      const key = r.undelivered ? '__undelivered' : r.group_name || '__shop';
      const b = buckets.get(key) || { orders: 0, revenue: 0, onBanned: 0 };
      b.orders += 1;
      b.revenue += r.amount;
      if (r.on_banned) b.onBanned += 1;
      buckets.set(key, b);

      const pl = plans.get(r.plan_id) || { orders: 0, revenue: 0 };
      pl.orders += 1;
      pl.revenue += r.amount;
      plans.set(r.plan_id, pl);

      if (r.on_banned) {
        onBanned += 1;
        bannedRevenue += r.amount;
      }
      if (r.undelivered) {
        undelivered += 1;
        undeliveredRevenue += r.amount;
      }
    }

    const label = (key) =>
      key === '__shop' ? 'Kho shop (chưa phân nhóm)'
        : key === '__undelivered' ? 'Chưa giao được tài khoản'
        : key;

    const resolved = day
      ? day
      : (await env.DB.prepare(`SELECT date('now', '${TZ}') AS d`).first())?.d ?? null;

    return {
      status: 200,
      body: {
        date: resolved,
        scope: ownerWide ? 'all' : 'groups',
        totals: { orders: orders.length, revenue },
        // Sold but unusable, and paid but never delivered. Both inflate revenue
        // while being the opposite of a good day, so they are reported beside it
        // rather than left to be noticed.
        warnings: {
          onBannedAccounts: onBanned,
          onBannedRevenue: bannedRevenue,
          undelivered,
          undeliveredRevenue,
        },
        buckets: [...buckets.entries()]
          .map(([key, v]) => ({ key, label: label(key), ...v }))
          .sort((x, y) => y.revenue - x.revenue),
        plans: [...plans.entries()]
          .map(([plan, v]) => ({ plan, ...v }))
          .sort((x, y) => y.revenue - x.revenue),
      },
    };
  }

  if (path === '/api/admin/orders' && method === 'GET') {
    const listed = await listAllOrders(env, actor, query);
    if (listed.error) return bad(listed.error, 400, { allowed: ORDER_STATUS_FILTERS });
    return { status: 200, body: { orders: listed.items, page: listed.meta } };
  }

  // Rentals about to end, so the owner can rotate passwords / chase renewals
  // before the account frees up.
  if (path === '/api/admin/expiring' && method === 'GET') {
    // Sweep first: without it a rental that lapsed a minute ago is still
    // 'active' with expires_at in the past, so it would fall out of this list
    // AND not yet be in /expired — invisible in both.
    await sweepExpiredRentals(env.DB);

    const hours = Math.min(Math.max(Number(query?.hours) || 24, 1), 24 * 14);
    const until = now() + hours * 3600;
    const where = scope(actor, 'a.group_id');
    const rows = await env.DB.prepare(
      `SELECT o.order_code, o.user_key, o.user_email, o.plan_id, o.hours, o.expires_at,
              a.id AS account_id, a.login AS account_login, g.name AS group_name
         FROM orders o
         JOIN steam_accounts a ON a.id = o.account_id
         LEFT JOIN account_groups g ON g.id = a.group_id
        WHERE o.status = 'active' AND o.expires_at > ? AND o.expires_at <= ?${where.sql}
        ORDER BY o.expires_at ASC
        LIMIT 100`
    )
      .bind(now(), until, ...where.binds)
      .all();

    return {
      status: 200,
      body: {
        hours,
        expiring: (rows?.results ?? []).map((r) => ({
          orderCode: r.order_code,
          userEmail: r.user_email ?? null,
          userKey: r.user_key,
          planId: r.plan_id,
          rentedHours: r.hours,
          expiresAt: r.expires_at,
          accountId: r.account_id,
          accountLogin: r.account_login,
          groupName: r.group_name ?? null,
        })),
      },
    };
  }

  // Rentals that ended and still need their Steam password rotated, scoped the
  // same way as everything else.
  // Renter problem reports. Scoped like stock: a manager sees reports about their
  // own accounts only. An intruder report also carries the rotation command,
  // because that is the actual remedy.
  if (path === '/api/admin/reports' && method === 'GET') {
    const openOnly = query?.all !== '1';
    const where = scope(actor, 'a.group_id');
    const rows = await env.DB.prepare(
      `SELECT r.id, r.order_code, r.reason, r.message, r.status, r.created_at, r.updated_at,
              r.resolved_at, r.resolved_by, r.resolution, r.user_email, r.user_key,
              a.login AS account_login, a.id AS account_id, a.status AS account_status,
              a.ban_state, o.expires_at
         FROM account_reports r
         LEFT JOIN steam_accounts a ON a.id = r.account_id
         LEFT JOIN orders o ON o.order_code = r.order_code
        WHERE 1 = 1${openOnly ? " AND r.status = 'open'" : ''}${where.sql}
        ORDER BY r.status = 'open' DESC, r.created_at DESC
        LIMIT 100`
    )
      .bind(...where.binds)
      .all();

    return {
      status: 200,
      body: {
        telegram: telegramConfigured(env),
        reports: (rows?.results ?? []).map((r) => ({
          id: r.id,
          orderCode: r.order_code,
          reason: r.reason,
          reasonLabel: REPORT_REASONS[r.reason] || r.reason,
          urgent: URGENT_REASONS.has(r.reason),
          message: r.message ?? null,
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          resolvedAt: r.resolved_at ?? null,
          resolvedBy: r.resolved_by ?? null,
          resolution: r.resolution ?? null,
          userEmail: r.user_email ?? null,
          userKey: r.user_key,
          accountId: r.account_id ?? null,
          accountLogin: r.account_login ?? null,
          accountStatus: r.account_status ?? null,
          banState: r.ban_state ?? null,
          expiresAt: r.expires_at ?? null,
        })),
      },
    };
  }

  if (path === '/api/admin/reports/resolve' && method === 'POST') {
    const id = Number(body?.id);
    if (!Number.isFinite(id)) return bad('unknown_report', 404);

    // Re-read with the account attached so the group check is on real data rather
    // than on whatever the caller claimed.
    const row = await env.DB.prepare(
      `SELECT r.id, r.status, a.group_id
         FROM account_reports r
         LEFT JOIN steam_accounts a ON a.id = r.account_id
        WHERE r.id = ?`
    )
      .bind(id)
      .first();
    if (!row) return bad('unknown_report', 404);
    if (!mayTouchAccount(actor, { group_id: row.group_id })) return bad('forbidden', 403);
    if (row.status !== 'open') return bad('already_resolved', 409, { status: row.status });

    const ts = now();
    await env.DB.prepare(
      `UPDATE account_reports
          SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`
    )
      .bind(ts, user?.email ?? user?.sub ?? 'admin', cleanText(body?.resolution, 300), ts, id)
      .run();
    return { status: 200, body: { ok: true, id, resolvedAt: ts } };
  }

  if (path === '/api/admin/expired' && method === 'GET') {
    await sweepExpiredRentals(env.DB);
    const where = scope(actor, 'a.group_id');
    const rows = await env.DB.prepare(
      `SELECT o.order_code, o.user_key, o.user_email, o.plan_id, o.hours, o.expires_at,
              a.login AS account_login
         FROM orders o
         LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.status = 'expired' AND o.notified_at IS NULL${where.sql}
        ORDER BY o.expires_at DESC
        LIMIT 20`
    )
      .bind(...where.binds)
      .all();
    return {
      status: 200,
      body: {
        telegram: telegramConfigured(env),
        pending: (rows?.results ?? []).map((r) => ({
          orderCode: r.order_code,
          userEmail: r.user_email ?? null,
          userKey: r.user_key,
          planId: r.plan_id,
          hours: r.hours,
          expiresAt: r.expires_at,
          accountLogin: r.account_login ?? null,
        })),
      },
    };
  }

  /* ── groups: readable by a manager (they need the names), writable by owner ── */

  if (path === '/api/admin/groups') {
    if (method === 'GET') return { status: 200, body: { groups: await listGroups(env, actor) } };
    if (method === 'POST') {
      if (!isOwner(actor)) return bad('owner_only', 403);
      return createGroup(env, body);
    }
    return bad('method_not_allowed', 405);
  }

  const groupMatch = /^\/api\/admin\/groups\/(\d+)$/.exec(path);
  if (groupMatch) {
    if (!isOwner(actor)) return bad('owner_only', 403);
    if (method !== 'DELETE') return bad('method_not_allowed', 405);
    return deleteGroup(env, Number(groupMatch[1]));
  }

  /* ── managers: owner only, always ── */

  if (path === '/api/admin/managers') {
    if (!isOwner(actor)) return bad('owner_only', 403);
    if (method === 'GET') return { status: 200, body: { managers: await listManagers(env) } };
    if (method === 'POST' || method === 'PATCH') return upsertManager(env, body);
    return bad('method_not_allowed', 405);
  }

  const managerMatch = /^\/api\/admin\/managers\/(\d+)$/.exec(path);
  if (managerMatch) {
    if (!isOwner(actor)) return bad('owner_only', 403);
    if (method !== 'DELETE') return bad('method_not_allowed', 405);
    return deleteManager(env, Number(managerMatch[1]));
  }

  /* ── accounts ── */

  if (path === '/api/admin/game-requests' && method === 'GET') {
    // Owner-only: a manager's scope is their own accounts, and a game nobody
    // stocks yet belongs to no group.
    if (!isOwner(actor)) return bad('forbidden', 403);
    return { status: 200, body: { items: await listGameRequests(env) } };
  }

  if (path === '/api/admin/game-requests/reply' && method === 'POST') {
    if (!isOwner(actor)) return bad('forbidden', 403);
    return replyToGameRequests(env, body);
  }

  if (path === '/api/admin/accounts/games' && method === 'POST') {
    return setAccountGames(env, actor, body);
  }

  if (path === '/api/admin/accounts') {
    if (method === 'GET') {
      const listed = await listAccounts(env, actor, query);
      if (listed.error) return bad(listed.error, 400);
      return { status: 200, body: { accounts: listed.items, page: listed.meta } };
    }
    if (method === 'POST') return createAccount(env, actor, body);
    return bad('method_not_allowed', 405);
  }

  const match = /^\/api\/admin\/accounts\/(\d+)(\/reveal)?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    if (match[2]) {
      if (method !== 'POST') return bad('method_not_allowed', 405);
      return revealAccount(env, actor, id);
    }
    if (method === 'PATCH' || method === 'POST') return updateAccount(env, actor, id, body);
    if (method === 'DELETE') return deleteAccount(env, actor, id, query?.force === '1');
    return bad('method_not_allowed', 405);
  }

  return bad('not_found', 404);
}
