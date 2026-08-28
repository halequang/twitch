/**
 * Rental catalogue. Prices are in VND (PayOS settles in VND only).
 *
 * Edit freely — `id` is what gets written into the orders table, so keep ids
 * stable once real orders exist. Existing orders snapshot their own hours and
 * amount, so changing a price here never rewrites a past order.
 */

export const GAMES = {
  'the-isle': {
    name: 'The Isle',
    // The public page for this game. Defined here so the Worker route, the payOS
    // return/cancel URLs and the Apple redirect URI cannot drift apart.
    path: '/thuegame/theisle',
    kicker: 'Dịch vụ cho thuê',
    subtitle: 'Survival Dinosaur',
    blurb: 'Trải nghiệm cuộc sống khủng long chân thực',
    tagline: 'Săn mồi — Sinh tồn — Chinh phục hòn đảo',
    motto: 'Survive. Hunt. Rule the Isle.',
    // Page-level trimmings. In data rather than in the template because one page
    // now serves every game (src/pages/thuegame/[game].astro), so anything that
    // differs per game has to be readable from here.
    flourish: '🦎',
    theme: { bg: '#0c1a10', bg2: '#101f14', line: '#2c4a2f', accent: '#7fae63' },
    // The one limitation that can make renting the wrong choice, so the page puts
    // it ABOVE the plan cards rather than in small print underneath.
    warning: {
      title: '⚠ LƯU Ý',
      body: 'Acc cho thuê **không hỗ trợ đăng nhập qua trang web hoặc PM bên thứ 3** '
        + 'để sử dụng voice chat hoặc các tính năng custom khác, tùy server khác nhau.',
      advice: '👉 Ae nào muốn chơi những server bắt buộc sử dụng voice thì mình khuyên '
        + '**nên mua acc luôn** để chơi cho thoải mái nhé!',
    },
    features: [
      'Acc chính chủ Steam',
      'Chơi được mọi server',
      'Bàn giao nhanh < 5 phút',
      'Hỗ trợ setup từ A đến Z',
      'Không giới hạn giờ chơi',
      'Bảo hành trong suốt gói thuê',
    ],
    // The page shows one card per DURATION, and the plans inside it as the choice
    // between account kinds. Grouping lives here rather than in the template because
    // it is a pricing decision — which plans are alternatives to each other — and
    // the template should only lay out what the catalogue already says.
    //
    // `plans` stays a flat list of real, separately-buyable plans: ids are what
    // orders record, stock is counted per plan, and checkout knows nothing about
    // cards. A group is presentation over that list, not a thing you can buy.
    groups: [
      { id: 'day', kicker: 'Gói thử nghiệm', label: '1 ngày', icon: '🦴' },
      {
        id: 'week',
        kicker: 'Gói khuyến nghị',
        label: '1 tuần',
        icon: '🦖',
        badge: '🔥 Tiết kiệm',
        featured: true,
      },
    ],
    plans: [
      {
        id: 'isle-1d',
        group: 'day',
        // The name of this option INSIDE its card. `label` stays the plan's own
        // full name, because that is what an order description, an addon button and
        // an upgrade button all print, none of which have a card around them.
        variant: 'Thường',
        label: '1 ngày',
        icon: '🦴',
        hours: 24,
        amount: 15000,
        note: 'Acc chuẩn, chơi mọi server',
      },
      {
        // Same day, on stock vetted as never banned (the no_ban tag). Dearer because
        // that stock is scarce and is what a customer burned by a ban comes back for.
        id: 'isle-1d-noban',
        group: 'day',
        variant: 'VOIP + MAP',
        label: '1 ngày no-ban',
        icon: '🛡️',
        hours: 24,
        amount: 25000,
        note: 'Nói chuyện & xem map trong game',
      },
      {
        id: 'isle-7d',
        group: 'week',
        variant: 'Thường',
        label: '1 tuần',
        icon: '🦖',
        hours: 24 * 7,
        amount: 50000,
        note: 'Chỉ ~7k / ngày — rẻ hơn 65%',
      },
      {
        // Same week, with the in-game extras. `perks` is what the card renders as
        // the "đặc quyền" box — without it this would be a second week plan at a
        // higher price and no visible reason for it.
        id: 'isle-7d-voip',
        group: 'week',
        variant: 'VOIP + MAP',
        label: '1 tuần',
        icon: '🎙️',
        hours: 24 * 7,
        amount: 80000,
        note: 'Nói chuyện & xem map trong game',
        perks: ['VOIP', 'MAP'],
      },
    ],
    // Buying the account outright instead of renting it. Offered to a customer who
    // already holds one: that exact login becomes theirs and leaves the pool for
    // good. Kept out of `plans` so it does not become a third pricing card — it is
    // only reachable from a rental you already have.
    purchase: {
      id: 'isle-buy',
      label: 'Mua acc này',
      icon: '👑',
      // No duration. A purchase never expires, and hours: 0 keeps the orders
      // table's NOT NULL column honest rather than inventing a fake period.
      hours: 0,
      amount: 220000,
      purchase: true,
      note: 'Sở hữu vĩnh viễn · bàn giao cả email',
    },
  },

  poe2: {
    name: 'Path of Exile 2',
    path: '/thuegame/poe2',
    kicker: 'Dịch vụ cho thuê',
    subtitle: 'Action RPG',
    blurb: 'Cày build, farm map, leo ladder trên acc sẵn sàng',
    tagline: 'Săn boss — Farm currency — Leo ladder',
    motto: 'Exile. Endure. Ascend.',
    flourish: '⚡',
    theme: { bg: '#120e1c', bg2: '#171126', line: '#3b2f5c', accent: '#9d7bd8' },
    features: [
      'Acc chính chủ Steam',
      'Early Access sẵn sàng',
      'Bàn giao nhanh < 5 phút',
      'Hỗ trợ setup từ A đến Z',
      'Không giới hạn giờ chơi',
      'Bảo hành trong suốt gói thuê',
    ],
    groups: [
      { id: 'day', kicker: 'Gói thử nghiệm', label: '1 ngày', icon: '🧪' },
      {
        id: 'week',
        kicker: 'Gói khuyến nghị',
        label: '1 tuần',
        icon: '⚔️',
        badge: '🔥 Tiết kiệm',
        featured: true,
      },
    ],
    plans: [
      {
        id: 'poe2-1d',
        group: 'day',
        variant: 'Thường',
        label: '1 ngày',
        icon: '🧪',
        hours: 24,
        amount: 15000,
        note: 'Acc chuẩn, chơi mọi server',
      },
      {
        id: 'poe2-1d-noban',
        group: 'day',
        variant: 'No-ban',
        label: '1 ngày no-ban',
        icon: '🛡️',
        hours: 24,
        amount: 25000,
        note: 'Acc đã kiểm tra sạch ban',
      },
      {
        id: 'poe2-7d',
        group: 'week',
        variant: 'Thường',
        label: '1 tuần',
        icon: '⚔️',
        hours: 24 * 7,
        amount: 50000,
        note: 'Chỉ ~7k / ngày — rẻ hơn 65%',
      },
    ],
    purchase: {
      id: 'poe2-buy',
      label: 'Mua acc này',
      icon: '👑',
      hours: 0,
      amount: 190000,
      purchase: true,
      note: 'Sở hữu vĩnh viễn · bàn giao cả email',
    },
  },
};

