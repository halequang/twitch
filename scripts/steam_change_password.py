"""Change the password on Steam accounts (bulk).

Input file: steam_register_v2 RESULT format, one account per line:

    index|email|hotmail_password|steam_user|steam_password|country[|refresh_token|client_id]

Login uses steam_user (field 4) + steam_password (field 5). A NEW strong password
is generated per account, set via Steam's change-password flow, and recorded to
<input>.newpass.txt:

    steam_user|email|old_password|new_password|status|YYYY-MM-DD HH:MM:SS

Email verification codes are read automatically, tried in this order:

  1. the fungamingtool /api/read-code endpoint (scripts/mail_code_client.py).
     Needs MAIL_API_KEY (env, or TWITCH_DIR/.dev.vars) matching that Worker's
     secret. Works without outlook tokens because the server looks the mailbox up
     by email — which is what makes --db mode viable, since D1 stores no tokens.
     ONLY tried for outlook.com / hotmail.com addresses (GRAPH_MAIL_DOMAINS): the
     endpoint reads via Microsoft Graph, so any other provider is skipped rather
     than polled pointlessly.
  2. Microsoft Graph directly, if the account carries refresh_token|client_id.
  3. a manual prompt.

That endpoint returns "the newest email carrying a code" with no timestamp, so
the code present BEFORE the send is snapshotted and poll_new_code waits for a
different one. Steam codes are single-use: submitting a stale one just burns the
attempt and fails confusingly.

Flow (all on help.steampowered.com): log in -> open the change-password wizard
-> click "Email an account verification code" -> read the emailed code (via the
outlook token, or a manual prompt) and submit it -> set the new password twice on
the reset page and submit. Status OK means the new password is live (and recorded).

Already-done accounts (present in the result file) are skipped; pass --force to redo.

--db mode: instead of a file, source accounts from the twitch rental DB
(Cloudflare D1 'fungaming-rentals') whose rental is OVER (status 'available' with
an expired order), decrypt each login password, rotate it, and write the new
ENCRYPTED password back to steam_accounts.password_enc. --remote hits production
(default is the local D1); production runs prompt for confirmation. Crypto is done
via _d1crypto.mjs (byte-identical to the worker's AES-GCM).

On a successful change the account is also set back to status 'available', so the
rotated login re-enters the rental pool. Enforced in SQL, three states survive a
rotation untouched:
  - held by an ACTIVE rental -> reported as OK_STILL_RENTED, so a rotation can
    never hand the same login to a second customer while the first still has it;
  - 'sold' or 'disabled' -> reported as OK_KEPT_SOLD / OK_KEPT_DISABLED, since
    flipping those to 'available' would put an account that left the rental
    business back up for rent.

--account <login>[,<login>...] forces a password change for those specific
accounts (bypassing the rental-over selection and the already-done skip). In
--db mode they're loaded from the DB by login regardless of status; in file mode
the input is filtered to those logins. Repeatable and comma-separated.

Usage:
    python steam_change_password.py [accounts.txt] [--force] [--keep-open]
    python steam_change_password.py --db [--remote] [--force] [--keep-open]
    python steam_change_password.py --db --remote --account egrot16122,ywhods4353
"""
import json
import os
import random
import re
import string
import subprocess
import sys
import time
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# Optional: only needed for automatic Steam Guard / email-code reading.
try:
    import asyncio
    import httpx
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from hotmail.readmail_graph import Hotmail, ReadMailGraph
except Exception:
    ReadMailGraph = None
    Hotmail = None
    httpx = None

# ======================
# CONFIG
# ======================
INPUT_FILE = "steam_accounts.txt"
STEAM_LOGIN_URL = "https://store.steampowered.com/login/"
STEAM_ACCOUNT_URL = "https://store.steampowered.com/account/"
# Steam routes password changes through the help wizard.
STEAM_CHANGE_PASSWORD_URL = (
    "https://help.steampowered.com/en/wizard/HelpChangePassword?redir=store/account/"
)
HEADLESS = False
GUARD_CODE_WAIT_SEC = 120
GUARD_POLL_INTERVAL_SEC = 3
# Optional file mapping email -> outlook token, so accounts without inline
# refresh_token|client_id columns can still auto-read the verification code.
# Line format: email|email_password|refresh_token|client_id  (same as steam_auto_login).
REFRESH_TOKENS_FILE = "refresh_tokens.txt"

# --- twitch rental DB (Cloudflare D1) integration, enabled with --db ---------
# Reads accounts whose rental is OVER from the twitch project's D1, rotates their
# Steam password, and writes the new (encrypted) password back. Crypto goes
# through _d1crypto.mjs so it byte-matches the worker's encryptSecret; D1 access
# is via `wrangler d1 execute` run in TWITCH_DIR. --remote hits production D1
# (default is the local miniflare D1).
TWITCH_DIR = "/Users/lequangha/WebstormProjects/twitch"
D1_DB_NAME = "fungaming-rentals"
_ENC_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_d1crypto.mjs")


