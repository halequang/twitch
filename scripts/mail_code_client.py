"""Client for the fungamingtool mail-code API (/api/read-code).

That endpoint reads an Outlook/Hotmail mailbox via Microsoft Graph and returns
the extracted verification code (Steam / Path of Exile / generic numeric),
reusing the same extraction the /mail admin UI uses — so this project doesn't
have to re-implement per-provider code parsing.

Auth: the API is guarded by MAIL_API_KEY (sent as the `X-Api-Key` header); set
it on the Worker with `wrangler secret put MAIL_API_KEY` and mirror the value
here via the MAIL_API_KEY env var. Base URL defaults to the workers.dev host and
can be overridden with MAIL_API_URL.

Dependency-free (urllib), so it runs anywhere Python does.

Usage:
    from mail_code_client import read_code
    code = read_code(email, refresh_token, client_id)   # "" if none found
"""
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

DEFAULT_API_URL = "https://poe-mail.fungamingvn.workers.dev/api/read-code"


def _ssl_context():
    """A verifying SSL context, using certifi's bundle when available.

    python.org builds ship without a system CA bundle, so plain urllib raises
    CERTIFICATE_VERIFY_FAILED against every https host. Verification is NOT
    disabled — the API key travels in a header, so an unverified connection would
    hand it to anyone able to intercept.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _api_url():
    return os.environ.get("MAIL_API_URL", DEFAULT_API_URL)


def _dev_vars_key():
    """MAIL_API_KEY from the repo's gitignored .dev.vars (../.dev.vars).

    So the standalone CLI reads the key from the same place
    steam_change_password.py does, instead of only working when the shell happens
    to export it.
    """
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".dev.vars")
    if not os.path.exists(path):
        return ""
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*(?:export\s+)?MAIL_API_KEY\s*=\s*(.*)", line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def _api_key():
    # Environment wins, so a one-off override still works — EXCEPT a value that
    # is obviously a Cloudflare API token (cfat_...) rather than a mail key. That
    # mis-export is a common footgun (it shadows .dev.vars and 401s every call),
    # so ignore it and fall back to .dev.vars instead of sending a doomed key.
    key = os.environ.get("MAIL_API_KEY", "")
    if key.startswith("cfat_"):
        sys.stderr.write(
            "warning: MAIL_API_KEY in the environment looks like a Cloudflare "
            "token (cfat_...), not a mail key; ignoring it and using .dev.vars\n"
        )
        key = ""
    key = key or _dev_vars_key()
    if not key:
        raise RuntimeError(
            "MAIL_API_KEY is not set - export it, or put it in .dev.vars, "
            "matching the Worker secret"
        )
    return key


def read_code(email, refresh_token=None, client_id=None, timeout=30):
    """Return the extracted verification code for `email` (or "" if none).

    Pass refresh_token + client_id to read statelessly (no server-side account
    needed); omit them to have the server look the account up in its DB."""
    resp = _post({
        "email": email,
        "refreshToken": refresh_token or "",
        "clientId": client_id or "",
        "mode": "code",
    }, timeout)
    return resp.get("code", "") or ""


def read_full(email, refresh_token=None, client_id=None, num_emails=5, timeout=30):
    """Return the full parsed emails: [{from, subject, code, readable, ...}]."""
    resp = _post({
        "email": email,
        "refreshToken": refresh_token or "",
        "clientId": client_id or "",
        "mode": "full",
        "numEmails": num_emails,
    }, timeout)
    return resp.get("emails", [])


def _post(payload, timeout):
    req = urllib.request.Request(
        _api_url(),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": _api_key(),
            # Cloudflare's bot protection rejects urllib's default
            # "Python-urllib/x.y" agent with error 1010 before the request ever
            # reaches the Worker, so identify as a normal client.
            "User-Agent": os.environ.get("MAIL_API_UA", "fungaming-tools/1.0"),
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
            data = json.loads(r.read().decode("utf-8"))
    except ssl.SSLCertVerificationError as e:
        raise RuntimeError(
            "TLS verification failed - this Python has no CA bundle. Fix with "
            "'/Applications/Python 3.x/Install Certificates.command' or "
            "'pip install certifi'. (Not bypassed on purpose: the API key is sent "
            f"in a header.) [{e}]"
        ) from None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error", body)
        except Exception:
            msg = body.strip()[:200]
        # 1010 is Cloudflare refusing the client signature, not the Worker.
        if "1010" in msg:
            msg = ("blocked by Cloudflare (error 1010) before reaching the Worker "
                   "- set MAIL_API_UA to a browser-like User-Agent")
        raise RuntimeError(f"read-code HTTP {e.code}: {msg}") from None
    if not data.get("ok"):
        raise RuntimeError(f"read-code error: {data.get('error', 'unknown')}")
    return data


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Call the fungamingtool mail-code API (/api/read-code).")
    ap.add_argument("email", help="mailbox to read")
    ap.add_argument("refresh_token", nargs="?",
                    help="inline refresh_token; omit to use the server-side DB "
                         "lookup (admin address only)")
    ap.add_argument("client_id", nargs="?", help="inline client_id (Azure app id)")
    ap.add_argument("--mode", choices=["code", "full"], default="code",
                    help="code = just the verification code (default); "
                         "full = the parsed emails")
    ap.add_argument("--num", type=int, default=5,
                    help="emails to scan in --mode full (default 5)")
    args = ap.parse_args()

    try:
        if args.mode == "full":
            emails = read_full(args.email, args.refresh_token, args.client_id,
                               num_emails=args.num)
            for m in emails:
                print(f"From:    {m.get('from', '')}")
                print(f"Subject: {m.get('subject', '')}")
                print(f"Code:    {m.get('code', '')}")
                print("-" * 48)
            if not emails:
                print("(no emails)")
        else:
            code = read_code(args.email, args.refresh_token, args.client_id)
            print(code)
            if not code:
                raise SystemExit(2)   # no code found — non-zero for scripting
    except RuntimeError as e:
        raise SystemExit(f"error: {e}")
