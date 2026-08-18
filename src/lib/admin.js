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

import { decryptSecret, encryptSecret } from './rentals.js';
import { DEFAULT_GAME } from '../data/rental-plans.js';
import { pendingExpiryNotices, telegramConfigured } from './notify.js';

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
  a.id, a.game, a.login, a.email, a.note, a.internal_note, a.status, a.created_at,
  (a.email_password_enc IS NOT NULL) AS has_email_password,
  a.group_id, g.name AS group_name,
  o.order_code AS rented_order, o.user_key AS rented_by, o.user_email AS rented_email,
  o.expires_at AS rented_until`;

const ACCOUNT_FROM = `
  FROM steam_accounts a
  LEFT JOIN account_groups g ON g.id = a.group_id
  LEFT JOIN orders o ON o.account_id = a.id AND o.status = 'active'`;

async function listAccounts(env, actor) {
  const where = scope(actor, 'a.group_id');
  const rows = await env.DB.prepare(
    `SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM} WHERE 1 = 1${where.sql} ORDER BY a.id`
  )
    .bind(...where.binds)
    .all();
  return (rows?.results ?? []).map((r) => ({
    id: r.id,
    groupId: r.group_id ?? null,
    groupName: r.group_name ?? null,
    game: r.game,
    login: r.login,
    email: r.email ?? null,
    note: r.note ?? null,
    internalNote: r.internal_note ?? null,
    status: r.status,
    createdAt: r.created_at,
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

  return { status: 200, body: { ok: true, accounts: await listAccounts(env, actor) } };
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

  if (body?.status !== undefined) {
    const status = String(body.status);
    if (!['available', 'rented', 'disabled'].includes(status)) return bad('bad_status');
    // Freeing an account while a rental still holds it would hand the same login
    // to a second customer.
    if (status === 'available' && account.status === 'rented') {
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

  return { status: 200, body: { ok: true, accounts: await listAccounts(env, actor) } };
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

  return { status: 200, body: { ok: true, accounts: await listAccounts(env, actor) } };
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

async function listAllOrders(env, actor, limit) {
  // A manager sees orders that used one of THEIR accounts. Orders with no
  // account yet (pending, or whose account was deleted) are shop-wide, so they
  // stay with the owner rather than leaking across groups.
  const where = scope(actor, 'a.group_id');
  const rows = await env.DB.prepare(
    `SELECT o.*, a.login AS account_login, a.group_id AS account_group
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
      WHERE 1 = 1${where.sql}
      ORDER BY o.created_at DESC
      LIMIT ?`
  )
    .bind(...where.binds, Math.min(Number(limit) || 100, 500))
    .all();

  return (rows?.results ?? []).map((o) => ({
    orderCode: o.order_code,
    userKey: o.user_key,
    userEmail: o.user_email ?? null,
    game: o.game,
    planId: o.plan_id,
    hours: o.hours,
    amount: o.amount,
    status: o.status,
    accountLogin: o.account_login ?? null,
    extendsOrder: o.extends_order ?? null,
    createdAt: o.created_at,
    paidAt: o.paid_at ?? null,
    expiresAt: o.expires_at ?? null,
  }));
}

async function summary(env, actor) {
  if (isOwner(actor)) {
    return (
      (await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM steam_accounts) AS accounts,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'available') AS available,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'rented') AS rented,
           (SELECT COUNT(*) FROM steam_accounts WHERE status = 'disabled') AS disabled,
           (SELECT COUNT(*) FROM orders WHERE status = 'active') AS activeRentals,
           (SELECT COUNT(*) FROM orders WHERE status = 'awaiting_stock') AS awaitingStock,
           (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE paid_at IS NOT NULL) AS revenue`
      ).first()) ?? {}
    );
  }

  // Manager: everything counted through their own groups, including revenue —
  // shop-wide takings are not theirs to see.
  const ids = actor?.groupIds ?? [];
  if (!ids.length) {
    return { accounts: 0, available: 0, rented: 0, disabled: 0, activeRentals: 0, awaitingStock: 0, revenue: 0 };
  }
  const list = ids.map(() => '?').join(', ');
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list})) AS accounts,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'available') AS available,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'rented') AS rented,
       (SELECT COUNT(*) FROM steam_accounts WHERE group_id IN (${list}) AND status = 'disabled') AS disabled,
       (SELECT COUNT(*) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.status = 'active') AS activeRentals,
       (SELECT COUNT(*) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.status = 'awaiting_stock') AS awaitingStock,
       (SELECT COALESCE(SUM(o.amount), 0) FROM orders o JOIN steam_accounts a ON a.id = o.account_id
         WHERE a.group_id IN (${list}) AND o.paid_at IS NOT NULL) AS revenue`
  )
    .bind(...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids)
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

  if (path === '/api/admin/orders' && method === 'GET') {
    return { status: 200, body: { orders: await listAllOrders(env, actor, query?.limit) } };
  }

  // Rentals that ended and still need their Steam password rotated, scoped the
  // same way as everything else.
  if (path === '/api/admin/expired' && method === 'GET') {
    const where = scope(actor, 'a.group_id');
    const rows = await env.DB.prepare(
      `SELECT o.order_code, o.user_key, o.user_email, o.plan_id, o.hours, o.expires_at,
              a.login AS account_login
         FROM orders o
         LEFT JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.status = 'expired' AND o.notified_at IS NULL${where.sql}
        ORDER BY o.expires_at DESC
        LIMIT 50`
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

  if (path === '/api/admin/accounts') {
    if (method === 'GET') return { status: 200, body: { accounts: await listAccounts(env, actor) } };
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
