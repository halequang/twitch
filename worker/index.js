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

const STALE_THRESHOLD_DAYS = 75;          // ~2.5 months
const REFRESH_STALE_BATCH = 40;           // stay under Worker subrequest cap per invocation

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
      if (path === "/api/refresh-stale" && request.method === "POST") {
        return handle(() => refreshStale(request, env));
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

  // Parse first so we can report syntactic errors without burning HTTP calls.
  const parsed = [];
  const errors = [];
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
    parsed.push({
      lineNo: idx + 1,
      email,
      password,
      refreshToken,
      clientId: clientIdRaw || DEFAULT_CLIENT_ID,
    });
  }

  // Refresh each token against Microsoft in parallel; persist the rotated
  // refresh_token returned by the server so the 90-day clock starts now.
  const results = await Promise.all(
    parsed.map(async (p) => {
      const res = await refreshGraphToken(p.clientId, p.refreshToken);
      return { ...p, res };
    })
  );

  const now = Date.now();
  const statements = [];
  const savedEmails = [];

  for (const r of results) {
    if (!r.res.ok) {
      errors.push({ line: r.lineNo, error: `refresh failed: ${r.res.error || "unknown"}` });
      continue;
    }
    const newRefreshToken = r.res.refreshToken || r.refreshToken;
    statements.push(
      env.DB.prepare(
        `INSERT INTO accounts (email, password, refresh_token, client_id, created_at, last_refresh_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password = excluded.password,
           refresh_token = excluded.refresh_token,
           client_id = excluded.client_id,
           last_refresh_time = excluded.last_refresh_time`
      ).bind(r.email, r.password, newRefreshToken, r.clientId, now, now)
    );
    savedEmails.push(r.email);
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return { ok: true, saved: savedEmails.length, emails: savedEmails, errors };
}

async function refreshStale(request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) { /* empty body is fine */ }
  const thresholdDays = Number.isFinite(body.thresholdDays) && body.thresholdDays >= 0
    ? body.thresholdDays
    : STALE_THRESHOLD_DAYS;
  const limit = Number.isFinite(body.limit) && body.limit > 0
    ? Math.min(body.limit, REFRESH_STALE_BATCH)
    : REFRESH_STALE_BATCH;
  const cutoff = Date.now() - thresholdDays * 86400 * 1000;

  const totalStaleRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE last_refresh_time < ?"
  ).bind(cutoff).first();
  const totalStale = totalStaleRow?.n ?? 0;

  if (totalStale === 0) {
    return {
      ok: true, refreshed: 0, failed: 0, scanned: 0,
      total_stale: 0, remaining_stale: 0,
      threshold_days: thresholdDays, errors: [],
    };
  }

  const stale = await env.DB.prepare(
    "SELECT email, refresh_token, client_id FROM accounts WHERE last_refresh_time < ? ORDER BY last_refresh_time ASC LIMIT ?"
  ).bind(cutoff, limit).all();
  const rows = stale.results || [];

  const results = await Promise.all(
    rows.map(async (row) => {
      const res = await refreshGraphToken(row.client_id, row.refresh_token);
      return { email: row.email, oldRefreshToken: row.refresh_token, res };
    })
  );

  const now = Date.now();
  const updates = [];
  const errors = [];
  let refreshed = 0;
  for (const r of results) {
    if (!r.res.ok) {
      errors.push({ email: r.email, error: r.res.error || "unknown" });
      continue;
    }
    refreshed++;
    updates.push(
      env.DB.prepare(
        "UPDATE accounts SET refresh_token = ?, last_refresh_time = ? WHERE email = ?"
      ).bind(r.res.refreshToken || r.oldRefreshToken, now, r.email)
    );
  }
  if (updates.length > 0) {
    await env.DB.batch(updates);
  }

  return {
    ok: true,
    refreshed,
    failed: errors.length,
    scanned: rows.length,
    total_stale: totalStale,
    remaining_stale: Math.max(0, totalStale - refreshed),
    threshold_days: thresholdDays,
    errors,
  };
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
  if (!token.ok || !token.accessToken) {
    throw new Error(`Failed to refresh access token${token.error ? `: ${token.error}` : ""}`);
  }
  if (!token.isGraphToken) throw new Error("Token lacks Mail.Read scope");

  // The refresh rotated; persist the new token + bump last_refresh_time so this
  // account counts as fresh for the next 2.5 months.
  if (token.refreshToken && token.refreshToken !== row.refresh_token) {
    await env.DB.prepare(
      "UPDATE accounts SET refresh_token = ?, last_refresh_time = ? WHERE email = ?"
    ).bind(token.refreshToken, Date.now(), email).run();
  }

  const messages = await fetchMessages(token.accessToken);
  const emails = messages.slice(0, n).map(toEmail);
  return { ok: true, emails };
}

// --- Microsoft Graph helpers --------------------------------------------

async function refreshGraphToken(clientId, refreshToken) {
  let resp;
  try {
    resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/.default offline_access",
      }),
    });
  } catch (err) {
    return { ok: false, accessToken: null, refreshToken: null, isGraphToken: false, error: `network:${err?.message || err}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, accessToken: null, refreshToken: null, isGraphToken: false, error: `http_${resp.status}:${text.slice(0, 200)}` };
  }
  let data;
  try { data = JSON.parse(text); }
  catch (_) { return { ok: false, accessToken: null, refreshToken: null, isGraphToken: false, error: "invalid_json" }; }
  return {
    ok: true,
    accessToken: data.access_token || null,
    refreshToken: data.refresh_token || null,
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