/**
 * The game a plan id belongs to, or null.
 *
 * Needed because a second-game rental picks its game BY the plan the customer
 * clicked, so the plan has to be able to name its own game rather than the caller
 * being trusted to pass a matching pair.
 */
export function gameOfPlan(planId) {
  for (const [id, game] of Object.entries(GAMES)) {
    if (game.purchase?.id === planId) return id;
    if (game.plans.some((p) => p.id === planId)) return id;
  }
  return null;
}

/** Every game the shop rents, in catalogue order. */
export function gameIds() {
  return Object.keys(GAMES);
}

/** The URL slug a game's page is served at ('the-isle' → 'theisle'). */
export function gameSlug(gameId) {
  return String(GAMES[gameId]?.path || '').split('/').filter(Boolean).pop() || gameId;
}

/** The game a slug belongs to, or null. Reverse of gameSlug. */
export function gameFromSlug(slug) {
  return gameIds().find((id) => gameSlug(id) === slug) ?? null;
}

/**
 * Accounts tagged in `internal_note` may only be rented on the plans listed here.
 *
 * The tag is how the shop marks a special account — "no_ban" being one that has
 * never been banned, worth holding back for the plan people pay most for. This map
 * is what makes that marking mean something at allocation time instead of being a
 * note nobody enforces.
 *
 * Deliberately keyed off the existing internal_note rather than a new column: the
 * note is what gets written when the account is imported, so there is no second
 * place to keep in sync, and no migration to apply before it works.
 *
 * Matching is on a whole token, so an internal note reading "no_ban_check" or
 * "maybe no_bans" does NOT count — a substring match would quietly restrict
 * accounts nobody meant to restrict.
 */
export const TAG_ONLY_PLANS = {
  no_ban: ['isle-7d-voip', 'isle-1d-noban', 'poe2-1d-noban'],
};

