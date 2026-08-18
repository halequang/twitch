/**
 * Shared AI buy-advisor logic (Gemini).
 *
 * Environment-agnostic: uses only the global `fetch`, so the same code runs in
 * the Cloudflare Worker (production, see worker/index.js) and in the Astro/Vite
 * dev server middleware (see astro.config.mjs) so `npm run dev` works too.
 */

import { PRODUCTS, FAQS, POLICIES } from "../data/shop-knowledge.js";

// gemini-3.5-flash has a very low free-tier quota and 429s readily; 2.5-flash
// is reliable on this key. If the primary is rate-limited, we fall back down
// this chain (each has a separate quota bucket).
export const DEFAULT_MODEL = "gemini-3.5-flash";
export const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
export const MAX_MESSAGES = 16; // cap conversation history sent to Gemini
export const MAX_CHARS = 2000;  // cap length of any single message
export const MAX_RETRIES = 2;   // extra attempts on transient Gemini errors
const RETRY_BASE_MS = 500;      // backoff: 500ms, then 1000ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The full knowledge text injected into the prompt, assembled from the editable
// knowledge base (src/data/shop-knowledge.js): products + FAQ answers + policies.
const FAQ_BLOCK = FAQS.map((f) => `  - ${f.q}: ${f.answer}`).join("\n");
const KNOWLEDGE = `${PRODUCTS}

[FAQ] CÂU HỎI THƯỜNG GẶP & TRẢ LỜI MẪU:
${FAQ_BLOCK}

${POLICIES}`;

const SYSTEM_PROMPT = `
Bạn là trợ lý tư vấn mua hàng của shop game "FunGaming VN". Nhiệm vụ của bạn là
giúp khách hàng chọn đúng sản phẩm phù hợp nhất với nhu cầu của họ.

QUY TẮC:
- LUÔN trả lời bằng TIẾNG VIỆT, giọng điệu thân thiện, ngắn gọn, dễ hiểu.
- XƯNG HÔ NHẤT QUÁN trong MỌI câu trả lời: tự xưng là "mình" (hoặc "shop mình"),
  gọi khách hàng là "bạn". TUYỆT ĐỐI KHÔNG dùng "em", "anh", "chị", "quý khách".
- CHỈ tư vấn dựa trên thông tin dưới đây. TUYỆT ĐỐI KHÔNG bịa ra
  sản phẩm, giá, hay khuyến mãi không có trong danh sách.
- Hỏi lại 1 câu ngắn để làm rõ nhu cầu nếu khách hỏi mơ hồ (chơi POE1 hay POE2,
  muốn skin / nạp point / mua acc, ngân sách bao nhiêu...).
- Khi đã rõ nhu cầu, gợi ý sản phẩm cụ thể KÈM GIÁ và lý do ngắn gọn.
- Luôn nhắc khách đặt hàng qua Telegram bot @fungamingvnbot hoặc liên hệ trực tiếp.
- Giữ câu trả lời gọn (tối đa ~6 dòng). Có thể dùng gạch đầu dòng.
- Nếu khách hỏi điều ngoài phạm vi shop, lịch sự đưa họ về chủ đề mua sản phẩm POE.

THÔNG TIN SHOP & SẢN PHẨM:
${KNOWLEDGE}
`.trim();

// Normalize Vietnamese text for FAQ matching: lowercase, strip diacritics,
// đ→d, and reduce punctuation to spaces so word-boundary matching works.
function normalizeVi(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip combining diacritic marks
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Return a canned FAQ answer for a short, simple question, else null. Triggers
// match on whole words (diacritics-insensitive). Long/complex messages are left
// to Gemini so context isn't ignored.
function matchFaq(text) {
  const n = normalizeVi(text);
  if (!n || n.length > 60) return null;
  const padded = ` ${n} `;
  for (const f of FAQS) {
    for (const t of f.triggers) {
      if (padded.includes(` ${normalizeVi(t)} `)) return f.answer;
    }
  }
  return null;
}

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

  // Fast-path: answer common, simple questions instantly from the FAQ data —
  // no Gemini call (faster, free, dodges quota). Only the latest user turn.
  const last = contents[contents.length - 1];
  if (last.role === "user") {
    const canned = matchFaq(last.parts[0].text);
    if (canned) return { status: 200, body: { reply: canned, model: "faq" } };
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
