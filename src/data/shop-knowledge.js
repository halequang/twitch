/**
 * Shop knowledge base for the AI advisor — EDIT THIS FILE to teach the bot.
 *
 *   PRODUCTS  — the catalog text injected into the prompt.
 *   FAQS      — common questions. Each `triggers` phrase lets the bot answer
 *               INSTANTLY with the canned `answer` (no Gemini call → fast + free
 *               + dodges quota). The `answer` is ALSO injected into the prompt,
 *               so Gemini can use it for non-exact phrasings too.
 *   POLICIES  — any extra free-form knowledge injected into the prompt.
 *
 * To add knowledge: add a product line, a new FAQ entry, or a policy line.
 * Keep catalog/prices in sync with src/components/PricingBanner.astro.
 *
 * ⚠️ Review every FAQ `answer` below — these are the bot's source of truth and
 *    get sent to customers verbatim. Replace any placeholder wording with your
 *    real policy. Use xưng hô "mình" ↔ "bạn" to match the bot's style.
 */

// Full per-pack Twitch Drops item list, auto-generated from the skins pages.
import { TWITCH_ITEMS_TEXT } from "./twitch-items.js";

const PRODUCTS_BASE = `
SHOP: FunGaming VN — chuyên Path of Exile (POE 1 & 2) cho người chơi Việt Nam.

[1] NẠP POINT (Point — tiền tệ cao cấp trong game, dùng mua skin/stash tab/hiệu ứng):
  - 300P  — 390k  (TẶNG KÈM KEY POE2)
  - 600P  — 790k  (TẶNG KÈM KEY POE2)
  - 900P  — 1.080k
  - 1000P — 1.250k (TẶNG KÈM KEY POE2) — đáng giá nhất theo đơn vị Point
  Nạp càng nhiều giá mỗi Point càng rẻ. Gói 300/600/1000 còn được tặng key POE2.

[2] ACCOUNT POE TẠO SẴN (acc trắng, dùng để nhận Twitch Drops / chơi mới):
  - 1–3 tuần — 4k (ƯU ĐÃI — mã voucher PROMOTE, mua qua Telegram bot)
  - 1 tháng — 7k
  - 3 tháng — 18k
  - 6 tháng — 30k

[3] BỘ SKIN TWITCH DROPS (tổng hợp skin nhận từ Twitch Drops):
  - Full Pack    (/skins)    — bộ ĐẦY ĐỦ tất cả skin Twitch Drops của POE.
  - Medium Pack  (/skins2)   — tuyển chọn các skin nổi bật nhất, gọn hơn Full.
  - POE2 Pack    (/POE2)     — skin Twitch Drops dành riêng cho Path of Exile 2 (MỚI).
  - Legacy Pack  (/skinsOLD) — kho skin từ các mùa giải cũ.

[4] PHẦN MỀM BẢN QUYỀN CẤP SẴN:
  - CapCut Pro — 1 năm, tài khoản dùng chung tối đa 4 khách, dùng cố định 1 thiết bị, bảo hành 1 đổi 1.

[5] NẠP POINT QUA STEAM — CÁCH RẺ NHẤT (cập nhật 21-06-2026; giá & rate thay đổi theo ngày):
  - Nhận acc để nạp:
    • Shop cấp acc Steam tạo sẵn (đã có POE2, CHƯA link Steam) — nhanh.
    • Hoặc khách gửi acc Steam MỚI của mình để nạp — lâu hơn (khoảng 6 tiếng) và phải mua gói từ 60 trở lên.
  - Tặng KEY POE2: mua gói 30 (EA), 60 (Ogham) hoặc 100 (Faridun) sẽ được tặng 1 key POE2. Đặc biệt có gói nhỏ 15 (EA).
  - Mẹo nạp point RẺ: chọn nhiều gói EA để nhận thêm nhiều key POE2.
  - Giá shop THU LẠI key POE2 hiện tại: 100k/key (ngày 21-06-2026).
  - Rate quy đổi hiện tại: 23000/ 1USD (theo ngày).
  - LƯU Ý: gói Steam trên 100 sẽ KHÔNG nạp được giá rẻ.

[6] CHI TIẾT CÁC GÓI SUPPORTER PACK POE (gói nhà tài trợ — chính là các gói nạp qua Steam ở trên):

  A. "Return of the Ancients" (ra mắt theo mùa mới PoE 2) — bán đến khi PoE2 ra Expansion 1.1.0:
    • Divinity Series: Divinity ($30/300P) · Knight of Divinity ($60/600P) · Arbiter of Divinity ($90/900P)
    • Bloodreaver Series: Bloodreaver ($30/300P) · Elite Bloodreaver ($60/600P) · Eternal Bloodreaver ($90/900P)

  B. "Mirage" (ra mắt theo mùa mới PoE 1) — bán đến khi PoE1 ra Expansion 3.29:
    • Wisdom Series: Curator of Wisdom ($30/300P) · Grand Curator ($60/600P) · Supreme Curator ($90/900P)
    • Incarcerator Series: Iron Incarcerator ($30/300P) · Elite Iron Incarcerator ($60/600P) · Eternal Iron Incarcerator ($90/900P)

  C. "PoE 2 Early Access" (kèm KEY Early Access; gói từ $160 có quà vật lý gửi về nhà):
    • Early Access Pack ($30/300P + 1 key EA)
    • Lord of Ogham ($60/600P + 1 key EA)
    • King of the Faridun ($100/1000P + 1 key EA)
    • Thaumaturge of the Vaal ($160/1600P + 2 key EA + áo thun PoE2)
    • Warlord of the Karui ($240/2400P + 3 key EA + áo thun & hoodie PoE2)
    • Liberator of Wraeclast ($480/4800P + 5 key EA + áo thun, hoodie, Art Book 215 trang & quyền thiết kế rương Reliquary)

  D. Gói lẻ:
    • First Blood Pack ($20/200P + 1 Stash Tab + hiệu ứng vũ khí First Blood). Giới hạn 1 lần/tài khoản.

  MẸO NÂNG CẤP (up pack): mua gói nhỏ trước rồi bù tiền nâng lên gói cao hơn TRONG CÙNG 1 CHUỖI (vd $30→$60);
  hệ thống trừ tiền theo Points thuần đã mua (giảm tối đa 80% giá gói muốn nâng cấp).
    • Up pack qua WEB: rate 24.000đ/1 USD — CẦN giao acc cho shop.
    • Up pack qua CODE NEXON: rate 26.000đ/1 USD — KHÔNG cần giao acc.
    • LƯU Ý so sánh giá: đôi khi MUA ĐỨT gói mới bên Steam còn rẻ hơn up pack.
      Ví dụ: đang có gói 30 (EA) muốn lên 100 (EA/Faridun) → mua đứt 1000P bên Steam chỉ 1.250.000 vnd là rẻ hơn.

[7] NẠP POINT QUA XBOX (cập nhật 21-06-2026; giá thay đổi theo ngày):
  - Gói First Blood: 330k — chỉ nạp được 1 lần (giới hạn 1 lần/tài khoản).
  - Gói $480 (Liberator of Wraeclast): 6tr5 (≈6.500k).
  - Các gói khác: liên hệ shop để báo giá.
`.trim();

