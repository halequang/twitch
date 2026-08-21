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
    features: [
      'Acc chính chủ Steam',
      'Chơi được mọi server',
      'Bàn giao nhanh < 5 phút',
      'Hỗ trợ setup từ A đến Z',
      'Không giới hạn giờ chơi',
      'Bảo hành trong suốt gói thuê',
    ],
    plans: [
      {
        id: 'isle-1d',
        kicker: 'Gói thử nghiệm',
        label: '1 ngày',
        icon: '🦴',
        hours: 24,
        amount: 20000,
        note: 'Trải nghiệm không rủi ro',
      },
      {
        id: 'isle-7d',
        kicker: 'Gói khuyến nghị',
        label: '1 tuần',
        icon: '🦖',
        hours: 24 * 7,
        amount: 50000,
        note: 'Chỉ ~7k / ngày — rẻ hơn 65%',
        badge: '🔥 Tiết kiệm',
        featured: true,
      },
      {
        // Same week, with the in-game extras. `perks` is what the card renders as
        // the "đặc quyền" box — without it this would be a second week plan at a
        // higher price and no visible reason for it.
        id: 'isle-7d-voip',
        kicker: 'Gói đầy đủ',
        label: '1 tuần',
        icon: '🎙️',
        hours: 24 * 7,
        amount: 80000,
        note: 'Nói chuyện & xem map trong game',
        badge: '🔥 Full perks',
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
      amount: 190000,
      purchase: true,
      note: 'Sở hữu vĩnh viễn · bàn giao cả email',
    },
  },
};

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
  no_ban: ['isle-7d-voip'],
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

export const DEFAULT_GAME = 'the-isle';

export function findPlan(gameId, planId) {
  const game = GAMES[gameId];
  if (!game) return null;
  const plan =
    game.plans.find((p) => p.id === planId) ||
    (game.purchase?.id === planId ? game.purchase : null);
  return plan ? { ...plan, gameId, gameName: game.name } : null;
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
