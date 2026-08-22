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
  2. the mailbox's own WEBMAIL, for the providers Graph cannot read — chiefly
     @qinianstm.com on mail.qisteam.com, which is most of this pool. Signs in with
     the mailbox password and reads the newest messages through
     scripts/open_qisteam_mail.py, whose reader and classifier are reused rather
     than copied. Needs that password: field 4 of a `----` line, or
     steam_accounts.email_password_enc in --db mode.
  3. Microsoft Graph directly, if the account carries refresh_token|client_id.
  4. a manual prompt.

Which code is taken differs by step. A Guard prompt during sign-in wants the
sign-in code; the change-password and change-email wizards want the
credential-change code Steam mails for exactly that purpose — the one
pickLoginCode refuses to serve a RENTER. Here the operator owns the account, so
that code is what is asked for, and the label of whatever is used is printed.

That endpoint returns "the newest email carrying a code" with no timestamp, so
the code present BEFORE the send is snapshotted and poll_new_code waits for a
different one. Steam codes are single-use: submitting a stale one just burns the
attempt and fails confusingly.

Flow (all on help.steampowered.com): log in -> open the change-password wizard
-> click "Email an account verification code" -> read the emailed code (via the
outlook token, or a manual prompt) and submit it -> set the new password twice on
the reset page and submit. Status OK means the new password is live (and recorded).

Already-done accounts (present in the result file) are skipped; pass --force to redo.
For an unattended/scheduled run use --yes, NOT --force: --yes skips the production
confirmation prompt while leaving the already-done list in place, so the same
account is not rotated over and over.

