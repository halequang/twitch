// Port of readmail_graph.py — Microsoft Graph API mail reader.
// Graph-only (IMAP fallback dropped); dependency-free (uses global fetch).

export interface EmailInit {
  fromAddr?: string;
  subject?: string;
  code?: string;
  content?: string;
}

export class Email {
  fromAddr: string;
  subject: string;
  code: string;
  content: string;

  constructor({ fromAddr = "", subject = "", code = "", content = "" }: EmailInit = {}) {
    this.fromAddr = fromAddr;
    this.subject = subject;
    this.code = code;
    this.content = content;
  }

  toString(): string {
    return `<Email from=${this.fromAddr} subject=${this.subject} code=${this.code}>`;
  }

  /** Convert HTML content to readable text (plain text passes through unchanged). */
  getReadableContent(): string {
    if (!this.content) return "";
    const hasHtml = this.content.includes("<") && this.content.includes(">");
    if (!hasHtml) return decodeEntities(this.content).trim();

    try {
      let text = this.content;
      // Drop script/style blocks entirely
      text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
      // Block-level tags → newline
      text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n");
      // Strip remaining tags
      text = text.replace(/<[^>]+>/g, "");
      text = decodeEntities(text);
      // Collapse runs of blank lines
      text = text.replace(/\n\s*\n/g, "\n\n");
      return text.trim();
    } catch (err) {
      console.error("Error converting HTML to text:", err);
      return decodeEntities(this.content.replace(/<[^>]+>/g, "")).trim();
    }
  }
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
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

const DEFAULT_CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

export class Hotmail {
  emailAddr: string;
  password: string;
  refreshToken: string;
  clientId: string;
  accessToken: string | null = null;
  isGraphToken = false;

  /** input string: "email|password|refresh_token|client_id" */
  constructor(inputStr: string) {
    const parts = inputStr.trim().split("|");
    if (parts.length !== 4) {
      throw new Error("Dữ liệu phải có đủ 4 phần tử: email|password|refresh_token|client_id");
    }
    this.emailAddr = parts[0];
    this.password = parts[1];
    this.refreshToken = parts[2];
    this.clientId = parts[3] || DEFAULT_CLIENT_ID;
  }

  /** Refresh token cho Graph API. Returns 0 on success, -1 on failure. */
  async updateAccessTokenGraph(): Promise<number> {
    const url = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
      scope: "https://graph.microsoft.com/.default offline_access",
    });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) return -1;
      const text = await resp.text();
      const data = JSON.parse(text) as { access_token?: string };
      this.accessToken = data.access_token ?? null;
      if (text.includes("Mail.Read") || text.includes("Mail.ReadWrite")) {
        this.isGraphToken = true;
      }
      return 0;
    } catch {
      return -1;
    }
  }

  async readMail(): Promise<Email[]> {
    if (this.isGraphToken) return this.readMailByGraph();
    console.log("Không có Graph token, bỏ qua (IMAP đã bị loại khỏi bản port).");
    return [];
  }

  /** ✅ Đọc mail bằng Graph API ✅ */
  async readMailByGraph(): Promise<Email[]> {
    if (!this.accessToken) return [];
    const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
    url.searchParams.set("$select", "id,subject,from,body,bodyPreview");

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      value?: Array<{
        subject?: string;
        from?: { emailAddress?: { address?: string } };
        body?: { content?: string };
        bodyPreview?: string;
      }>;
    };

    const emails: Email[] = [];
    for (const msg of data.value ?? []) {
      const fromAddr = msg.from?.emailAddress?.address ?? "";
      const subject = msg.subject ?? "";
      const match = subject.match(/(\d{5,6})/);
      const code = match ? match[0] : "";
      const content = msg.body?.content || msg.bodyPreview || "";
      emails.push(new Email({ fromAddr, subject, code, content }));
    }
    return emails;
  }
}

export class ReadMailGraph {
  hotmail: Hotmail;

  constructor(hotmail: string, refreshToken: string, clientId: string) {
    this.hotmail = new Hotmail(`${hotmail}|password|${refreshToken}|${clientId}`);
  }

  /** Get the most recent emails (numEmails must be 1 or 2). */
  async getLatestEmail(numEmails: 1 | 2 = 2): Promise<Email[]> {
    if (numEmails !== 1 && numEmails !== 2) {
      throw new Error("numEmails must be 1 or 2");
    }

    const status = await this.hotmail.updateAccessTokenGraph();
    if (status === 0 && this.hotmail.isGraphToken) {
      console.log("✅ Đọc mail bằng Graph API...✅ ");
    } else {
      console.log("Không lấy được Graph token.");
      return [];
    }

    const mails = await this.hotmail.readMail();
    return mails.slice(0, numEmails);
  }

  /** Print the most recent emails and auto-click Steam verification URLs if found. */
  async printLatestEmail(numEmails: 1 | 2 = 2): Promise<void> {
    const latestEmails = await this.getLatestEmail(numEmails);
    console.log("\n================== 📥 LATEST EMAILS ==================\n");
    if (latestEmails.length === 0) {
      console.log("❌ No emails found.");
      return;
    }

    const urlPatterns = [
      /https:\/\/store\.steampowered\.com\/account\/steamguarddisableverification\?[^\s\)]+/g,
      /https:\/\/store\.steampowered\.com\/account\/newaccountverification\?[^\s\)]+/g,
    ];

    for (const [i, mail] of latestEmails.entries()) {
      console.log(`\n${"=".repeat(50)}`);
      console.log(`📧 EMAIL #${i + 1}`);
      console.log("=".repeat(50));
      console.log(`📌 Subject: ${mail.subject}`);
      console.log(`📨 Sender: ${mail.fromAddr}`);
      const readable = mail.getReadableContent();
      console.log(`📜 Content:\n${readable}`);

      const urls: string[] = [];
      for (const pattern of urlPatterns) {
        urls.push(...(readable.match(pattern) ?? []));
      }

      if (urls.length > 0) {
        const url = urls[0].replace(/\)+$/, "");
        const urlType = url.includes("steamguarddisableverification")
          ? "Steam Guard Disable"
          : "Email Verification";
        console.log(`\n🔗 Found ${urlType} URL: ${url}`);
        console.log("🖱️  Auto-clicking URL...");
        try {
          const response = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 200) {
            console.log(`✅ Successfully clicked URL (Status: ${response.status})`);
          } else {
            console.log(`⚠️  URL clicked but returned status: ${response.status}`);
          }
        } catch (err) {
          console.log(`❌ Error clicking URL: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
}