def generate_password(length=14):
    """Generate a strong random password unlikely to be flagged as common."""
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    while True:
        pwd = "".join(random.choice(alphabet) for _ in range(length))
        if (any(c.islower() for c in pwd) and any(c.isupper() for c in pwd)
                and any(c.isdigit() for c in pwd) and any(c in "!@#$%^&*" for c in pwd)):
            return pwd


def load_accounts(path):
    """Parse accounts into dicts (steam_user, steam_pass, email, refresh_token,
    client_id). Two line formats are accepted:

      - PIPE (steam_register_v2 result):
          index|email|hotmail_pass|steam_user|steam_pass|country[|refresh_token|client_id]
        -> steam_user=field 4, steam_pass=field 5, email=field 2.
      - DASH (steam-credentials only):
          steam_user----steam_pass[----email]
        -> steam_user=field 1, steam_pass=field 2, email=field 3 if present.

    Blank/#-comment lines are skipped; deduped by steam_user."""
    accounts, seen = [], set()
    if not os.path.exists(path):
        return accounts
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "|" in line:
                p = [x.strip() for x in line.split("|")]
                if len(p) < 5:
                    continue
                acc = {
                    "email": p[1],
                    "steam_user": p[3],
                    "steam_pass": p[4],
                    "refresh_token": p[6] if len(p) > 6 else "",
                    "client_id": p[7] if len(p) > 7 else "",
                }
            elif "----" in line:
                p = [x.strip() for x in line.split("----")]
                if len(p) < 2:
                    continue
                acc = {
                    "email": p[2] if len(p) > 2 else "",
                    "steam_user": p[0],
                    "steam_pass": p[1],
                    "refresh_token": "",
                    "client_id": "",
                }
            else:
                continue
            if not acc["steam_user"] or not acc["steam_pass"]:
                continue
            if acc["steam_user"] in seen:
                continue
            seen.add(acc["steam_user"])
            accounts.append(acc)
    return accounts


def load_refresh_tokens(file_path=REFRESH_TOKENS_FILE):
    """Load outlook tokens keyed by lowercased email from a
    'email|email_pass|refresh_token|client_id' file. Returns {email: (rt, ci)}."""
    tokens = {}
    if not os.path.exists(file_path):
        return tokens
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            p = line.split("|")
            if len(p) < 4:
                continue
            email, rt, ci = p[0].strip().lower(), p[2].strip(), p[3].strip()
            if email and rt and ci:
                tokens[email] = (rt, ci)
    return tokens