/**
 * Tags a plan REQUIRES, not merely prefers. An account without every tag listed
 * here can never fulfil that plan.
 *
 * TAG_ONLY_PLANS above is the other direction — it holds tagged accounts back FOR
 * a plan. On its own that still let a VOIP week be filled from the untagged pool
 * whenever no_ban stock ran dry, which is the one thing that plan cannot do: its
 * perks mean signing in on a server's own site, and an account nobody has verified
 * is exactly what fails there.
 */
export const PLAN_REQUIRED_TAGS = {
  'isle-7d-voip': ['no_ban'],
  // The whole product of the dearer day plan is the vetted account, so an untagged
  // one must never fill it — a "no-ban" rental served from unvetted stock is the
  // one thing that sells this plan and the one thing it cannot do.
  'isle-1d-noban': ['no_ban'],
  'poe2-1d-noban': ['no_ban'],
};

/** Tags without which this plan cannot be fulfilled at all. */
export function tagsRequiredBy(planId) {
  return PLAN_REQUIRED_TAGS[planId] ?? [];
}

/** Tags that must NOT be handed to this plan. */
export function tagsBarredFrom(planId) {
  return Object.entries(TAG_ONLY_PLANS)
    .filter(([, plans]) => !plans.includes(planId))
    .map(([tag]) => tag);
}

/** Tags this plan is the intended home for, so they can be preferred for it. */
export function tagsPreferredBy(planId) {
  return Object.entries(TAG_ONLY_PLANS)
    .filter(([, plans]) => plans.includes(planId))
    .map(([tag]) => tag);
}

/**
 * Punctuation that separates a tag from the words around it in the free-text
 * internal_note. Lives here rather than in lib/rentals.js because both the SQL
 * builder and noteHasTag() below read from it: the note "(day 2, no_ban)" must not
 * count as tagged in one place and untagged in the other.
 */
export const TAG_SEPARATORS = ['·', ',', ';', '|', '(', ')', '[', ']', '{', '}', '/', '\\', '"', "'", '\t', '\n', '\r'];

/**
 * Whole-token tag test — the JS twin of tagMatch() in lib/rentals.js, for the
 * places that already hold the note in hand and would otherwise re-query D1.
 *
 * Separators become spaces and the note is padded, so "bought day 2 · no_ban"
 * matches while "no_ban_check" and "no_bans" — different words — do not. Case is
 * folded to match SQLite's LIKE, which ignores it for ASCII.
 */
export function noteHasTag(note, tag) {
  const separators = new Set(TAG_SEPARATORS);
  const normalised = Array.from(String(note ?? '').toLowerCase(), (ch) =>
    separators.has(ch) ? ' ' : ch
  ).join('');
  return ` ${normalised} `.includes(` ${String(tag).toLowerCase()} `);
}

/**
 * Tags an account must carry before the buy-out is offered on it.
 *
 * Selling is final in a way renting is not — the customer gets the mailbox, so the
 * account is gone from the pool for good. Only the accounts already vetted as
 * never-banned are worth parting with; the rest stay rental stock, and the
 * "Mua acc này" button is left off them entirely rather than shown and then
 * refused at checkout.
 *
 * This is a separate list from PLAN_REQUIRED_TAGS on purpose: a purchase takes over
 * the account the customer already holds instead of claiming one from the pool, so
 * it never goes through the allocator those tags filter.
 */
export const SALE_REQUIRED_TAGS = ['no_ban'];

/** Whether this account may be sold outright, judged from its internal_note. */
export function saleAllowed(internalNote) {
  return SALE_REQUIRED_TAGS.every((tag) => noteHasTag(internalNote, tag));
}

/**
 * Where a rental can move once it is running: cheaper plan → dearer plan, never
 * the other way.
 *
 * Written out rather than derived from price, because "dearer" is not the same
 * question as "a sensible upgrade". Both weeks cost more than the day, so both are
 * offered to it; the VOIP week costs more than the plain week, so the plain week is
 * offered it. Nothing is offered to the VOIP week — it is the top of the ladder —
 * and a downgrade is absent on purpose: it would owe the customer money back, which
 * payOS cannot do from here.
 *
 * Keys and values are plan ids, so a plan renamed here must be renamed in `plans`
 * above too; ids are stable once real orders exist, which is what makes that safe.
 */
export const PLAN_UPGRADES = {
  'isle-1d': ['isle-7d', 'isle-7d-voip'],
  // Only the VOIP week. The plain week is dearer than this plan, so it looks like an
  // upgrade, but it would leave a vetted account running at the untagged price —
  // the same thing the extension rule refuses. Up from vetted stock is vetted stock.
  'isle-1d-noban': ['isle-7d-voip'],
  'isle-7d': ['isle-7d-voip'],
};

