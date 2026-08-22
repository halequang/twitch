"""Open a webmail mailbox from steam_accounts.txt and sign in to it.

The mailboxes behind the rental accounts are Roundcube (mail.qisteam.com and the
other hosts in that file), and the credentials are already sitting in
steam_accounts.txt — so signing in by hand means copying two fields out of a file
of ninety lines, for every account. This does that step.

Input format (steam_accounts.txt), one account per line, `----` separated:

    steam_login----steam_password----email----email_password[----host or note]

Only fields 3 and 4 are used here: the mailbox address and ITS password. The Steam
password in field 2 is never sent anywhere. Trailing notes glued onto the mailbox
password with no separator are cut off — the file really does contain
`131641-> day 2 1 tuan` and `663185（先别换绑` — because they are notes, not password
characters.

Which host a line belongs to comes from three places, most specific first: a host
in the line's own trailing field, the `------mail.qisteam.com` style section header
above it, then the address's own domain (qinianstm.com is served by
mail.qisteam.com, 33gog.com by mail.88gog.com). outlook/hotmail addresses are
Microsoft webmail, not one of these, so they are left out.

Usage:
  python3 scripts/open_qisteam_mail.py --list
  python3 scripts/open_qisteam_mail.py --email za483646@qinianstm.com
  python3 scripts/open_qisteam_mail.py --login Hn1Ea8Tw3Kg6
  python3 scripts/open_qisteam_mail.py --all --headless
  python3 scripts/open_qisteam_mail.py --login Hn1Ea8Tw3Kg6 --url http://mail.88gog.com/

Options:
  --file <path>     account file (default: steam_accounts.txt beside the repo root)
  --url <url>       webmail to open (default: http://mail.qisteam.com/)
  --login <name>    the account whose mailbox to open, by STEAM login
  --email <addr>    ...or by mailbox address. Repeatable, comma-separated
  --all             every mailbox this host serves, one after another
  --limit <n>       stop after n mailboxes in --all (default 5)
  --list            print what was parsed and exit. No browser, no network
  --headless        no visible window: sign in, report OK/FAIL, close. Use this to
                    CHECK credentials; the point of a visible run is to read mail
  --keep-open       leave the window open after signing in (default when visible)
  --timeout <s>     seconds to wait for each page (default 30)

The window stays open on a visible run — closing it is the operator's job, since
the whole point is to land in the inbox and read it.

NOTE: these hosts are plain HTTP, so the mailbox password crosses the network in
cleartext. That is a property of the provider, not of this script, but it is worth
knowing before running it on an untrusted network.
"""

import argparse
import os
import re
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FILE = os.path.join(ROOT, "steam_accounts.txt")
DEFAULT_URL = "http://mail.qisteam.com/"

# Which webmail serves which address domain. The file groups accounts under
# section headers, but plenty of lines sit outside any header, and the domain is
# the one thing every line carries.
DOMAIN_HOSTS = {
    "qinianstm.com": "mail.qisteam.com",
    "33gog.com": "mail.88gog.com",
    "xysc8866.online": "mail.xy6666.shop",
    "xysc8866.vip": "mail.xy6666.shop",
    "xysc886688.online": "mail.xy6666.shop",
}

# Read through Microsoft Graph elsewhere in this repo (src/lib/steamcode.js), not
# through one of these webmail hosts.
MICROSOFT_DOMAINS = {"outlook.com", "hotmail.com"}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
# A note can be glued straight onto the password: "131641-> day 2" and
# "663185（先别换绑". Anything from these onwards is commentary.
NOTE_CUT = re.compile(r"(\s|->|→|（|\(|,|;)")


def host_of(url_or_host):
    """Bare hostname, whether given a URL or a hostname."""
    text = str(url_or_host or "").strip()
    text = re.sub(r"^[a-z]+://", "", text, flags=re.I)
    return text.split("/")[0].strip().lower()


