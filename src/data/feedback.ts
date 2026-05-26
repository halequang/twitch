// Customer feedback / payment evidence shown on the homepage.
//
// To add a new item:
//   1) Drop the bill screenshot in `pending-images/feedback/<filename>.png`
//   2) Run `npm run upload-images` and copy the printed URL
//   3) Add an entry below
//
// Source-of-truth for the full archive (admin-only):
//   https://fungaming.notion.site/Bill-Feedback-23d7c5e7948680518fafd2fcafa3e199

export type FeedbackType = 'Top-up' | 'keypoe2';

export interface FeedbackItem {
  /** Customer first name + last initial (e.g. "Quang H.") */
  name: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  type: FeedbackType;
  /** Public R2 URL of the payment screenshot */
  image: string;
  /** Optional short note (e.g., "300P", "1000P pack", "key POE2 ×3") */
  note?: string;
}

export const feedback: FeedbackItem[] = [
  // Example — replace with real entries once you've uploaded screenshots.
  // {
  //   name: 'Quang H.',
  //   date: '2025-05-20',
  //   type: 'Top-up',
  //   image: 'https://cdn.fungamingvn.shop/feedback/quang-h-300p.png',
  //   note: '300P pack',
  // },
];

export const FEEDBACK_NOTION_URL =
  'https://fungaming.notion.site/Bill-Feedback-23d7c5e7948680518fafd2fcafa3e199';
