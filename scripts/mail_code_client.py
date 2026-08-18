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
import ssl
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
    import sys
    if len(sys.argv) < 2:
        sys.exit("usage: MAIL_API_KEY=... python mail_code_client.py <email> [refresh_token] [client_id]")
    args = sys.argv[1:]
    print(read_code(args[0], args[1] if len(args) > 1 else None, args[2] if len(args) > 2 else None))