def clean_secret(value):
    """The password itself, with any note glued to its tail removed."""
    match = NOTE_CUT.search(value or "")
    return (value[: match.start()] if match else value).strip()


def section_host(line):
    """The host a `------mail.qisteam.com` style divider names, or None.

    Dashes alone are not a reliable marker: the dividers in this file use anywhere
    from two to six of them, `----END buy second time` uses four and names nothing,
    and `--red_flag` is a tag. So a divider has to leave exactly one dotted token
    behind, with no address in it, once the dashes come off.
    """
    if not line.startswith("-"):
        return None
    remainder = line.strip("-").strip()
    if not remainder or "@" in remainder or len(remainder.split()) != 1:
        return None
    host = host_of(remainder)
    return host if "." in host else None


def parse_accounts(path):
    """Every line that carries a mailbox and its password, in file order.

    Deliberately forgiving: this file is hand-maintained and holds dividers, URLs,
    Vietnamese notes, a tab-separated "Account ID / Password" header and blank
    runs. Rather than enumerate what to skip, a line has to prove it is an account
    — four `----` fields whose third looks like an email address — and everything
    else is ignored.

    Some accounts appear twice (the repeat carrying a Chinese note), so the first
    occurrence of a mailbox wins and later ones are dropped.
    """
    accounts, seen = [], set()
    if not os.path.exists(path):
        return accounts

    section = None
    with open(path, "r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue

            divider = section_host(line)
            if divider:
                section = divider
                continue

            fields = [f.strip() for f in line.split("----")]
            if len(fields) < 4:
                continue
            login, email = fields[0], fields[2]
            if not EMAIL_RE.match(email):
                continue
            password = clean_secret(fields[3])
            if not password:
                continue
            if email.lower() in seen:
                continue
            seen.add(email.lower())

            domain = email.rsplit("@", 1)[-1].lower()
            # The domain decides; the other two only fill in for a domain this
            # script has not been told about. That order is deliberate: the domain
            # is the one thing every line carries and it cannot go stale, whereas
            # the dividers do not match the addresses under them — @qinianstm.com
            # rows sit below a mail.xy6666.shop divider — and trusting the divider
            # first put nearly every mailbox on the wrong host.
            trailing = host_of(fields[4]) if len(fields) > 4 else ""
            host = (
                DOMAIN_HOSTS.get(domain)
                or (trailing if "." in trailing and " " not in trailing else "")
                or section
                or ""
            )
            # An outlook/hotmail mailbox is not served by any of these hosts, so it
            # must not inherit the divider it happens to sit under — several do, and
            # listing those as qisteam mailboxes was simply wrong.
            if domain in MICROSOFT_DOMAINS:
                host = ""
            accounts.append({
                "line": lineno,
                "login": login,
                "email": email,
                "password": password,
                "domain": domain,
                "host": host,
                "microsoft": domain in MICROSOFT_DOMAINS,
            })
    return accounts


def mask(secret):
    """Enough to tell two passwords apart, not enough to use one."""
    text = str(secret or "")
    if len(text) <= 3:
        return "*" * len(text)
    return f"{text[:2]}{'*' * (len(text) - 2)}"


def create_driver(headless, timeout):
    """A fresh temporary Chrome profile, so each run starts signed out.

    Same shape as create_driver in steam_change_password.py. Copied rather than
    imported: that module is a CLI that reads sys.argv at import time, and pulling
    it in here would mean its arguments and its optional Graph dependencies.
    """
    import tempfile

    profile_dir = tempfile.mkdtemp(prefix="qisteam_mail_")
    opts = Options()
    opts.add_argument(f"--user-data-dir={profile_dir}")
    if headless:
        opts.add_argument("--headless=new")
        opts.add_argument("--window-size=1440,900")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-popup-blocking")
    # Chrome offering to save the mailbox password into the temporary profile is
    # a dialog over the page and nothing else.
    opts.add_experimental_option("prefs", {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
    })
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts)
    driver.set_page_load_timeout(timeout)
    if not headless:
        driver.set_window_size(1280, 940)
    return driver