def _load_enc_key():
    """ACCOUNT_ENC_KEY from the environment, else from TWITCH_DIR/.dev.vars."""
    if os.environ.get("ACCOUNT_ENC_KEY"):
        return os.environ["ACCOUNT_ENC_KEY"]
    path = os.path.join(TWITCH_DIR, ".dev.vars")
    if os.path.exists(path):
        for line in open(path, "r", encoding="utf-8"):
            m = re.match(r"\s*(?:export\s+)?ACCOUNT_ENC_KEY\s*=\s*(.+)", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    return ""


# /api/read-code reads mailboxes over Microsoft Graph, so it can only ever help
# for Microsoft-hosted addresses. Most of the pool is on other providers, where a
# call would just burn time and rate limit before failing. Extend this tuple if
# more Microsoft domains show up (live.com, msn.com...).
GRAPH_MAIL_DOMAINS = ("outlook.com", "hotmail.com")


def _is_graph_mailbox(email):
    """True if this address is one the mail API can actually read."""
    domain = str(email or "").rsplit("@", 1)[-1].strip().lower()
    return domain in GRAPH_MAIL_DOMAINS


def _can_use_mail_api(acc):
    """Whether it is worth calling /api/read-code for this account at all."""
    return bool(_load_mail_api_key()) and _is_graph_mailbox(acc.get("email"))


def _load_mail_api_key():
    """MAIL_API_KEY from the environment, else from TWITCH_DIR/.dev.vars.

    Same lookup as _load_enc_key so the key lives in one gitignored place rather
    than being pasted into this file."""
    if os.environ.get("MAIL_API_KEY"):
        return os.environ["MAIL_API_KEY"]
    path = os.path.join(TWITCH_DIR, ".dev.vars")
    if os.path.exists(path):
        for line in open(path, "r", encoding="utf-8"):
            m = re.match(r"\s*(?:export\s+)?MAIL_API_KEY\s*=\s*(.+)", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    return ""


def _read_code_api(acc):
    """One call to the fungamingtool /api/read-code endpoint.

    Returns the newest code in the mailbox, or "" if there is none / the call
    fails. Credentials are optional: with refresh_token+client_id it reads
    statelessly, otherwise the server looks the account up by email — which is
    what makes this work in --db mode, where D1 stores no outlook tokens.
    """
    # Guard here too, not just at the call sites, so no future caller can leak a
    # non-Microsoft mailbox into a pointless Graph lookup.
    if not _is_graph_mailbox(acc.get("email")):
        return ""
    key = _load_mail_api_key()
    if not key:
        return ""
    os.environ["MAIL_API_KEY"] = key
    try:
        from mail_code_client import read_code
    except Exception as e:
        print(f"  mail_code_client unavailable: {e}")
        return ""
    try:
        return read_code(acc.get("email", ""),
                         acc.get("refresh_token") or None,
                         acc.get("client_id") or None) or ""
    except Exception as e:
        print(f"  [{acc.get('steam_user')}] read-code API: {e}")
        return ""


def poll_new_code(acc, before_code, max_wait=GUARD_CODE_WAIT_SEC,
                  poll_interval=GUARD_POLL_INTERVAL_SEC):
    """Wait for a code that is NOT the one already sitting in the mailbox.

    /api/read-code returns "the newest email carrying a code" with no timestamp,
    so a plain call can hand back the code from a PREVIOUS request. Steam codes
    are single-use, so submitting a stale one just burns the attempt and fails
    confusingly. Snapshotting before the send and waiting for a change is what
    makes this reliable."""
    if not _can_use_mail_api(acc):
        return ""
    label = acc.get("steam_user")
    deadline = time.time() + max_wait
    while time.time() < deadline:
        code = _read_code_api(acc)
        if code and code != before_code:
            return code
        time.sleep(poll_interval)
    return ""


def _crypto(mode, value, key):
    """enc/dec a value via the Node WebCrypto helper (matches the worker)."""
    r = subprocess.run(
        ["node", _ENC_HELPER, mode, value], cwd=TWITCH_DIR,
        capture_output=True, text=True, env={**os.environ, "ACCOUNT_ENC_KEY": key})
    if r.returncode != 0:
        raise RuntimeError(f"crypto {mode} failed: {(r.stderr or '').strip()}")
    return r.stdout


def _d1(sql, remote):
    """Run one SQL statement against the D1 DB via wrangler (in TWITCH_DIR).
    Returns the result rows (list of dicts) for SELECTs."""
    cmd = ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
           "--remote" if remote else "--local", "--json", "--command", sql]
    r = subprocess.run(cmd, cwd=TWITCH_DIR, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"wrangler d1 failed: {(r.stderr or '').strip()[:300]}")
    try:
        data = json.loads(r.stdout)
    except Exception:
        return []
    block = data[0] if isinstance(data, list) else data
    return block.get("results", []) if isinstance(block, dict) else []


def load_accounts_from_db(remote, key):
    """Accounts whose rental is OVER — status 'available' with an expired order —
    decrypted for login. Returns account dicts with db_id + last_expired."""
    sql = ("SELECT sa.id AS id, sa.login AS login, sa.password_enc AS password_enc, "
           "sa.email AS email, MAX(o.expires_at) AS last_expired "
           "FROM steam_accounts sa "
           "JOIN orders o ON o.account_id = sa.id AND o.status = 'expired' "
           "WHERE sa.status = 'available' GROUP BY sa.id")
    accounts = []
    for r in _d1(sql, remote):
        enc = r.get("password_enc") or ""
        try:
            pw = _crypto("dec", enc, key) if enc else ""
        except Exception as e:
            print(f"  [{r.get('login')}] decrypt failed: {e}")
            continue
        if not pw:
            continue
        accounts.append({
            "db_id": r.get("id"),
            "steam_user": r.get("login"),
            "steam_pass": pw,
            "email": r.get("email") or "",
            "refresh_token": "",
            "client_id": "",
            "last_expired": r.get("last_expired"),
        })
    return accounts


def update_db_password(db_id, new_pass, remote, key):
    """Store the rotated password and return the account to the rental pool.

    The status flip is guarded in SQL: an account still held by an ACTIVE rental
    keeps whatever status it has, so rotating a password can never hand the same
    login out to a second customer while the first one still holds it. (That
    matters for --account, which loads accounts regardless of status.)

    The b64url ciphertext is quote-safe so it's inlined into the SQL.
    Returns the account's resulting status."""
    enc = _crypto("enc", new_pass, key)
    # Return to the pool ONLY from a state that belongs to the pool. Two states
    # must survive a rotation untouched:
    #   'rented'          - a customer still holds it (would double-book)
    #   'sold'/'disabled' - deliberately out of the rental business; flipping
    #                       these to 'available' would silently put a sold or
    #                       retired account back up for rent.
    rows = _d1(
        "UPDATE steam_accounts SET "
        f"password_enc = '{enc}', "
        "status = CASE "
        "  WHEN status IN ('sold', 'disabled') THEN status "
        "  WHEN EXISTS (SELECT 1 FROM orders WHERE account_id = steam_accounts.id "
        "               AND status = 'active') THEN status "
        "  ELSE 'available' END "
        f"WHERE id = {int(db_id)} "
        "RETURNING status",
        remote)
    return (rows[0].get("status") if rows else "") or ""


def _cli_values(argv, name):
    """Collect values for --name <v> / --name=v (repeatable, comma-separated)."""
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == f"--{name}" and i + 1 < len(argv):
            out += [x.strip() for x in argv[i + 1].split(",") if x.strip()]
            i += 2
            continue
        if a.startswith(f"--{name}="):
            out += [x.strip() for x in a.split("=", 1)[1].split(",") if x.strip()]
        i += 1
    return out


def load_db_accounts_by_login(logins, remote, key):
    """Load specific accounts from the DB by login (ANY status — bypasses the
    rental-over filter), decrypted for login. For the --account force option."""
    if not logins:
        return []
    quoted = ",".join("'" + s.replace("'", "''") + "'" for s in logins)
    sql = (f"SELECT id, login, password_enc, email FROM steam_accounts "
           f"WHERE login IN ({quoted})")
    accounts = []
    for r in _d1(sql, remote):
        enc = r.get("password_enc") or ""
        try:
            pw = _crypto("dec", enc, key) if enc else ""
        except Exception as e:
            print(f"  [{r.get('login')}] decrypt failed: {e}")
            continue
        if not pw:
            continue
        accounts.append({
            "db_id": r.get("id"),
            "steam_user": r.get("login"),
            "steam_pass": pw,
            "email": r.get("email") or "",
            "refresh_token": "",
            "client_id": "",
            "last_expired": None,
        })
    return accounts


def load_done(path):
    """Steam usernames already recorded in the result file."""
    done = set()
    if not os.path.exists(path):
        return done
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            u = line.strip().split("|", 1)[0]
            if u:
                done.add(u)
    return done


def read_email_code(acc):
    """Fetch the latest email verification code for this account via the
    fungamingtool mail-code API, which reads the mailbox over Graph and extracts
    the Steam/PoE/numeric code server-side. Needs refresh_token (+ client_id).
    Returns the code string, or "" if not available."""
    if not acc.get("refresh_token"):
        return ""
    try:
        from mail_code_client import read_code
        code = read_code(acc["email"], acc["refresh_token"], acc.get("client_id") or None)
        if code:
            print(f"  [{acc['steam_user']}] email code: {code}")
        return code
    except Exception as e:
        print(f"  [{acc['steam_user']}] email code read failed: {e}")
        return ""


def _get_chrome_path():
    return ChromeDriverManager().install()


def create_driver(chrome_path):
    """A fresh, temporary Chrome profile per account (clean login each time)."""
    import tempfile
    profile_dir = tempfile.mkdtemp(prefix="steam_chpw_")
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile_dir}")
    if HEADLESS:
        opts.add_argument("--headless=new")
        opts.add_argument("--window-size=1440,900")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-popup-blocking")
    opts.add_experimental_option("prefs", {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
    })
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(service=Service(chrome_path), options=opts)
    driver.set_window_size(1200, 900)
    return driver


