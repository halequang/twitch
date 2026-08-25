/**
 * "Please rent this game too": customer demand for games the shop does not carry.
 *
 * Shaped after src/lib/reports.js — a customer-submitted row, an admin who reads and
 * answers it, a best-effort Telegram ping on top — because the reasoning is the
 * same: a chat message nobody read is lost, and this one needs to be COUNTED. The
 * useful question is not who asked but which game the most customers want next.
 *
 * The admin side (tally and reply) lives in src/lib/admin.js, next to the other
 * admin queries.
 */

import { sendGameRequestNotice, telegramConfigured } from './notify.js';
import { GAMES } from '../data/rental-plans.js';

/** What the shop can say about a request. Keys are stored; labels are shown. */
export const GAME_REQUEST_STATUSES = {
  open: 'Đang xem xét',
  planned: 'Sắp có',
  added: 'Đã có — thuê được rồi',
  declined: 'Chưa thể phục vụ',
};

const now = () => Math.floor(Date.now() / 1000);

const MAX_NAME = 60;
const MAX_NOTE = 400;
// Enough for anyone with a real wishlist, few enough that the table cannot be
// filled from one account.
const MAX_OPEN_PER_USER = 5;

/** Trim, strip control characters, cap length. Mirrors cleanText in reports.js. */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const clean = Array.from(value)
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 31 || c === 10 || c === 9; // keep newlines and tabs
    })
    .join('')
    .trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * The counting key for a game name.
 *
 * Letters and digits only, lower-cased, so "PoE 2", "poe2" and "Poe-2" are one game.
 * Accents are kept as-is: Vietnamese input is normal here, and folding them would
 * merge names that are genuinely different more often than it would help.
 */
export function gameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A game already in the catalogue, matched loosely by name or id. */
function alreadyRentable(name) {
  const key = gameKey(name);
  if (!key) return null;
  for (const [id, game] of Object.entries(GAMES)) {
    if (gameKey(id) === key || gameKey(game.name) === key) return { id, ...game };
  }
  return null;
}

/**
 * Records a request from the caller.
 *
 * @returns {{ status: number, body: object }}
 */
export async function submitGameRequest(env, user, { gameName, note }) {
  const db = env?.DB;
  if (!db) return { status: 503, body: { error: 'rentals_not_configured' } };

  const name = cleanText(gameName, MAX_NAME);
  if (!name) return { status: 400, body: { error: 'game_name_required' } };
  const key = gameKey(name);
  // A name of nothing but punctuation normalises to an empty key, which would then
  // collide with every other such name under the unique index.
  if (!key) return { status: 400, body: { error: 'game_name_required' } };

  // Already on sale: the customer wants something they can have right now, so say so
  // and point at it instead of filing demand for it.
  const existing = alreadyRentable(name);
  if (existing) {
    return {
      status: 409,
      body: { error: 'already_rentable', game: existing.id, name: existing.name, path: existing.path },
    };
  }

  const key_ = `${user.provider}:${user.sub}`;
  const text = cleanText(note, MAX_NOTE);
  const ts = now();

  // A second ask for the same game is an edit, not a second vote — the unique index
  // enforces it, and this makes the update the intended path rather than an error the
  // customer has to see.
  const mine = await db
    .prepare(`SELECT id, status FROM game_requests WHERE user_key = ? AND game_key = ?`)
    .bind(key_, key)
    .first();

  if (mine) {
    await db
      // The note is only ever filled in, never blanked: the form posts both fields,
      // so resubmitting from a fresh page — where the note box starts empty — would
      // otherwise silently throw away what they wrote the first time. The name does
      // get overwritten, so the newest spelling is the one the shop sees.
      .prepare(`UPDATE game_requests SET game_name = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?`)
      .bind(name, text, ts, mine.id)
      .run();
    return { status: 200, body: { ok: true, id: mine.id, updated: true, status: mine.status } };
  }

  // Counted over open ones only: a customer whose earlier asks were answered should
  // not be locked out of asking again.
  const open = await db
    .prepare(`SELECT COUNT(*) AS n FROM game_requests WHERE user_key = ? AND status = 'open'`)
    .bind(key_)
    .first();
  if ((open?.n ?? 0) >= MAX_OPEN_PER_USER) {
    return { status: 429, body: { error: 'too_many_open', max: MAX_OPEN_PER_USER } };
  }

  const row = await db
    .prepare(
      `INSERT INTO game_requests
         (user_key, user_email, game_name, game_key, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
       RETURNING id`
    )
    .bind(key_, user.email ?? null, name, key, text, ts, ts)
    .first();

  // How many people have now asked for this game — the number that decides whether
  // it is worth buying accounts for, so it goes in the notice rather than making the
  // owner query for it.
  const tally = await db
    .prepare(`SELECT COUNT(*) AS n FROM game_requests WHERE game_key = ?`)
    .bind(key)
    .first();

  let notified = false;
  if (telegramConfigured(env)) {
    try {
      notified = await sendGameRequestNotice(env, {
        name,
        note: text,
        userEmail: user.email ?? null,
        total: tally?.n ?? 1,
      });
    } catch {
      // Best-effort on top of the row: a failed send must not lose the request or
      // tell the customer their ask did not go through.
      notified = false;
    }
  }

  return { status: 200, body: { ok: true, id: row?.id ?? null, updated: false, total: tally?.n ?? 1, notified } };
}

/** The caller's own requests, so the page can show what they asked and any reply. */
export async function listOwnGameRequests(env, user) {
  const db = env?.DB;
  if (!db) return [];
  const key = `${user.provider}:${user.sub}`;
  const rows = await db
    .prepare(
      `SELECT r.id, r.game_name, r.game_key, r.note, r.status, r.created_at, r.reply, r.replied_at,
              (SELECT COUNT(*) FROM game_requests o WHERE o.game_key = r.game_key) AS total
         FROM game_requests r
        WHERE r.user_key = ?
        ORDER BY r.created_at DESC
        LIMIT 20`
    )
    .bind(key)
    .all();
  return (rows?.results ?? []).map((r) => ({
    id: r.id,
    name: r.game_name,
    note: r.note ?? null,
    status: r.status,
    statusLabel: GAME_REQUEST_STATUSES[r.status] || r.status,
    // Shown back to the asker: "3 người cũng muốn game này" is the answer to "did
    // anyone else care", which is what makes the form feel worth using.
    total: Number(r.total ?? 1),
    createdAt: r.created_at,
    reply: r.reply ?? null,
    repliedAt: r.replied_at ?? null,
  }));
}
