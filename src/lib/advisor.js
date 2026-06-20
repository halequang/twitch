/**
 * Shared AI buy-advisor logic (Gemini).
 *
 * Environment-agnostic: uses only the global `fetch`, so the same code runs in
 * the Cloudflare Worker (production, see worker/index.js) and in the Astro/Vite
 * dev server middleware (see astro.config.mjs) so `npm run dev` works too.
 */

// gemini-3.5-flash has a very low free-tier quota and 429s readily; 2.5-flash
// is reliable on this key. If the primary is rate-limited, we fall back down
// this chain (each has a separate quota bucket).
export const DEFAULT_MODEL = "gemini-2.5-flash";
export const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash"];
export const MAX_MESSAGES = 16; // cap conversation history sent to Gemini
export const MAX_CHARS = 2000;  // cap length of any single message
export const MAX_RETRIES = 2;   // extra attempts on transient Gemini errors
const RETRY_BASE_MS = 500;      // backoff: 500ms, then 1000ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single source of truth for what the shop sells. Keep in sync with
// src/components/PricingBanner.astro and src/pages/index.astro.
const CATALOG = `
SHOP: FunGaming VN — chuyên Path of Exile (POE 1 & 2) cho người chơi Việt Nam.

[1] NẠP POINT (Point — tiền tệ cao cấp trong game, dùng mua skin/stash tab/hiệu ứng):
  - 300P  — 390k  (TẶNG KÈM KEY POE2)
  - 600P  — 790k  (TẶNG KÈM KEY POE2)
  - 900P  — 1.080k
  - 1000P — 1.250k (TẶNG KÈM KEY POE2) — đáng giá nhất theo đơn vị Point
  Nạp càng nhiều giá mỗi Point càng rẻ. Gói 300/600/1000 còn được tặng key POE2.

[2] ACCOUNT POE TẠO SẴN (acc trắng, dùng để nhận Twitch Drops / chơi mới):
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

MUA HÀNG & HỖ TRỢ:
  - Đặt hàng tự động 24/7 qua Telegram bot: @fungamingvnbot
  - Liên hệ trực tiếp: Facebook quanghavhit · Discord runninghorseq · Telegram @runninghorseq
  - Shop uy tín đã xác minh: G2G (FunGamingVN), FunPay (#13338565)
  - Có chính sách bảo hành cho account & phần mềm.
`.trim();

const SYSTEM_PROMPT = `
Bạn là trợ lý tư vấn mua hàng của shop game "FunGaming VN". Nhiệm vụ của bạn là
giúp khách hàng chọn đúng sản phẩm phù hợp nhất với nhu cầu của họ.

QUY TẮC:
- LUÔN trả lời bằng TIẾNG VIỆT, giọng điệu thân thiện, ngắn gọn, dễ hiểu.
- XƯNG HÔ NHẤT QUÁN trong MỌI câu trả lời: tự xưng là "mình" (hoặc "shop mình"),
  gọi khách hàng là "bạn". TUYỆT ĐỐI KHÔNG dùng "em", "anh", "chị", "quý khách".
- CHỈ tư vấn dựa trên danh sách sản phẩm dưới đây. TUYỆT ĐỐI KHÔNG bịa ra
  sản phẩm, giá, hay khuyến mãi không có trong danh sách.
- Hỏi lại 1 câu ngắn để làm rõ nhu cầu nếu khách hỏi mơ hồ (chơi POE1 hay POE2,
  muốn skin / nạp point / mua acc, ngân sách bao nhiêu...).
- Khi đã rõ nhu cầu, gợi ý sản phẩm cụ thể KÈM GIÁ và lý do ngắn gọn.
- Luôn nhắc khách đặt hàng qua Telegram bot @fungamingvnbot hoặc liên hệ trực tiếp.
- Giữ câu trả lời gọn (tối đa ~6 dòng). Có thể dùng gạch đầu dòng.
- Nếu khách hỏi điều ngoài phạm vi shop, lịch sự đưa họ về chủ đề mua sản phẩm POE.

DANH SÁCH SẢN PHẨM:
${CATALOG}
`.trim();

/**
 * Generate a buy recommendation.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages  conversation history: [{ role, text }]
 * @param {string}   opts.apiKey    Gemini API key
 * @param {string}  [opts.model]    model id (defaults to gemini-3.5-flash)
 * @returns {Promise<{ status: number, body: object }>} HTTP status + JSON body
 */
export async function generateAdvice({ messages, apiKey, model }) {
  if (!apiKey) {
    return { status: 503, body: { error: "advisor_unconfigured" } };
  }

  const incoming = Array.isArray(messages) ? messages : null;
  if (!incoming || incoming.length === 0) {
    return { status: 400, body: { error: "messages_required" } };
  }

  // Sanitize + map to Gemini's `contents` format. Only the last MAX_MESSAGES
  // turns are kept; roles other than user/model are coerced to user.
  const contents = incoming
    .slice(-MAX_MESSAGES)
    .map((m) => {
      const text = String(m?.text ?? "").slice(0, MAX_CHARS).trim();
      const role = m?.role === "model" ? "model" : "user";
      return text ? { role, parts: [{ text }] } : null;
    })
    .filter(Boolean);

  if (contents.length === 0) {
    return { status: 400, body: { error: "empty_messages" } };
  }

  // Try the requested/default model first, then fall back down the chain if a
  // model is rate-limited or erroring (each model has a separate quota bucket).
  const usedModel = model || DEFAULT_MODEL;
  const candidates = [usedModel, ...FALLBACK_MODELS.filter((m) => m !== usedModel)];

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 1024,
      // Gemini flash models spend "thinking" tokens out of maxOutputTokens,
      // which can truncate the visible reply. This is a short product
      // recommendation, not a reasoning task — turn thinking off for full,
      // fast answers.
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [],
  };

  // Gemini occasionally returns transient 429/5xx or drops the connection.
  // Retry those with exponential backoff; never retry 4xx (bad key/request).
  // After a model exhausts its retries, drop to the next candidate model.
  const body = JSON.stringify(payload);
  let lastStatus = 0;

  for (const candidate of candidates) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(candidate)}:generateContent`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));

      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body,
        });
      } catch {
        lastStatus = 0; // network/connection failure — retryable
        continue;
      }

      if (!res.ok) {
        lastStatus = res.status;
        if (res.status === 429 || res.status >= 500) continue; // transient
        // 4xx (bad key/request) — won't improve on retry or other model.
        return { status: 502, body: { error: "upstream_error", status: res.status } };
      }

      let data;
      try {
        data = await res.json();
      } catch {
        lastStatus = res.status;
        continue; // malformed body — retry
      }

      const reply = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("")
        .trim();

      if (!reply) {
        lastStatus = res.status;
        continue; // empty/blocked reply — retry once or twice
      }

      return { status: 200, body: { reply, model: candidate } };
    }
    // This model exhausted its retries — try the next fallback model.
  }

  // Every model + retry exhausted.
  return {
    status: 502,
    body: { error: lastStatus ? "upstream_error" : "upstream_unreachable", status: lastStatus },
  };
}
