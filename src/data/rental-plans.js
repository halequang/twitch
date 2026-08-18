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
    ],
  },
};

export const DEFAULT_GAME = 'the-isle';

export function findPlan(gameId, planId) {
  const game = GAMES[gameId];
  if (!game) return null;
  const plan = game.plans.find((p) => p.id === planId);
  return plan ? { ...plan, gameId, gameName: game.name } : null;
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