def _is_logged_in(driver):
    """True if the current page indicates a signed-in session (ported from
    steam_auto_login.py). Steam redirects /login/ to the store home when signed
    in; the logged-out page sets body class 'login' / logged_in:false."""
    try:
        if "/login" not in (driver.current_url or "").lower():
            return True
    except Exception:
        pass
    try:
        config = driver.find_element(By.ID, "application_config")
        userinfo = config.get_attribute("data-userinfo") or ""
        if '"logged_in":true' in userinfo:
            return True
        if '"logged_in":false' in userinfo:
            return False
    except Exception:
        pass
    try:
        body_class = (driver.find_element(By.TAG_NAME, "body").get_attribute("class") or "").lower()
        if "login" in body_class.split():
            return False
    except Exception:
        pass
    return bool(driver.find_elements(
        By.CSS_SELECTOR, "a[href*='logout'], .playerAvatar, #account_pulldown"))


def _find_login_inputs(driver, wait):
    """Find username + password inputs on Steam's React login form. Anchors on the
    (unique) visible password field and scopes the username to the same form,
    avoiding the store search box. Ported from steam_auto_login.py."""
    def find_in_context():
        try:
            WebDriverWait(driver, 20).until(
                lambda d: any(el.is_displayed() for el in
                              d.find_elements(By.CSS_SELECTOR, 'input[type="password"]')))
        except Exception:
            return None, None
        password = next(
            (el for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="password"]')
             if el.is_displayed()), None)
        if not password:
            return None, None
        username = driver.execute_script(
            """
            const pwd = arguments[0];
            const form = pwd.closest('form') || pwd.parentElement;
            let node = form;
            for (let i = 0; i < 5 && node; i++) {
                const candidates = node.querySelectorAll('input[type="text"], input:not([type])');
                for (const el of candidates) {
                    if (el === pwd || el.offsetParent === null) continue;
                    const name = (el.getAttribute('name') || '').toLowerCase();
                    const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                    if (ph.includes('search') || name.includes('search') || name === 'term') continue;
                    return el;
                }
                node = node.parentElement;
            }
            return null;
            """,
            password,
        )
        return username, password

    wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
    u, p = find_in_context()
    if u and p:
        return u, p
    for frame in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            driver.switch_to.frame(frame)
            u, p = find_in_context()
            if u and p:
                return u, p
        except Exception:
            pass
        finally:
            driver.switch_to.default_content()
    return None, None


