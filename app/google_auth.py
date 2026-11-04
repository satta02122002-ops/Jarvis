"""Google OAuth (web flow) so Jarvis can read Gmail, draft replies and manage Calendar."""

import json
import secrets
import time

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from . import config, db

TOKEN_KEY = "google_token"
_pending: dict[str, tuple[float, str | None]] = {}  # state -> (created, PKCE code_verifier)


def _redirect_uri() -> str:
    return f"{config.PUBLIC_URL}/google/callback"


def _flow(state: str | None = None) -> Flow:
    client_config = {
        "web": {
            "client_id": config.GOOGLE_CLIENT_ID,
            "client_secret": config.GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [_redirect_uri()],
        }
    }
    return Flow.from_client_config(client_config, scopes=config.GOOGLE_SCOPES, state=state, redirect_uri=_redirect_uri())


def authorization_url() -> str:
    state = secrets.token_urlsafe(24)
    flow = _flow(state)
    url, _ = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    # Drop stale states, then remember this one (with its PKCE verifier) for the callback.
    cutoff = time.time() - 600
    for s in [s for s, (t, _) in _pending.items() if t < cutoff]:
        _pending.pop(s, None)
    _pending[state] = (time.time(), getattr(flow, "code_verifier", None))
    return url


def handle_callback(state: str, code: str) -> None:
    entry = _pending.pop(state, None)
    if entry is None:
        raise ValueError("Unknown or expired sign-in attempt. Please try connecting again.")
    flow = _flow(state)
    if entry[1]:
        flow.code_verifier = entry[1]
    flow.fetch_token(code=code)
    db.set_setting(TOKEN_KEY, flow.credentials.to_json())


def credentials() -> Credentials | None:
    raw = db.get_setting(TOKEN_KEY)
    if not raw:
        return None
    creds = Credentials.from_authorized_user_info(json.loads(raw), config.GOOGLE_SCOPES)
    if not creds.valid and creds.refresh_token:
        creds.refresh(Request())
        db.set_setting(TOKEN_KEY, creds.to_json())
    return creds if creds.valid else None


def connected() -> bool:
    return db.get_setting(TOKEN_KEY) is not None


def disconnect() -> None:
    db.delete_setting(TOKEN_KEY)
