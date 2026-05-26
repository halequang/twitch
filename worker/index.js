/**
 * Cloudflare Worker — POE skins viewer + mail reader.
 *
 * Routes clean paths to bundled HTML; serves /api/* for the mail reader.
 * Anything else is delegated to the static assets binding.
 */

const ROUTES = {
  "/":          "/index.html",
  "/skins":     "/skins.html",
  "/skins2":    "/skins2.html",
  "/skins3":    "/skins.html",
  "/skinsOLD":  "/skinsOLD.html",
  "/poe2":      "/POE2.html",
  "/POE2":      "/POE2.html",
  "/mail":      "/mail.html",
};

const DEFAULT_CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    if (path.startsWith("/api/")) {
      const limited = await checkRateLimit(request, env);
      if (limited) return limited;
      const guard = checkAuth(request, env);
      if (guard) return guard;
      if (path === "/api/save-token" && request.method === "POST") {
        return handle(() => saveToken(request, env));
      }
      if (path === "/api/read-mail" && request.method === "POST") {
        return handle(() => readMail(request, env));
      }
      return json({ ok: false, error: "Not found" }, 404);
    }

    const target = ROUTES[path];
    if (target) {
      const assetUrl = new URL(target, url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return env.ASSETS.fetch(request);
  },
};

/** Returns a 429 Response if the caller is over budget, or null otherwise. */
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMITER) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const path = new URL(request.url).pathname;
  const { success } = await env.RATE_LIMITER.limit({ key: `${ip}:${path}` });
  if (!success) {
    return json({ ok: false, error: "Rate limit exceeded, try again shortly" }, 429);
  }
  return null;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "https://fungamingvn.shop",
  "https://www.fungamingvn.shop",
];

/** Returns a Response on failure, or null on success. */
function checkAuth(request, env) {
  const origin = request.headers.get("Origin");
  if (origin) {
    const allowed = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
      : DEFAULT_ALLOWED_ORIGINS;
    if (!allowed.includes(origin)) {
      return json({ ok: false, error: "Forbidden origin" }, 403);
    }
  }
  return null;
}

async function handle(fn) {
  try {
    const body = await fn();
    return json(body);
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- API handlers --------------------------------------------------------

const MAX_BATCH = 50;

async function saveToken(request, env) {
  const { input } = await request.json();
  if (typeof input !== "string") throw new Error("Missing 'input'");

  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) throw new Error("No accounts provided");
  if (lines.length > MAX_BATCH) {
    throw new Error(`Too many accounts (${lines.length}); max ${MAX_BATCH} per save`);
  }

  const now = Date.now();
  const statements = [];
  const errors = [];
  const savedEmails = [];

  for (const [idx, line] of lines.entries()) {
    const parts = line.split("|");
    if (parts.length !== 4) {
      errors.push({ line: idx + 1, error: "expected 4 parts separated by '|'" });
      continue;
    }
    const [email, password, refreshToken, clientIdRaw] = parts.map((p) => p.trim());
    if (!email || !refreshToken) {
      errors.push({ line: idx + 1, error: "email and refresh_token are required" });
      continue;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO accounts (email, password, refresh_token, client_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password = excluded.password,
           refresh_token = excluded.refresh_token,
           client_id = excluded.client_id,
           updated_at = excluded.updated_at`
      ).bind(email, password, refreshToken, clientIdRaw || DEFAULT_CLIENT_ID, now)
    );
    savedEmails.push(email);
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return { ok: true, saved: savedEmails.length, emails: savedEmails, errors };
}

async function readMail(request, env) {
  const { email, numEmails = 2 } = await request.json();
  if (!email) throw new Error("Missing 'email'");
  const n = numEmails === 1 ? 1 : 2;

  const row = await env.DB.prepare(
    "SELECT refresh_token, client_id FROM accounts WHERE email = ?"
  ).bind(email).first();
  if (!row) throw new Error("Account not found — save it first");

  const token = await refreshGraphToken(row.client_id, row.refresh_token);
  if (!token.accessToken) throw new Error("Failed to refresh access token");
  if (!token.isGraphToken) throw new Error("Token lacks Mail.Read scope");

  const messages = await fetchMessages(token.accessToken);
  const emails = messages.slice(0, n).map(toEmail);
  return { ok: true, emails };
}

// --- Microsoft Graph helpers --------------------------------------------

async function refreshGraphToken(clientId, refreshToken) {
  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access",
    }),
  });
  if (!resp.ok) return { accessToken: null, isGraphToken: false };
  const text = await resp.text();
  const data = JSON.parse(text);
  return {
    accessToken: data.access_token || null,
    isGraphToken: text.includes("Mail.Read") || text.includes("Mail.ReadWrite"),
  };
}

async function fetchMessages(accessToken) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$select", "id,subject,from,body,bodyPreview");
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Graph ${resp.status}`);
  const data = await resp.json();
  return data.value || [];
}

function toEmail(msg) {
  const subject = msg.subject || "";
  const from = msg.from?.emailAddress?.address || "";
  const content = msg.body?.content || msg.bodyPreview || "";
  const codeMatch = subject.match(/(\d{5,6})/);
  return {
    from,
    subject,
    code: codeMatch ? codeMatch[0] : "",
    content,
    readable: htmlToText(content),
  };
}

// --- HTML → text (dependency-free) --------------------------------------

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (ent.startsWith("#")) {
      const cp = parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITY_MAP[ent.toLowerCase()] ?? m;
  });
}

function htmlToText(s) {
  if (!s) return "";
  if (!(s.includes("<") && s.includes(">"))) return decodeEntities(s).trim();
  let text = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/\n\s*\n/g, "\n\n");
  return text.trim();
}