/** The plans this one can be moved up to. */
export function upgradesFrom(planId) {
  return PLAN_UPGRADES[planId] ?? [];
}

/** Whether this exact move is allowed. Checked server-side on every checkout. */
export function upgradeAllowed(fromPlanId, toPlanId) {
  return upgradesFrom(fromPlanId).includes(toPlanId);
}

/**
 * Whether the account a customer is already holding can carry this plan.
 *
 * Only REQUIRED tags count. A barred tag is not asked about on purpose: barring
 * exists to stop a good account being *spent* on a cheap plan, and it is no reason
 * to take one away from somebody who already has it — the same reasoning that lets
 * a VOIP renter buy the no_ban account they hold.
 */
export function accountMeetsPlanTags(internalNote, planId) {
  return tagsRequiredBy(planId).every((tag) => noteHasTag(internalNote, tag));
}

/**
 * Why the allocator would NOT hand this account to this plan, or null if it would.
 *
 *   'missing_tag'      the plan requires a tag the account lacks — an ordinary
 *                      account asked to serve the VOIP week or a no-ban day.
 *   'reserved_account' the account carries a tag this plan is barred from — a
 *                      vetted no_ban account asked to serve the plain 15k day.
 *
 * Both directions matter once a tag is what a customer is PAYING for. The second
 * one used to be ignored everywhere except the allocator, on the reasoning that
 * barring exists to stop a good account being spent on a cheap plan and is no
 * reason to take one away from somebody who already holds it. That held while the
 * only tagged plan was the VOIP week, where the premium bought perks. It stopped
 * holding when the same day on a vetted account became 25k against 15k: the tag is
 * now the product, so extending or adding onto that account at the plain price is
 * simply the vetted account at the untagged price.
 */
export function planFitReason(internalNote, planId) {
  if (!accountMeetsPlanTags(internalNote, planId)) return 'missing_tag';
  const barred = tagsBarredFrom(planId).filter((tag) => noteHasTag(internalNote, tag));
  return barred.length ? 'reserved_account' : null;
}

/** Whether the allocator would hand this account to this plan. */
export function accountFitsPlan(internalNote, planId) {
  return planFitReason(internalNote, planId) === null;
}

export const DEFAULT_GAME = 'the-isle';

export function findPlan(gameId, planId) {
  const game = GAMES[gameId];
  if (!game) return null;
  const plan =
    game.plans.find((p) => p.id === planId) ||
    (game.purchase?.id === planId ? game.purchase : null);
  return plan ? { ...plan, gameId, gameName: game.name } : null;
}

/**
 * What a plan costs as an ADDON — a second game opened on the account a customer is
 * already renting — and what it costs on the shelf.
 *
 * An addon claims no stock: the login is one this customer already holds, so the
 * only cost is the game itself. `addonAmount` on the plan is what that is worth;
 * a plan without one is simply sold at its shelf price.
 *
 * Returns `full` as null when nothing was taken off, so a caller never has to
 * compare two numbers to find out whether there is a discount to show. Charging is
 * decided here and nowhere else — the page displays what this returns, it does not
 * work it out, and it never sends an amount.
 */
export function addonAmount(plan) {
  // No plan currently sets `addonAmount`, so every addon is sold at its shelf price
  // and `full` comes back null — the strikethrough hides itself. The mechanism is
  // kept because turning the offer back on is one field on one plan.
  const full = plan?.amount ?? 0;
  const price = plan?.addonAmount;
  if (typeof price !== 'number' || price >= full) return { amount: full, full: null };
  return { amount: price, full };
}

/** The buy-out offer for a game, or null if it is rent-only. */
export function purchasePlan(gameId) {
  const game = GAMES[gameId];
  if (!game?.purchase) return null;
  return { ...game.purchase, gameId, gameName: game.name };
}

export function formatVnd(amount) {
  return new Intl.NumberFormat('vi-VN').format(amount) + '₫';
}

/** 20000 → "20k", matching how the packages are advertised. */
export function formatCompactVnd(amount) {
  return amount % 1000 === 0 ? `${amount / 1000}k` : formatVnd(amount);
}

/**
 * Splits "20k" into its number and unit so each can be set in its own typeface —
 * Cinzel has no true lowercase, so an unsplit "20k" renders as "20K".
 */
export function compactParts(amount) {
  return amount % 1000 === 0
    ? { value: String(amount / 1000), unit: 'k' }
    : { value: formatVnd(amount), unit: '' };
}
