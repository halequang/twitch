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
import urllib.error
import urllib.request

DEFAULT_API_URL = "https://poe-mail.fungamingvn.workers.dev/api/read-code"


def _api_url():
    return os.environ.get("MAIL_API_URL", DEFAULT_API_URL)


def _api_key():
    key = os.environ.get("MAIL_API_KEY", "")
    if not key:
        raise RuntimeError("MAIL_API_KEY is not set (export it, matching the Worker secret)")
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
        headers={"Content-Type": "application/json", "X-Api-Key": _api_key()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body).get("error", body)
        except Exception:
            msg = body
        raise RuntimeError(f"read-code HTTP {e.code}: {msg}") from None
    if not data.get("ok"):
        raise RuntimeError(f"read-code error: {data.get('error', 'unknown')}")
    return data


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        sys.exit("usage: MAIL_API_KEY=... python mail_code_client.py <email> [refresh_token] [client_id]")
    args = sys.argv[1:]
    print(read_code(args[0], args[1] if len(args) > 1 else None, args[2] if len(args) > 2 else None))