def _is_steam_guard_prompt(driver):
    """True if the Steam Guard code prompt is showing (email or mobile)."""
    try:
        return bool(driver.execute_script(
            "const t = (document.body && document.body.innerText) || '';"
            "return t.includes('Enter the code from your email address')"
            "    || t.includes('Steam Guard Mobile Authenticator');"))
    except Exception:
        return False


async def _fetch_steam_guard_code(email, refresh_token, client_id, since_iso,
                                  max_wait=GUARD_CODE_WAIT_SEC,
                                  poll_interval=GUARD_POLL_INTERVAL_SEC):
    """Poll Hotmail (Graph) for a Steam Guard code that arrived after since_iso."""
    if not (Hotmail and httpx):
        return None
    h = Hotmail(f"{email}|password|{refresh_token}|{client_id}")
    if await h.update_access_token_graph() != 0 or not h.access_token:
        return None
    headers = {"Authorization": f"Bearer {h.access_token}"}
    params = {"$select": "subject,from,receivedDateTime,bodyPreview",
              "$top": "5", "$orderby": "receivedDateTime desc"}
    deadline = time.time() + max_wait
    code_re = re.compile(r"\b([A-Z0-9]{5})\b")
    async with httpx.AsyncClient(timeout=10.0) as client:
        while time.time() < deadline:
            try:
                resp = await client.get("https://graph.microsoft.com/v1.0/me/messages",
                                        headers=headers, params=params)
            except Exception:
                resp = None
            if resp is not None and resp.status_code == 200:
                for msg in resp.json().get("value", []):
                    if (msg.get("receivedDateTime") or "") < since_iso:
                        continue
                    subject = msg.get("subject") or ""
                    preview = msg.get("bodyPreview") or ""
                    sender = ((msg.get("from") or {}).get("emailAddress") or {}).get("address") or ""
                    if "steam" not in (sender + subject).lower():
                        continue
                    m = code_re.search(subject) or code_re.search(preview)
                    if m:
                        return m.group(1)
            await asyncio.sleep(poll_interval)
    return None


def _enter_steam_guard_code(driver, code):
    """Type `code` into Steam's per-digit Guard inputs."""
    boxes = driver.execute_script(
        "return Array.from(document.querySelectorAll('input'))"
        ".filter(el => el.offsetParent !== null && el.maxLength === 1);")
    if boxes and len(boxes) >= len(code):
        for el, ch in zip(boxes, code):
            try:
                el.clear()
            except Exception:
                pass
            el.send_keys(ch)
        return True
    return False


def steam_login(driver, acc):
    """Log into Steam using acc['steam_user'] + acc['steam_pass']. Handles the
    email Steam Guard prompt automatically if acc has refresh_token/client_id.
    Returns True once signed in. (Login logic ported from steam_auto_login.py.)"""
    username, password = acc["steam_user"], acc["steam_pass"]
    label = username
    try:
        driver.get(STEAM_LOGIN_URL)
        wait = WebDriverWait(driver, 25)
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        if _is_logged_in(driver):
            print(f"  [{label}] already logged in.")
            return True

        user_input, pass_input = _find_login_inputs(driver, wait)
        if not user_input or not pass_input:
            if _is_steam_guard_prompt(driver):
                print(f"  [{label}] Steam Guard prompt before login — manual entry needed.")
            else:
                print(f"  [{label}] could not find login form (username/password).")
            return False

        user_input.clear()
        user_input.send_keys(username)
        pass_input.clear()
        pass_input.send_keys(password)
        print(f"  [{label}] entered credentials")
        # Snapshot before submitting: Steam Guard may email a code, and we must
        # not resubmit one left over from an earlier attempt.
        guard_before = _read_code_api(acc) if _can_use_mail_api(acc) else ""
        submit_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        pass_input.send_keys(Keys.ENTER)
        print(f"  [{label}] submitted login")

        try:
            WebDriverWait(driver, 25).until(
                lambda d: _is_logged_in(d) or _is_steam_guard_prompt(d))
        except Exception:
            print(f"  [{label}] login did not complete within timeout.")
            return False

        if _is_steam_guard_prompt(driver):
            code = None
            if _can_use_mail_api(acc):
                print(f"  [{label}] Steam Guard prompt — asking /api/read-code for {acc['email']}...")
                # `guard_before` was snapshotted before the login was submitted.
                code = poll_new_code(acc, guard_before) or None
            if not code and acc.get("refresh_token") and acc.get("client_id"):
                print(f"  [{label}] Steam Guard prompt — polling Graph for code...")
                try:
                    code = asyncio.run(_fetch_steam_guard_code(
                        acc["email"], acc["refresh_token"], acc["client_id"], submit_iso))
                except Exception as err:
                    print(f"  [{label}] Guard code fetch failed: {err}")
            if not code:
                try:
                    code = input(f"  [{label}] enter the Steam Guard code sent to {acc['email']}: ").strip() or None
                except EOFError:
                    code = None
            if not code:
                print(f"  [{label}] Steam Guard code unavailable.")
                return False
            print(f"  [{label}] entering Steam Guard code {code}...")
            if not _enter_steam_guard_code(driver, code):
                print(f"  [{label}] Guard input fields not found.")
                return False
            try:
                WebDriverWait(driver, 25).until(_is_logged_in)
            except Exception:
                pass

        if not _is_logged_in(driver):
            print(f"  [{label}] login FAILED (still on login page).")
            return False
        print(f"  [{label}] logged in.")
        return True
    except Exception as e:
        print(f"  [{label}] login error: {e}")
        return False


