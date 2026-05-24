# FunGaming Notion Content

Mirror of content from <https://fungaming.notion.site/> — fetched 2026-05-24 via the Notion MCP server.

## Root Page

[Welcome to FunGaming! 🎮](./00-welcome.md) — landing page

## Pages

| #   | File                                                  | Title                                                                |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | [01-twitch-drops.md](./01-twitch-drops.md)            | How to Claim Your Twitch Drop Rewards                                |
| 2   | [02-steam-link.md](./02-steam-link.md)                | How to link your Steam account to your Path of Exile account        |
| 3   | [03-poe-topup-pricing.md](./03-poe-topup-pricing.md)  | Bảng giá top-up game POE                                             |
| 3a  | [03a-account-steam-pricing.md](./03a-account-steam-pricing.md) | Bảng giá account & gói nạp steam (sub-page)                 |
| 4   | [04-ggg-email-templates.md](./04-ggg-email-templates.md) | Support grinding gear email template                              |
| 5   | [05-warranty-policy.md](./05-warranty-policy.md)      | Chính sách bảo hành                                                  |
| 6   | [06-capcut-pro.md](./06-capcut-pro.md)                | Tài khoản Capcut Pro 1 năm                                           |
| 7   | [07-customer-feedback.md](./07-customer-feedback.md)  | Customer feedback                                                    |
| 8   | [08-bill-feedback.md](./08-bill-feedback.md)          | Bill & Feedback                                                      |
| 9   | [09-poe-account-via-steam.md](./09-poe-account-via-steam.md) | Creating a Path of Exile Account via Steam                  |

## Databases

Schemas only — Notion MCP does not expose row data via fetch. See [`./databases/`](./databases/).

| File                                                            | Title                                                  | Parent page                |
| --------------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| [poe-pricing-2025-11-11.json](./databases/poe-pricing-2025-11-11.json) | cập nhật giá ngày 11/11/2025                     | Bảng giá top-up game POE   |
| [account-pricing-2026-04-24.json](./databases/account-pricing-2026-04-24.json) | cập nhật bảng giá ngày 24/04/2026         | Bảng giá account & gói nạp steam |
| [steam-topup.json](./databases/steam-topup.json)                | nạp steam                                              | Bảng giá account & gói nạp steam |
| [bill-feedback.json](./databases/bill-feedback.json)            | Bill & Feedback database                               | Bill & Feedback            |

## Notes

- All images referenced in the original pages are S3 pre-signed URLs that expire — not mirrored locally.
- Database row contents must be exported manually from Notion (CSV export) if needed.