--db mode: instead of a file, source accounts from the twitch rental DB
(Cloudflare D1 'fungaming-rentals') whose rental is OVER (status 'available' with
an expired order), decrypt each login password, rotate it, and write the new
ENCRYPTED password back to steam_accounts.password_enc. --remote hits production
(default is the local D1); production runs prompt for confirmation. Crypto is done
via _d1crypto.mjs (byte-identical to the worker's AES-GCM).

Immediately before each password change the pool is re-read, and the account is
skipped if it has been rented again while earlier accounts were being processed
(see rental_restarted) — rotating then would lock out a paying customer.

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

--mode email changes the account's contact ADDRESS instead of its password, through
Steam's HelpChangeEmail wizard. Two mailboxes are involved: Steam verifies identity
with a code to the CURRENT address (the same first half as the password wizard, hence
_wizard_identity_code), then confirms ownership with a second code sent to the NEW
one. Both therefore have to be readable — an outlook/hotmail new address is read
automatically, anything else prompts.

One account per run, enforced: a single address cannot serve a batch, and pointing
forty accounts at one mailbox would hand whoever holds it the ability to reset every
one of those passwords.

In --db mode a success also repoints steam_accounts.email. Pass
--new-email-password to store the new mailbox's password too — without it the row
keeps the OLD mailbox's password beside the NEW address, which looks usable and is
not.

CAUTION: an email change is not a password change. Whoever controls the address can
reset the Steam password afterwards, and Steam may restrict the account and end
active sessions — so do not run it on a login a customer is currently renting.
The markup past the identity step is not pinned the way the reset-password page is;
a miss dumps the page (chpw_changeemail_*.html) so the real selector can be added
instead of guessed at again.

Usage:
    python steam_change_password.py [accounts.txt] [--force] [--keep-open]
    python steam_change_password.py --db --remote --account <login> --mode email \
        --new-email new@outlook.com [--new-email-password <pw>]
    python steam_change_password.py --db [--remote] [--force] [--yes] [--keep-open]
    python steam_change_password.py --db [--remote] --repair-db
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
# Same wizard family as the password change, and it verifies identity the same way
# (a code to the CURRENT address). What differs is the second half: after the new
# address is submitted, Steam mails a confirmation code to the NEW mailbox, so a
# change-email run needs to read TWO different mailboxes.
STEAM_CHANGE_EMAIL_URL = (
    "https://help.steampowered.com/en/wizard/HelpChangeEmail?redir=store/account/"
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
TWITCH_DIR = '/home/haleserver/fungame/twitch'
# TWITCH_DIR = '/Users/lequangha/WebstormProjects/twitch'
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
                    # Field 3 is the mailbox password. Carried now because a
                    # non-Microsoft mailbox is read by signing into its webmail,
                    # which needs it.
                    "email_pass": p[2] if len(p) > 2 else "",
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
                    # Field 4 is the MAILBOX password (field 2 is Steam's). Notes
                    # are glued onto it in that file, hence the trim.
                    "email_pass": _clean_mail_pass(p[3]) if len(p) > 3 else "",
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


# --- Roundcube webmail (qinianstm.com and the other non-Microsoft hosts) ------
# Most of this pool's mailboxes are NOT Microsoft. @qinianstm.com is served by
# Roundcube at mail.qisteam.com, which Graph cannot read — so every rotation on
# those accounts fell through to the manual prompt, which is also the reason an
# unattended run could not touch them.
#
# scripts/open_qisteam_mail.py already signs into that webmail, reads the newest
# messages and labels each one using src/lib/steamcode.js's classifier, so it is
# imported rather than reimplemented here.
WEBMAIL_TIMEOUT_SEC = 40
WEBMAIL_SCAN_DEPTH = 3
# A webmail read is a page load plus a message open, so polling it as fast as the
# HTTP endpoint would hammer the host for no gain.
WEBMAIL_POLL_INTERVAL_SEC = 8

_QMAIL = None


def _qmail():
    """The open_qisteam_mail module, imported on first use, or None.

    Imported lazily and by path because this file exists in two places (repo root
    and scripts/) with different working directories, and because a missing
    selenium/webdriver install should only matter to a run that actually needs a
    webmail mailbox.
    """
    global _QMAIL
    if _QMAIL is not None:
        return _QMAIL or None
    here = os.path.dirname(os.path.abspath(__file__))
    for folder in (here, os.path.join(here, "scripts"), os.path.join(TWITCH_DIR, "scripts")):
        if not os.path.exists(os.path.join(folder, "open_qisteam_mail.py")):
            continue
        try:
            if folder not in sys.path:
                sys.path.insert(0, folder)
            import importlib
            _QMAIL = importlib.import_module("open_qisteam_mail")
            return _QMAIL
        except Exception as err:
            print(f"  webmail reader unavailable ({err})")
            break
    _QMAIL = False
    return None


def _clean_mail_pass(value):
    """Mailbox password with any note glued to its tail removed.

    steam_accounts.txt really does hold "131641-> day 2 1 tuan"; the note is not
    part of the password. Delegated to open_qisteam_mail so both parse that file
    the same way.
    """
    module = _qmail()
    if module:
        return module.clean_secret(value)
    return re.split(r"(\s|->|\u2192|\uff08|\(|,|;)", str(value or ""), 1)[0].strip()


def _webmail_url(email):
    """The webmail that serves this address, or "".

    The domain map lives in open_qisteam_mail.DOMAIN_HOSTS so the two cannot
    disagree about which host serves which domain.
    """
    module = _qmail()
    if not module:
        return ""
    domain = str(email or "").rsplit("@", 1)[-1].strip().lower()
    host = module.DOMAIN_HOSTS.get(domain, "")
    return f"http://{host}/" if host else ""


def _can_use_webmail(acc):
    """Whether this account's mailbox can be read over its webmail."""
    return bool(_webmail_url(acc.get("email")) and acc.get("email_pass"))


def _pick_code(purposes, want, label=""):
    """The code this step needs, out of the classifier's per-mail verdicts.

    `want` is 'credential_change' for the wizards — Steam's own mail says "the code
    you need to change your Steam login credentials" — and 'login' for a Guard
    prompt during sign-in.

    Falling back to ANY extracted code is deliberate, and is the one place this
    script parts company with the renter-facing endpoint. pickLoginCode refuses a
    credential-change code because handing one to a RENTER is an account transfer;
    here the operator owns the account and that code is precisely what the wizard is
    asking for. What the mail was labelled is printed either way, so a surprise is
    visible rather than silent.
    """
    for entry in purposes:
        if entry.get("code") and entry.get("purpose") == want:
            return entry["code"]
    for entry in purposes:
        if entry.get("code"):
            if label:
                print(f"  [{label}] using a code labelled '{entry.get('purpose')}' "
                      f"(wanted '{want}')")
            return entry["code"]
    return ""


class _WebmailSession:
    """A signed-in Roundcube session that can be re-read for new codes.

    Held open across a poll on purpose: signing in costs a browser launch, and
    relaunching Chrome every few seconds would take longer than a Steam code stays
    valid.
    """

    def __init__(self, acc):
        self.acc = acc
        self.label = acc.get("steam_user") or acc.get("email") or "?"
        self.url = _webmail_url(acc.get("email"))
        self.driver = None

    def open(self):
        module = _qmail()
        if not (module and self.url and self.acc.get("email_pass")):
            return False
        try:
            self.driver = module.create_driver(True, WEBMAIL_TIMEOUT_SEC)
            ok, detail = module.open_mailbox(
                self.driver,
                self.url,
                {"email": self.acc["email"], "password": self.acc["email_pass"]},
                WEBMAIL_TIMEOUT_SEC,
            )
        except Exception as err:
            print(f"  [{self.label}] webmail session failed: {err}")
            self.close()
            return False
        if not ok:
            print(f"  [{self.label}] webmail sign-in failed: {detail}")
            self.close()
            return False
        print(f"  [{self.label}] signed into {self.url} as {self.acc['email']}")
        return True

    def read(self, want):
        """The newest code in this mailbox that suits `want`, or ""."""
        module = _qmail()
        if not (module and self.driver):
            return ""
        # Back to the inbox first: a previous read left the browser on a message
        # page, where the list this reads has no rows to find.
        base = self.url.rstrip("/").split("?")[0]
        try:
            self.driver.get(f"{base}/?_task=mail&_mbox=INBOX")
            mails, why = module.read_newest_emails(
                self.driver, self.url, WEBMAIL_TIMEOUT_SEC, 1500, WEBMAIL_SCAN_DEPTH)
            if not mails:
                return ""
            verdict = module.classify_codes(mails, WEBMAIL_SCAN_DEPTH)
        except Exception as err:
            print(f"  [{self.label}] webmail read failed: {err}")
            return ""
        return _pick_code(verdict.get("purposes", []), want, self.label)

    def close(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None


def _read_code_webmail(acc, want):
    """One sign-in, one read, then close. Used for the pre-send snapshot."""
    session = _WebmailSession(acc)
    if not session.open():
        return ""
    try:
        return session.read(want)
    finally:
        session.close()


def _can_read_code(acc):
    """Whether this account's code can be read without a human."""
    return _can_use_mail_api(acc) or _can_use_webmail(acc)


def _read_code(acc, want="credential_change"):
    """The newest usable code for this account, from whichever mailbox it has."""
    if _can_use_mail_api(acc):
        return _read_code_api(acc)
    if _can_use_webmail(acc):
        return _read_code_webmail(acc, want)
    return ""


def _no_mailbox_reason(acc):
    """Why this account's code cannot be read automatically, for the log."""
    email = acc.get("email") or "(no address)"
    if _webmail_url(email) and not acc.get("email_pass"):
        return f"{email} has no mailbox password on record — cannot read its webmail"
    if not _webmail_url(email) and not _is_graph_mailbox(email):
        return f"{email} is neither outlook/hotmail nor a known webmail host"
    return f"{email} cannot be read automatically"


def poll_new_code(acc, before_code, max_wait=GUARD_CODE_WAIT_SEC,
                  poll_interval=GUARD_POLL_INTERVAL_SEC, want="credential_change"):
    """Wait for a code that is NOT the one already sitting in the mailbox.

    /api/read-code returns "the newest email carrying a code" with no timestamp,
    so a plain call can hand back the code from a PREVIOUS request. Steam codes
    are single-use, so submitting a stale one just burns the attempt and fails
    confusingly. Snapshotting before the send and waiting for a change is what
    makes this reliable."""
    if _can_use_mail_api(acc):
        deadline = time.time() + max_wait
        while time.time() < deadline:
            code = _read_code_api(acc)
            if code and code != before_code:
                return code
            time.sleep(poll_interval)
        return ""

    # Webmail: one sign-in, then re-read the inbox until something new shows up.
    if _can_use_webmail(acc):
        session = _WebmailSession(acc)
        if not session.open():
            return ""
        try:
            deadline = time.time() + max_wait
            while time.time() < deadline:
                code = session.read(want)
                if code and code != before_code:
                    return code
                time.sleep(max(poll_interval, WEBMAIL_POLL_INTERVAL_SEC))
        finally:
            session.close()
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


def _decrypt_mail_pass(row, key):
    """The row's mailbox password, or "" — never fatal.

    Needed to read a non-Microsoft mailbox over its webmail. A row without one, or
    one that will not decrypt, simply falls back to the manual prompt: losing the
    automatic code read is a nuisance, whereas skipping the account would leave a
    stale password in the rental pool.
    """
    enc = row.get("email_password_enc") or ""
    if not enc:
        return ""
    try:
        return _crypto("dec", enc, key)
    except Exception as err:
        print(f"  [{row.get('login')}] mailbox password decrypt failed: {err}")
        return ""


def load_accounts_from_db(remote, key):
    """Accounts whose rental is OVER — status 'available' with an expired order —
    decrypted for login. Returns account dicts with db_id + last_expired."""
    sql = ("SELECT sa.id AS id, sa.login AS login, sa.password_enc AS password_enc, "
           "sa.email AS email, sa.email_password_enc AS email_password_enc, "
           "MAX(o.expires_at) AS last_expired "
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
            "email_pass": _decrypt_mail_pass(r, key),
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


def repair_failed_db_writes(result_file, remote, enc_key, where):
    """Writes passwords that Steam already has but the database missed.

    An OK_DB_UPDATE_FAILED row means the rotation succeeded and only the DB write
    failed, so the correct new password is sitting in the result file. Re-running
    the rotation would change the Steam password AGAIN and burn another Guard code
    to recover something already recorded — this replays the write instead.

    Reads the LAST line per login, so an account repaired earlier is not repaired
    twice and one that later rotated cleanly is left alone.
    """
    if not os.path.exists(result_file):
        print(f"[repair] no result file at {result_file}")
        return

    latest = {}
    with open(result_file, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 5 or not parts[0]:
                continue
            latest[parts[0]] = {"new_pass": parts[3], "status": parts[4]}

    broken = {u: r for u, r in latest.items()
              if r["status"] == "OK_DB_UPDATE_FAILED" and r["new_pass"]}
    # A row with no recorded password cannot be repaired from here: the password is
    # only written to the file on success, so there is nothing to replay.
    unfixable = [u for u, r in latest.items()
                 if r["status"] == "OK_DB_UPDATE_FAILED" and not r["new_pass"]]

    print(f"[repair] {where}: {len(broken)} account(s) with a password Steam has "
          f"and the database does not.")
    if unfixable:
        print(f"[repair] {len(unfixable)} more cannot be repaired from the file "
              f"(no password recorded): {', '.join(unfixable)}")
    if not broken:
        return

    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for user, row in broken.items():
        accounts = load_db_accounts_by_login([user], remote, enc_key)
        if not accounts:
            print(f"  ⚠️  [{user}] not in the database — skipped")
            continue
        db_id = accounts[0]["db_id"]
        try:
            new_status = _db_write_with_retry(
                user, lambda: update_db_password(db_id, row["new_pass"], remote, enc_key))
            print(f"  ✅ [{user}] password written, status={new_status or '?'} (id={db_id})")
            with open(result_file, "a", encoding="utf-8") as f:
                # steam_user|email|old_pass|new_pass|status|timestamp — email and
                # old_pass are blank here because this replays a write, not a change.
                f.write(f"{user}|||{row['new_pass']}|OK_DB_REPAIRED|{ts}\n")
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️  [{user}] still failing: {e}")


def _db_write_with_retry(label, action, attempts=4, base_delay=3):
    """Runs a DB write, retrying a transient failure.

    By the time this is called the Steam password has ALREADY been changed, so
    giving up leaves the row holding a dead credential while the account sits in
    the rental pool — the next customer gets a login that cannot work. D1 fails
    transiently often enough to matter (D1_RESET_DO, a wrangler auth blip), so one
    attempt was never enough.

    Backs off linearly rather than hammering: 3s, 6s, 9s.
    """
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except Exception as e:  # noqa: BLE001 - any failure is worth another try
            last = e
            if attempt < attempts:
                wait = base_delay * attempt
                print(f"  ↻ [{label}] DB write failed ({e}); "
                      f"retry {attempt}/{attempts - 1} in {wait}s")
                time.sleep(wait)
    raise last


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


def rental_restarted(db_id, remote):
    """Why this account must NOT be rotated right now, or None if it is safe.

    Accounts are selected up front, but rotating one takes minutes — a browser
    session plus waiting on an email verification code. A customer who pays
    inside that window is handed this very login straight from the pool, so the
    "rental is over" fact that selected it can be stale by the time we get here.
    Changing the password then locks a paying renter out of a live rental.

    So the pool is re-read immediately before Steam is touched. An active order
    is the authority: status alone would miss the moment between a payment
    claiming the account and the order row landing.
    """
    sql = ("SELECT sa.status AS status, "
           "(SELECT COUNT(*) FROM orders o "
           "  WHERE o.account_id = sa.id AND o.status = 'active') AS active_orders "
           f"FROM steam_accounts sa WHERE sa.id = {int(db_id)}")
    rows = _d1(sql, remote)
    if not rows:
        return "deleted"
    row = rows[0]
    if int(row.get("active_orders") or 0) > 0:
        return "re-rented (active order)"
    status = (row.get("status") or "").strip()
    if status != "available":
        return f"status is now '{status}'"
    return None


def load_db_accounts_by_login(logins, remote, key):
    """Load specific accounts from the DB by login (ANY status — bypasses the
    rental-over filter), decrypted for login. For the --account force option."""
    if not logins:
        return []
    quoted = ",".join("'" + s.replace("'", "''") + "'" for s in logins)
    sql = (f"SELECT id, login, password_enc, email, email_password_enc "
           f"FROM steam_accounts WHERE login IN ({quoted})")
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
            "email_pass": _decrypt_mail_pass(r, key),
            "refresh_token": "",
            "client_id": "",
            "last_expired": None,
        })
    return accounts


def load_done(path):
    """Steam usernames already recorded in the result file.

    A SKIPPED_* row does not count as done. Being re-rented is temporary, and
    treating it as finished would retire the account from rotation for good —
    handing the next customer the password the previous renter still knows.
    """
    done = set()
    if not os.path.exists(path):
        return done
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split("|")
            u = parts[0] if parts else ""
            status = parts[4] if len(parts) > 4 else ""
            if u and not status.startswith("SKIPPED"):
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
        options.add_argument("--disable-gpu")
        options.add_argument("--remote-debugging-port=9222")
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
        guard_before = _read_code(acc, "login") if _can_read_code(acc) else ""
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
            if _can_read_code(acc):
                where = "/api/read-code" if _can_use_mail_api(acc) else _webmail_url(acc["email"])
                print(f"  [{label}] Steam Guard prompt — reading {acc['email']} via {where}...")
                # `guard_before` was snapshotted before the login was submitted.
                # A sign-in wants the sign-in code, not a credential-change one.
                code = poll_new_code(acc, guard_before, want="login") or None
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
        before_code = _read_code(acc)
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
        if _can_read_code(acc):
            where = "/api/read-code" if _can_use_mail_api(acc) else _webmail_url(acc["email"])
            print(f"  [{label}] waiting on {where} for {acc['email']}...")
            # The wizard's mail is the credential-change one ("the code you need to
            # change your Steam login credentials"), so that is what is asked for.
            code = poll_new_code(acc, before_code, want="credential_change")
            if code:
                print(f"  [{label}] got code {code} from {where}")
        elif acc.get("email"):
            print(f"  [{label}] {_no_mailbox_reason(acc)}")

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


# Steam's change-email page markup is not pinned the way the reset-password page is
# (#password_reset / #password_reset_confirm were learned from a real run). These are
# the plausible shapes, tried in order; a miss dumps the page so the real selector
# can be added rather than guessed at again.
NEW_EMAIL_INPUT_SELECTORS = (
    "input#email",
    "input#new_email",
    "input[name='email']",
    "input[name='new_email']",
    "input[type='email']",
)
CONFIRM_EMAIL_INPUT_SELECTORS = (
    "input#email_confirm",
    "input#new_email_confirm",
    "input[name='email_confirm']",
    "input[name='reenter_email']",
)


def _first_displayed(driver, selectors):
    """First visible element matching any of `selectors`, or None."""
    for sel in selectors:
        for el in driver.find_elements(By.CSS_SELECTOR, sel):
            try:
                if el.is_displayed():
                    return el
            except Exception:
                continue
    return None


def _submit_wizard_form(driver, fallback_el):
    """Click the wizard's submit button, falling back to Enter in the field."""
    for sel in ("input[type='submit']", "button[type='submit']", "button.btn_medium"):
        for el in driver.find_elements(By.CSS_SELECTOR, sel):
            try:
                if el.is_displayed():
                    el.click()
                    return True
            except Exception:
                continue
    try:
        fallback_el.send_keys(Keys.ENTER)
        return True
    except Exception:
        return False


def _wizard_identity_code(driver, acc, label):
    """Shared first half of both wizards: ask Steam to email a verification code to
    the account's CURRENT address, then read and submit it.

    Returns None on success, or a status string on failure."""
    try:
        WebDriverWait(driver, 30).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, "a.help_wizard_button"))
    except Exception:
        pass
    time.sleep(random.uniform(1.0, 2.0))

    # Snapshot first: the endpoint returns "newest code in the mailbox" with no
    # timestamp, so without this a stale code gets submitted and burns the attempt.
    before_code = _read_code(acc)
    if before_code:
        print(f"  [{label}] mailbox already holds code {before_code} — will wait for a different one")

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
    print(f"  [{label}] requested email verification code (sent to the CURRENT address)")

    try:
        WebDriverWait(driver, 30).until(lambda d: d.find_elements(By.ID, "forgot_login_code"))
    except Exception:
        print(f"  [{label}] EnterCode page did not render (url={driver.current_url}).")
        _dump_page(driver, label, "entercode")
        return "NO_ENTERCODE"

    code = ""
    if _can_read_code(acc):
        where = "/api/read-code" if _can_use_mail_api(acc) else _webmail_url(acc["email"])
        print(f"  [{label}] waiting on {where} for {acc['email']}...")
        code = poll_new_code(acc, before_code, want="credential_change")
        if code:
            print(f"  [{label}] got code {code} from {where}")
    elif acc.get("email"):
        print(f"  [{label}] {_no_mailbox_reason(acc)}")

    if not code and acc.get("refresh_token") and acc.get("client_id"):
        print(f"  [{label}] mail API had nothing; polling Graph directly...")
        try:
            code = asyncio.run(_fetch_steam_guard_code(
                acc["email"], acc["refresh_token"], acc["client_id"], submit_iso)) or ""
        except Exception as err:
            print(f"  [{label}] code fetch failed: {err}")

    if not code:
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
    if not _submit_wizard_form(driver, code_input):
        return "NO_SUBMIT"
    print(f"  [{label}] submitted verification code")
    time.sleep(random.uniform(2.0, 4.0))

    if driver.find_elements(By.ID, "forgot_login_code"):
        print(f"  [{label}] code not accepted (still on EnterCode).")
        _dump_page(driver, label, "entercode_after")
        return "CODE_REJECTED"
    return None


def change_email(driver, acc, new_email, new_mail_acc):
    """Move the account's contact address to `new_email`.

    Two mailboxes are involved and both must be readable: Steam verifies identity
    with a code to the CURRENT address, then confirms ownership with a second code
    sent to the NEW one. `new_mail_acc` is an account-shaped dict for that second
    mailbox so the existing code readers can be reused unchanged.

    Returns a status string; "OK" means the address is live on the account.
    """
    label = acc["steam_user"]
    try:
        print(f"  [{label}] opening change-email: {STEAM_CHANGE_EMAIL_URL}")
        driver.get(STEAM_CHANGE_EMAIL_URL)

        failed = _wizard_identity_code(driver, acc, label)
        if failed:
            return failed

        # Step 2: the new-address form.
        try:
            WebDriverWait(driver, 30).until(
                lambda d: _first_displayed(d, NEW_EMAIL_INPUT_SELECTORS) is not None)
        except Exception:
            print(f"  [{label}] new-email form did not render (url={driver.current_url}).")
            _dump_page(driver, label, "changeemail_form")
            return "NO_EMAIL_FORM"

        field = _first_displayed(driver, NEW_EMAIL_INPUT_SELECTORS)
        field.clear()
        field.send_keys(new_email)
        confirm = _first_displayed(driver, CONFIRM_EMAIL_INPUT_SELECTORS)
        if confirm is not None:
            confirm.clear()
            confirm.send_keys(new_email)
        # Steam's forms validate on input events, not just on value assignment.
        driver.execute_script(
            "for (const el of arguments) {"
            "  if (!el) continue;"
            "  el.dispatchEvent(new Event('input', {bubbles: true}));"
            "  el.dispatchEvent(new Event('change', {bubbles: true}));"
            "}", field, confirm)
        print(f"  [{label}] entered new address {new_email}")

        # Snapshot the NEW mailbox before Steam is asked to mail it, for the same
        # stale-code reason as above.
        before_new = _read_code(new_mail_acc)
        if not _submit_wizard_form(driver, field):
            return "NO_SUBMIT"
        print(f"  [{label}] submitted new address; Steam should now mail {new_email}")
        time.sleep(random.uniform(2.0, 4.0))

        # Step 3: confirm with the code sent to the NEW address.
        code = ""
        if _can_read_code(new_mail_acc):
            where = ("/api/read-code" if _can_use_mail_api(new_mail_acc)
                     else _webmail_url(new_email))
            print(f"  [{label}] waiting on {where} for the NEW mailbox {new_email}...")
            code = poll_new_code(new_mail_acc, before_new, want="credential_change")
        else:
            print(f"  [{label}] {_no_mailbox_reason(new_mail_acc)} — the confirmation "
                  f"code cannot be read automatically")
        if not code:
            try:
                code = input(f"  [{label}] enter the code emailed to the NEW address {new_email}: ").strip()
            except EOFError:
                code = ""
        if not code:
            print(f"  [{label}] no confirmation code for the new address — aborting.")
            # Steam has not switched the address yet at this point, so the account
            # is unchanged rather than half-migrated.
            return "NO_NEW_CODE"

        code_field = (driver.find_elements(By.ID, "forgot_login_code")
                      or driver.find_elements(By.CSS_SELECTOR, "input[name*='code'], input#code"))
        if not code_field:
            _dump_page(driver, label, "changeemail_confirm")
            print(f"  [{label}] confirmation-code field not found — dumped page.")
            return "NO_CONFIRM_FIELD"
        code_field[0].clear()
        code_field[0].send_keys(code)
        if not _submit_wizard_form(driver, code_field[0]):
            return "NO_SUBMIT"
        print(f"  [{label}] submitted confirmation code {code}")

        end = time.time() + 30
        while time.time() < end:
            body = ""
            try:
                body = (driver.find_element(By.TAG_NAME, "body").text or "").lower()
            except Exception:
                pass
            if ("email address has been changed" in body or "has been updated" in body
                    or "successfully" in body):
                print(f"  [{label}] ✅ email changed to {new_email}.")
                return "OK"
            time.sleep(1.0)

        _dump_page(driver, label, "changeemail_after")
        print(f"  [{label}] email change NOT confirmed — dumped page. Verify by hand "
              f"at https://store.steampowered.com/account/ before trusting it.")
        return "CHANGE_UNCONFIRMED"
    except Exception as e:
        print(f"  [{label}] change-email error: {e}")
        return "ERROR"


def update_db_email(db_id, new_email, new_mail_password, remote, key):
    """Point the DB row at the new mailbox after a successful change.

    The stored mail password is only overwritten when a new one is supplied: a row
    left holding the OLD mailbox's password alongside the NEW address would be worse
    than one holding nothing, because it looks usable."""
    sets = [f"email = '{new_email.replace(chr(39), chr(39) * 2)}'"]
    if new_mail_password:
        sets.append(f"email_password_enc = '{_crypto('enc', new_mail_password, key)}'")
    _d1(f"UPDATE steam_accounts SET {', '.join(sets)} WHERE id = {int(db_id)}", remote)


def main():
    args = sys.argv[1:]
    force = "--force" in args
    assume_yes = "--yes" in args
    keep_open = "--keep-open" in args
    use_db = "--db" in args
    remote = "--remote" in args
    # --account <login>[,<login>...] : force a password change for these specific
    # accounts (bypasses the rental-over selection and the already-done skip).
    account_logins = _cli_values(args, "account")
    # --repair-db writes passwords that were already changed on Steam but never made
    # it into the database. Touches no browser and no Steam account.
    repair_db = "--repair-db" in args
    # --mode email changes the account's contact ADDRESS instead of its password.
    mode = (_cli_values(args, "mode") or ["password"])[0].lower()
    if mode not in ("password", "email"):
        print("--mode must be 'password' or 'email'.")
        sys.exit(1)
    new_email = (_cli_values(args, "new-email") or [""])[0]
    new_mail_password = (_cli_values(args, "new-email-password") or [""])[0]
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

        if repair_db:
            repair_failed_db_writes(result_file, remote, enc_key, where)
            return
        try:
            if account_logins:
                what = "email change" if mode == "email" else "password change"
                print(f"[db] source: twitch D1 '{D1_DB_NAME}' ({where}) — FORCING "
                      f"{what} for {len(account_logins)} specified account(s): "
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

    if mode == "email":
        if not new_email:
            print("--mode email needs --new-email <address>.")
            sys.exit(1)
        if "@" not in new_email or new_email.strip() != new_email:
            print(f"--new-email does not look like an address: {new_email!r}")
            sys.exit(1)
        # One address cannot serve several accounts, and a bulk run would silently
        # point the whole batch at one mailbox — whoever holds it could then reset
        # every one of those passwords.
        if len(accounts) != 1:
            print(f"--mode email changes ONE account at a time; {len(accounts)} selected.")
            print("Pick one with --account <login>.")
            sys.exit(1)
        if not _is_graph_mailbox(new_email) and not _webmail_url(new_email):
            print(f"note: {new_email} is neither outlook/hotmail nor a known webmail "
                  f"host, so Steam's confirmation code cannot be read automatically "
                  f"— you will be prompted for it.")
        elif _webmail_url(new_email) and not new_mail_password:
            print(f"note: {new_email} is read over its webmail, which needs its "
                  f"password — pass --new-email-password to read the confirmation "
                  f"code automatically.")

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
    # --force also skips this, but it additionally re-does accounts already
    # rotated, which is wrong for a scheduled run: nothing here removes an account
    # from the selection after a success, so a forced hourly job would change the
    # same passwords again every hour. --yes skips only the prompt.
    if use_db and remote and not force and not assume_yes:
        what = (f"move {todo[0]['steam_user']}'s contact email to {new_email}"
                if mode == "email"
                else f"change Steam passwords for {len(todo)} account(s)")
        try:
            ans = input(f"[db] About to {what} on PRODUCTION and update the live DB. "
                        f"Type 'yes' to proceed: ").strip().lower()
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

        # Re-check the pool before touching Steam. --account is an explicit force,
        # so it is exempt; the rental-over sweep is not.
        if use_db and not account_logins and acc.get("db_id") is not None:
            try:
                blocked = rental_restarted(acc["db_id"], remote)
            except Exception as e:
                # Cannot prove the account is free, so do not gamble a live rental.
                blocked = f"re-check failed ({e})"
            if blocked:
                print(f"  ⏭️  [{user}] SKIPPED — {blocked} since it was loaded; "
                      f"leaving the password as the renter has it.")
                record(user, acc["email"], acc["steam_pass"], "", "SKIPPED_RERENTED")
                continue

        driver = None
        new_pass = generate_password()
        try:
            driver = create_driver(chrome_path)
            if not steam_login(driver, acc):
                record(user, acc["email"], acc["steam_pass"], "", "LOGIN_FAILED")
                print(f"  ❌ [{user}] LOGIN_FAILED")
                continue
            if mode == "email":
                # An account-shaped dict for the NEW mailbox, so the existing code
                # readers work on it unchanged.
                new_mail_acc = {
                    "steam_user": user,
                    "email": new_email,
                    # --new-email-password doubles as the webmail credential, so a
                    # qinianstm.com destination can be confirmed without a prompt.
                    "email_pass": new_mail_password,
                    "refresh_token": "",
                    "client_id": "",
                }
                status = change_email(driver, acc, new_email, new_mail_acc)
                if status == "OK" and use_db and acc.get("db_id") is not None:
                    try:
                        _db_write_with_retry(
                            user,
                            lambda: update_db_email(acc["db_id"], new_email,
                                                    new_mail_password, remote, enc_key))
                        print(f"  [{user}] DB email updated -> {new_email}"
                              + ("" if new_mail_password
                                 else "  (mail password NOT updated — pass "
                                      "--new-email-password so the row is usable)"))
                    except Exception as e:
                        print(f"  [{user}] DB email update FAILED: {e}")
                        status = "OK_DB_UPDATE_FAILED"
                # The password is untouched in this mode, so record the existing one
                # rather than a generated one that was never set.
                record(user, new_email, acc["steam_pass"], "", status)
                icon = "✅" if status.startswith("OK") else "⚠️"
                print(f"  {icon} [{user}] {status}")
                continue
            status = change_password(driver, acc, acc["steam_pass"], new_pass)
            # On success in --db mode, write the new (encrypted) password back to
            # the rental DB so the freed account carries the rotated credential.
            if status == "OK" and use_db:
                try:
                    new_status = _db_write_with_retry(
                        user, lambda: update_db_password(acc["db_id"], new_pass, remote, enc_key))
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
                    print(f"  [{user}] DB update FAILED after retries: {e}")
                    print(f"  ⚠️  [{user}] Steam now has the NEW password but the "
                          f"database still has the old one, and the account is still "
                          f"rentable — the next customer would get a dead login. "
                          f"The new password is in the result file; write it to the DB "
                          f"with:\n"
                          f"        python scripts/steam_change_password.py --db"
                          f"{' --remote' if remote else ''} --repair-db")
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
