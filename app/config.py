"""Runtime settings, all read from environment variables (see .env.example)."""

import os
from pathlib import Path
from zoneinfo import ZoneInfo


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


# --- Claude ---------------------------------------------------------------
MODEL = _env("JARVIS_MODEL", "claude-opus-5-5")
# low | medium | high | xhigh | max. "medium" keeps chat snappy and affordable.
EFFORT = _env("JARVIS_EFFORT", "medium")
MAX_TOOL_STEPS = int(_env("JARVIS_MAX_TOOL_STEPS", "12"))

# --- App --------------------------------------------------------------------
OWNER_NAME = _env("JARVIS_OWNER_NAME", "Sattanathan")
TIMEZONE = ZoneInfo(_env("JARVIS_TIMEZONE", "Asia/Dubai"))
APP_PASSWORD = _env("APP_PASSWORD")
SECRET_KEY = _env("SECRET_KEY")
DEV_MODE = _env("JARVIS_DEV") == "1"
DATA_DIR = Path(_env("DATA_DIR", "data"))
DB_PATH = DATA_DIR / "jarvis.db"
# Public https URL of the deployed app, e.g. https://jarvis-production.up.railway.app
PUBLIC_URL = _env("PUBLIC_URL", "http://localhost:8000").rstrip("/")

# --- Google (optional: Gmail + Calendar) -----------------------------------
GOOGLE_CLIENT_ID = _env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = _env("GOOGLE_CLIENT_SECRET")
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",  # create drafts; Jarvis never sends
    "https://www.googleapis.com/auth/calendar.events",
]


def google_configured() -> bool:
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def validate() -> None:
    """Fail fast on a misconfigured production deploy."""
    if DEV_MODE:
        return
    missing = [n for n, v in (("APP_PASSWORD", APP_PASSWORD), ("SECRET_KEY", SECRET_KEY)) if not v]
    if missing:
        raise RuntimeError(
            f"Missing required env vars: {', '.join(missing)}. "
            "Set them, or set JARVIS_DEV=1 for local testing only."
        )