def _dump_page(driver, label, tag):
    """Save the current page so the change-password markup can be inspected."""
    try:
        path = f"chpw_{tag}_{label}.html"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(driver.page_source)
        print(f"  [{label}] page dumped -> {path} (url={driver.current_url})")
    except Exception as e:
        print(f"  [{label}] page dump failed: {e}")


def change_password(driver, acc, old_pass, new_pass):
    """Open Steam's change-password wizard and set the new password.

    Steam's change-password flow lives on help.steampowered.com and its exact
    markup isn't wired yet, so this navigates there and DUMPS the page. Once we
    have the real HTML, fill: current-password field, new-password + confirm
    fields, the email verification code (read_email_code), and the submit button
    (FILL_SELECTORS below). Returns a status string."""
    label = acc["steam_user"]
    try:
        print(f"  [{label}] opening change-password: {STEAM_CHANGE_PASSWORD_URL}")
        driver.get(STEAM_CHANGE_PASSWORD_URL)
        # The wizard redirects to HelpWithLoginInfoSendCode with the "email me a
        # code" button. Wait for that button.
        try:
            WebDriverWait(driver, 30).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, "a.help_wizard_button"))
        except Exception:
            pass
        time.sleep(random.uniform(1.0, 2.0))

        # Snapshot whatever code is already in the mailbox BEFORE asking Steam to
        # send a new one, so poll_new_code can tell the new mail from the old.
        before_code = _read_code_api(acc)
        if before_code:
            print(f"  [{label}] mailbox already holds code {before_code} — will wait for a different one")

        # Step 1: click "Email an account verification code to <email>" — an <a>
        # linking to the EnterCode page; navigating there makes Steam email the code.
        submit_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        clicked = driver.execute_script(
            "for (const a of document.querySelectorAll('a.help_wizard_button')) {"
            "  const href = a.getAttribute('href') || '';"
            "  if (href.includes('HelpWithLoginInfoEnterCode')) { a.click(); return href; }"
            "}"
            "return '';"
        )
        if not clicked:
            _dump_page(driver, label, "sendcode")
            print(f"  [{label}] 'email code' button not found — dumped page.")
            return "NO_SENDCODE_BUTTON"
        print(f"  [{label}] requested email verification code (sent to account email)")

        # Step 2: EnterCode page — code input #forgot_login_code + "Continue".
        try:
            WebDriverWait(driver, 30).until(
                lambda d: d.find_elements(By.ID, "forgot_login_code"))
        except Exception:
            print(f"  [{label}] EnterCode page did not render (url={driver.current_url}).")
            _dump_page(driver, label, "entercode")
            return "NO_ENTERCODE"

        # Preferred: the fungamingtool /api/read-code endpoint. It reuses the same
        # per-provider code extraction as the /mail UI, and works without outlook
        # tokens because the server can look the mailbox up by email.
        code = ""
        if _can_use_mail_api(acc):
            print(f"  [{label}] waiting on /api/read-code for {acc['email']}...")
            code = poll_new_code(acc, before_code)
            if code:
                print(f"  [{label}] got code {code} from the mail API")
        elif acc.get("email") and not _is_graph_mailbox(acc.get("email")):
            print(f"  [{label}] {acc['email']} is not outlook/hotmail — skipping the mail API")

        # Fallback: read Graph directly, if this account carries inline tokens.
        if not code and acc.get("refresh_token") and acc.get("client_id"):
            print(f"  [{label}] mail API had nothing; polling Graph directly...")
            try:
                code = asyncio.run(_fetch_steam_guard_code(
                    acc["email"], acc["refresh_token"], acc["client_id"], submit_iso)) or ""
            except Exception as err:
                print(f"  [{label}] code fetch failed: {err}")

        if not code:
            # Last resort: a human reads the mailbox.
            try:
                code = input(f"  [{label}] enter the code emailed to {acc['email']}: ").strip()
            except EOFError:
                code = ""
        if not code:
            print(f"  [{label}] no verification code — aborting.")
            return "NO_CODE"

        code_input = driver.find_element(By.ID, "forgot_login_code")
        code_input.clear()
        code_input.send_keys(code)
        print(f"  [{label}] entered code {code}")
        try:
            driver.find_element(
                By.CSS_SELECTOR,
                "input[type='submit'][value='Continue'], input[type='submit']").click()
        except Exception:
            code_input.send_keys(Keys.ENTER)
        print(f"  [{label}] submitted verification code")
        time.sleep(random.uniform(2.0, 4.0))

        # Rejected code => still on the EnterCode form.
        if driver.find_elements(By.ID, "forgot_login_code"):
            print(f"  [{label}] code not accepted (still on EnterCode).")
            _dump_page(driver, label, "entercode_after")
            return "CODE_REJECTED"

        # Step 3: reset-password page — set the new password twice and submit.
        try:
            WebDriverWait(driver, 30).until(
                lambda d: d.find_elements(By.ID, "password_reset"))
        except Exception:
            print(f"  [{label}] reset-password page did not render (url={driver.current_url}).")
            _dump_page(driver, label, "resetpw")
            return "NO_RESETPW"

        pw = driver.find_element(By.ID, "password_reset")
        pw.clear()
        pw.send_keys(new_pass)
        confirm = driver.find_element(By.ID, "password_reset_confirm")
        confirm.clear()
        confirm.send_keys(new_pass)
        # Fire the events Steam's strength/confirm check listens on, so the submit
        # is accepted.
        driver.execute_script(
            "for (const id of ['password_reset', 'password_reset_confirm']) {"
            "  const el = document.getElementById(id);"
            "  if (el) {"
            "    el.dispatchEvent(new Event('input', {bubbles: true}));"
            "    el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true}));"
            "    el.dispatchEvent(new Event('change', {bubbles: true}));"
            "  }"
            "}")
        print(f"  [{label}] entered new password")
        time.sleep(random.uniform(1.0, 2.0))
        try:
            driver.find_element(
                By.CSS_SELECTOR,
                "input[type='submit'][value='Change Password'], input[type='submit']").click()
        except Exception:
            confirm.send_keys(Keys.ENTER)
        print(f"  [{label}] submitted new password")

        # Success shows a confirmation ("...password has been changed"); a rejected
        # password keeps the reset form on screen.
        end = time.time() + 30
        while time.time() < end:
            body = ""
            try:
                body = (driver.find_element(By.TAG_NAME, "body").text or "").lower()
            except Exception:
                pass
            if ("has been changed" in body or "password has been reset" in body
                    or "success" in (driver.current_url or "").lower()):
                print(f"  [{label}] ✅ password changed.")
                return "OK"
            if not driver.find_elements(By.ID, "password_reset"):
                # Left the reset form with no error still shown — treat as success.
                print(f"  [{label}] ✅ password changed (reset form gone).")
                return "OK"
            time.sleep(1.0)

        _dump_page(driver, label, "resetpw_after")
        print(f"  [{label}] password change NOT confirmed (still on reset form) — "
              f"dumped page. The new password may have been rejected.")
        return "CHANGE_UNCONFIRMED"
    except Exception as e:
        print(f"  [{label}] change-password error: {e}")
        return "ERROR"