def find_login_inputs(driver, timeout):
    """The user and password fields, Roundcube first.

    These hosts run Roundcube, whose ids are stable (#rcmloginuser / #rcmloginpwd),
    so they are tried by id. The generic fallback anchors on the visible password
    field and walks up to the nearest text input in the same form, which is what
    works on a login page of unknown shape.
    """
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: any(
                el.is_displayed() for el in d.find_elements(By.CSS_SELECTOR, 'input[type="password"]')
            )
        )
    except Exception:
        return None, None

    user = next((el for el in driver.find_elements(By.ID, "rcmloginuser") if el.is_displayed()), None)
    pwd = next((el for el in driver.find_elements(By.ID, "rcmloginpwd") if el.is_displayed()), None)
    if user and pwd:
        return user, pwd

    pwd = next(
        (el for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="password"]') if el.is_displayed()),
        None,
    )
    if not pwd:
        return None, None
    user = driver.execute_script(
        """
        const pwd = arguments[0];
        let node = pwd.closest('form') || pwd.parentElement;
        for (let i = 0; i < 5 && node; i++) {
            for (const el of node.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')) {
                if (el === pwd || el.offsetParent === null) continue;
                const name = (el.getAttribute('name') || '').toLowerCase();
                if (name.includes('search')) continue;
                return el;
            }
            node = node.parentElement;
        }
        return null;
        """,
        pwd,
    )
    return user, pwd


def signed_in(driver):
    """True once the mail UI is up. Roundcube lands on ?_task=mail."""
    try:
        if "_task=mail" in (driver.current_url or ""):
            return True
        return bool(
            driver.find_elements(By.CSS_SELECTOR, "#messagelist, .messagelist, #mailview-right, [id^=rcmrow]")
        )
    except Exception:
        return False


# Roundcube announces a rejected login through JavaScript rather than in the served
# HTML — `display_message("登录失败。","warning",0)` — and files it under *warning*,
# not error. Matching only `.error` therefore never fired, and a wrong password took
# the full page timeout to report as "no error shown either". The container is what
# is matched, not the wording: this install answers in Chinese.
MESSAGE_SELECTORS = (
    "#messagestack .message",
    "#messagestack div",
    "#messagestack",
    ".ui.alert",
    "#message.error",
    "#message.warning",
    ".error",
    ".warning",
    ".boxerror",
    ".boxwarning",
)


def login_error(driver):
    """Whatever the webmail is complaining about, if anything.

    Any message on a login page is a rejection — Roundcube shows nothing there on
    success, it navigates instead — so severity is not inspected.
    """
    for selector in MESSAGE_SELECTORS:
        for el in driver.find_elements(By.CSS_SELECTOR, selector):
            try:
                if el.is_displayed() and (el.text or "").strip():
                    return " ".join(el.text.split())[:160]
            except Exception:
                continue
    return None


def open_mailbox(driver, url, account, timeout):
    """Load the webmail, fill both fields, submit. Returns (ok, detail)."""
    driver.get(url)
    user_input, pass_input = find_login_inputs(driver, timeout)
    if not user_input or not pass_input:
        return False, "no login form found on the page"

    user_input.clear()
    user_input.send_keys(account["email"])
    pass_input.clear()
    pass_input.send_keys(account["password"])

    submit = next(
        (
            el
            for el in driver.find_elements(
                By.CSS_SELECTOR, "#rcmloginsubmit, button[type=submit], input[type=submit]"
            )
            if el.is_displayed()
        ),
        None,
    )
    if submit:
        submit.click()
    else:
        pass_input.submit()

    # Whichever happens first: the inbox, or an error under the form. Polled
    # rather than waited on one condition, because a wrong password leaves the
    # page looking exactly as it did before.
    deadline = time.time() + timeout
    while time.time() < deadline:
        if signed_in(driver):
            return True, driver.current_url
        error = login_error(driver)
        if error:
            return False, error
        time.sleep(0.4)
    return False, "timed out waiting for the inbox (no error shown either)"