// Catalog + the full Twitch Drops item list, both injected into the prompt.
export const PRODUCTS = `${PRODUCTS_BASE}\n\n${TWITCH_ITEMS_TEXT}`;

/**
 * @type {{ q: string, triggers: string[], answer: string }[]}
 * `triggers` are matched on whole words, diacritics-insensitive (e.g. "bao hanh"
 * matches "bảo hành"). Only short, simple questions take the instant path.
 */
export const FAQS = [
  {
    q: "Nạp Point giá rẻ qua Steam",
    triggers: [
      "nap steam", "qua steam", "steam re", "nap re", "nap point re",
      "cach re nhat", "gia re nhat", "re nhat", "key poe2",
    ],
    answer:
      "Cách RẺ NHẤT là nạp qua Steam nha bạn 👇\n" +
      "• Shop cấp acc Steam tạo sẵn (có POE2, chưa link Steam) — nhanh; hoặc bạn gửi acc " +
      "Steam mới để nạp (lâu hơn ~6 tiếng, cần mua gói từ 60 trở lên).\n" +
      "• Mua gói 30 (EA) / 60 (Ogham) / 100 (Faridun) được tặng 1 KEY POE2 — có cả gói nhỏ 15 (EA).\n" +
      "• Muốn point rẻ: chọn nhiều gói EA để có thêm key POE2. Gói trên 100 thì không nạp rẻ được.\n" +
      "Cập nhật 21-06-2026: shop thu lại key POE2 100k/key, rate 23. Bạn nhắn @fungamingvnbot để chốt nhé!",
  },
  {
    q: "Nạp Point qua Xbox",
    triggers: ["nap xbox", "qua xbox", "xbox"],
    answer:
      "Nạp qua Xbox nha bạn 👇\n" +
      "• Gói First Blood: 330k (chỉ nạp được 1 lần/tài khoản).\n" +
      "• Gói $480 (Liberator of Wraeclast): 6tr5.\n" +
      "Các gói khác bạn nhắn @fungamingvnbot để shop báo giá chi tiết nhé! (cập nhật 21-06-2026)",
  },
  // {
  //   q: "Bảng giá",
  //   triggers: ["gia", "bang gia", "gia ca", "bao nhieu tien", "bao nhieu", "price"],
  //   answer:
  //     "Bảng giá nhanh của shop mình nè bạn 👇\n" +
  //     "• Nạp Point: 300P=390k · 600P=790k · 900P=1.080k · 1000P=1.250k " +
  //     "(gói 300/600/1000 tặng kèm KEY POE2)\n" +
  //     "• Acc POE tạo sẵn: 1–3 tuần=4k (voucher PROMOTE) · 1 tháng=7k · 3 tháng=18k · 6 tháng=30k\n" +
  //     "Bạn đặt hàng tự động 24/7 qua Telegram bot @fungamingvnbot nhé!",
  // },
  {
    q: "Nâng cấp gói (up pack)",
    triggers: ["up pack", "nang cap", "nang goi", "len goi", "upgrade"],
    answer:
      "Về nâng cấp gói (up pack) nha bạn 👇\n" +
      "• Up qua WEB: rate 24.000đ/1 USD — cần giao acc cho shop.\n" +
      "• Up qua CODE NEXON: rate 26.000đ/1 USD — không cần giao acc.\n" +
      "• Mẹo: đôi khi mua đứt gói mới bên Steam còn rẻ hơn up pack (vd lên gói 100 EA chỉ ~1.250k).\n" +
      "Bạn nhắn @fungamingvnbot để shop tính giúp phương án rẻ nhất nhé!",
  },
  {
    q: "Cách đặt hàng / mua",
    triggers: ["mua sao", "dat hang", "dat mua", "lam sao de mua", "mua nhu the nao", "order"],
    answer:
      "Để đặt hàng, bạn nhắn Telegram bot @fungamingvnbot (tự động 24/7), " +
      "chọn sản phẩm rồi làm theo hướng dẫn thanh toán. Cần hỗ trợ trực tiếp " +
      "thì nhắn @runninghorseq giúp mình nhé!",
  },
  {
    q: "Thanh toán",
    triggers: ["thanh toan", "tra tien", "chuyen khoan", "momo", "payment", "tra bang gi"],
    answer:
      "Bạn thanh toán nhanh nhất qua Telegram bot @fungamingvnbot (tự động 24/7). " +
      "Nếu cần hướng dẫn cụ thể, bạn nhắn trực tiếp @runninghorseq nhé! 💳",
  },
  {
    q: "Bảo hành",
    triggers: ["bao hanh", "warranty", "loi thi sao", "doi tra", "het han"],
    answer:
      "Shop mình có chính sách bảo hành cho account và phần mềm nha. " +
      "Bạn cho mình biết bạn mua sản phẩm nào để mình tư vấn chi tiết, " +
      "hoặc nhắn @fungamingvnbot để được hỗ trợ nhé! 🛡️",
  },
  {
    q: "Liên hệ",
    triggers: ["lien he", "contact", "ho tro", "nhan tin", "gap shop", "zalo"],
    answer:
      "Bạn liên hệ shop mình qua:\n" +
      "• Telegram: @runninghorseq (hoặc bot @fungamingvnbot)\n" +
      "• Facebook: quanghavhit · Discord: runninghorseq\n" +
      "Shop uy tín đã xác minh trên G2G (FunGamingVN) & FunPay (#13338565) nha!",
  },
];

export const POLICIES = `
MUA HÀNG & HỖ TRỢ:
  - Đặt hàng tự động 24/7 qua Telegram bot: @fungamingvnbot
  - Liên hệ trực tiếp: Facebook quanghavhit · Discord runninghorseq · Telegram @runninghorseq
  - Shop uy tín đã xác minh: G2G (FunGamingVN), FunPay (#13338565)
  - Có chính sách bảo hành cho account & phần mềm.
`.trim();
