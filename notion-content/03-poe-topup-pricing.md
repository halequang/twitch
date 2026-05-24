# Bảng giá top-up game POE

> Source: <https://www.notion.so/1de7c5e79486804c8119c43c386b3a82>

## Sub-page

- [Bảng giá account & gói nạp steam](./03a-account-steam-pricing.md)

## Database

Inline database: **cập nhật giá ngày 11/11/2025**

Schema saved at [`./databases/poe-pricing-2025-11-11.json`](./databases/poe-pricing-2025-11-11.json).

Columns:

| Column            | Type          | Values                                                |
| ----------------- | ------------- | ----------------------------------------------------- |
| Title             | title         | —                                                     |
| Giá (nghìn đồng)  | number        | Price in thousand VND                                 |
| type              | multi-select  | `steam`, `có sẵn`, `nạp chính chủ`, `web`, `xbox`    |
| note              | text          | —                                                     |

> Row data is not exposed via the Notion MCP fetch tool — view live on Notion or export CSV.