def main():
    parser = argparse.ArgumentParser(add_help=True, description="Open a webmail mailbox from steam_accounts.txt.")
    parser.add_argument("--file", default=DEFAULT_FILE)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--login", action="append", default=[])
    parser.add_argument("--email", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--keep-open", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    wanted_logins = {v.lower() for item in args.login for v in item.split(",") if v.strip()}
    wanted_emails = {v.lower() for item in args.email for v in item.split(",") if v.strip()}

    accounts = parse_accounts(args.file)
    if not accounts:
        print(f"No accounts with a mailbox password found in {args.file}", file=sys.stderr)
        return 1

    host = host_of(args.url)
    # Named accounts are honoured whatever host they belong to — asking for one by
    # name and being told it does not match the default URL would be obtuse. Only
    # an unfiltered run is narrowed to the host being opened.
    if wanted_logins or wanted_emails:
        chosen = [
            a for a in accounts
            if a["login"].lower() in wanted_logins or a["email"].lower() in wanted_emails
        ]
    else:
        chosen = [a for a in accounts if a["host"] == host and not a["microsoft"]]

    if args.list:
        print(f"{args.file}: {len(accounts)} account(s) with a mailbox password\n")
        print(f"  {'LINE':>5}  {'STEAM LOGIN':16}{'MAILBOX':34}{'PASSWORD':12}WEBMAIL")
        for a in accounts:
            here = "  <-- " + host if a["host"] == host and not a["microsoft"] else ""
            where = "(microsoft)" if a["microsoft"] else a["host"] or "(unknown)"
            print(
                f"  {a['line']:>5}  {a['login'][:15]:16}{a['email'][:33]:34}"
                f"{mask(a['password']):12}{where}{here}"
            )
        print(f"\n{len(chosen)} of them served by {host}." if not (wanted_logins or wanted_emails)
              else f"\n{len(chosen)} matched by name.")
        print("Passwords are masked here; a real run sends them to the webmail, nothing else.")
        return 0

    if not chosen:
        if wanted_logins or wanted_emails:
            print(f"No account in {args.file} matches "
                  f"{', '.join(sorted(wanted_logins | wanted_emails))}", file=sys.stderr)
        else:
            print(f"No mailbox in {args.file} is served by {host}. --list shows what is there.",
                  file=sys.stderr)
        return 1

    if not args.all and len(chosen) > 1:
        print(f"{len(chosen)} mailboxes match. Pick one with --login/--email, or pass --all.\n",
              file=sys.stderr)
        for a in chosen[:20]:
            print(f"  line {a['line']:>4}  {a['login']:16}{a['email']}", file=sys.stderr)
        return 1

    if args.all:
        chosen = chosen[: max(1, args.limit)]

    # A visible run exists to land in the inbox and read it, so the window stays.
    keep_open = args.keep_open or (not args.headless and not args.all)

    results = []
    driver = None
    try:
        for account in chosen:
            # One browser per mailbox, or the second sign-in would inherit the
            # first one's session.
            if driver is not None:
                driver.quit()
                driver = None
            driver = create_driver(args.headless, args.timeout)
            print(f"→ {account['email']}  (steam {account['login']}, line {account['line']}) at {args.url}")
            try:
                ok, detail = open_mailbox(driver, args.url, account, args.timeout)
            except Exception as err:  # a page that never loads must not lose the rest
                ok, detail = False, f"{type(err).__name__}: {err}".split("\n")[0][:160]
            results.append((account, ok, detail))
            print(f"   {'OK  ' if ok else 'FAIL'} {detail}")

            if ok and keep_open:
                print("\nSigned in. The window stays open — close it when you are done.")
                driver = None  # dropped on purpose: quitting would close the inbox
                break
    finally:
        if driver is not None and not keep_open:
            driver.quit()

    print(f"\n{sum(1 for _, ok, _ in results if ok)}/{len(results)} signed in.")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