def main():
    args = sys.argv[1:]
    force = "--force" in args
    keep_open = "--keep-open" in args
    use_db = "--db" in args
    remote = "--remote" in args
    # --account <login>[,<login>...] : force a password change for these specific
    # accounts (bypasses the rental-over selection and the already-done skip).
    account_logins = _cli_values(args, "account")
    positional = [a for a in args if not a.startswith("--")]
    input_file = positional[0] if positional else INPUT_FILE

    enc_key = ""
    if use_db:
        # Source accounts from the twitch rental D1 instead of a file.
        enc_key = _load_enc_key()
        if not enc_key:
            print("ACCOUNT_ENC_KEY not found (set env or twitch/.dev.vars).")
            sys.exit(1)
        result_file = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "rental_rotate_results.txt")
        where = "REMOTE (production)" if remote else "local"
        try:
            if account_logins:
                print(f"[db] source: twitch D1 '{D1_DB_NAME}' ({where}) — FORCING "
                      f"password change for {len(account_logins)} specified account(s): "
                      f"{', '.join(account_logins)}")
                accounts = load_db_accounts_by_login(account_logins, remote, enc_key)
            else:
                print(f"[db] source: twitch D1 '{D1_DB_NAME}' ({where}) — rotating "
                      f"passwords for accounts whose rental is over.")
                accounts = load_accounts_from_db(remote, enc_key)
        except Exception as e:
            print(f"[db] failed to load accounts from D1: {e}")
            sys.exit(1)
    else:
        if not os.path.exists(input_file):
            print(f"Input file not found: {input_file}")
            sys.exit(1)
        result_file = input_file + ".newpass.txt"
        accounts = load_accounts(input_file)
        if account_logins:
            wanted = {s.lower() for s in account_logins}
            accounts = [a for a in accounts if a["steam_user"].lower() in wanted]
            print(f"[account] limiting to {len(accounts)} specified account(s).")

    if not accounts:
        print("No accounts to process.")
        return

    done = set() if (force or account_logins) else load_done(result_file)
    todo = [a for a in accounts if a["steam_user"] not in done]
    print(f"Loaded {len(accounts)} account(s); {len(todo)} to process "
          f"({len(accounts) - len(todo)} already done)"
          f"{' [FORCE]' if force else ''}{' [ACCOUNT]' if account_logins else ''}.")
    if not todo:
        print("Nothing to do.")
        return

    # Fill in refresh_token/client_id from the tokens file for accounts that
    # don't carry them inline, so the email code can be read automatically.
    refresh_tokens = load_refresh_tokens()
    if refresh_tokens:
        print(f"Loaded {len(refresh_tokens)} token(s) from {REFRESH_TOKENS_FILE}.")
    for a in todo:
        if not a.get("refresh_token") and a.get("email"):
            tok = refresh_tokens.get(a["email"].lower())
            if tok:
                a["refresh_token"], a["client_id"] = tok

    # Production is irreversible (real password changes + live DB writes): confirm.
    if use_db and remote and not force:
        try:
            ans = input(f"[db] About to change Steam passwords for {len(todo)} account(s) "
                        f"on PRODUCTION and update the live DB. Type 'yes' to proceed: ").strip().lower()
        except EOFError:
            ans = ""
        if ans not in ("yes", "y"):
            print("Aborted.")
            return

    chrome_path = _get_chrome_path()

    def record(steam_user, email, old_pass, new_pass, status):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(result_file, "a", encoding="utf-8") as f:
            f.write(f"{steam_user}|{email}|{old_pass}|{new_pass}|{status}|{ts}\n")

    for n, acc in enumerate(todo, start=1):
        user = acc["steam_user"]
        print(f"\n===== [{n}/{len(todo)}] {user} =====")
        driver = None
        new_pass = generate_password()
        try:
            driver = create_driver(chrome_path)
            if not steam_login(driver, acc):
                record(user, acc["email"], acc["steam_pass"], "", "LOGIN_FAILED")
                print(f"  ❌ [{user}] LOGIN_FAILED")
                continue
            status = change_password(driver, acc, acc["steam_pass"], new_pass)
            # On success in --db mode, write the new (encrypted) password back to
            # the rental DB so the freed account carries the rotated credential.
            if status == "OK" and use_db:
                try:
                    new_status = update_db_password(acc["db_id"], new_pass, remote, enc_key)
                    print(f"  [{user}] DB password_enc updated, status={new_status or '?'} "
                          f"(id={acc['db_id']}).")
                    if new_status in ("sold", "disabled"):
                        # Only reachable via --account. Left alone on purpose: it
                        # is not part of the rental pool any more.
                        print(f"  ℹ️  [{user}] password rotated but status kept as "
                              f"'{new_status}' — not returned to the rental pool.")
                        status = f"OK_KEPT_{new_status.upper()}"
                    elif new_status and new_status != "available":
                        # Only reachable via --account: the account is still out on
                        # a live rental, so it was deliberately NOT returned to the
                        # pool. The renter is now holding a dead password.
                        print(f"  ⚠️  [{user}] still on an ACTIVE rental — left as "
                              f"'{new_status}' instead of 'available'. That renter's "
                              f"password is now stale: send them the new one, or end "
                              f"the rental before rotating.")
                        status = "OK_STILL_RENTED"
                except Exception as e:
                    print(f"  [{user}] DB update FAILED: {e}")
                    status = "OK_DB_UPDATE_FAILED"
            recorded_new = new_pass if status.startswith("OK") else ""
            record(user, acc["email"], acc["steam_pass"], recorded_new, status)
            icon = "✅" if status.startswith("OK") else "⚠️"
            print(f"  {icon} [{user}] {status}")
        except Exception as e:
            print(f"  [{user}] error: {e}")
            record(user, acc["email"], acc["steam_pass"], "", "ERROR")
        finally:
            if driver is not None and not keep_open:
                try:
                    driver.quit()
                except Exception:
                    pass
            time.sleep(random.uniform(1.5, 3.0))

    if keep_open:
        print("⏸  --keep-open — browser window(s) stay open. Press Ctrl+C to exit.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
