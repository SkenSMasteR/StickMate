import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

DATA_DIR = os.environ.get("STICKMATE_DATA_DIR", "./data")
DB_PATH = os.environ.get("STICKMATE_DB_PATH", os.path.join(DATA_DIR, "stickmate.db"))
API_PORT = int(os.environ.get("STICKMATE_API_PORT", "8710"))
API_BIND = os.environ.get("STICKMATE_API_BIND", "0.0.0.0")
ADMIN_PORT = int(os.environ.get("STICKMATE_ADMIN_PORT", "8711"))
ADMIN_BIND = os.environ.get("STICKMATE_ADMIN_BIND", "127.0.0.1")
PUBLIC_URL = os.environ.get("STICKMATE_PUBLIC_URL", "http://127.0.0.1:8710").rstrip("/")
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
ADMIN_TOKEN = os.environ.get("STICKMATE_ADMIN_TOKEN", "")
GITHUB_API = os.environ.get("STICKMATE_GITHUB_API", "https://api.github.com").rstrip("/")

ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
DEVICE_TTL = 600

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts(
    id INTEGER PRIMARY KEY,
    github_id INTEGER UNIQUE,
    login TEXT,
    created_at TEXT,
    suspended INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    account_id INTEGER,
    refresh_hash TEXT,
    created_at TEXT,
    expires_at TEXT,
    revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS device_codes(
    code TEXT PRIMARY KEY,
    user_code TEXT,
    account_id INTEGER,
    status TEXT,
    created_at TEXT,
    expires_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_states(
    state TEXT PRIMARY KEY,
    device_code TEXT,
    created_at TEXT,
    expires_at TEXT
);
CREATE TABLE IF NOT EXISTS preferences(
    account_id INTEGER PRIMARY KEY,
    revision INTEGER DEFAULT 0,
    data TEXT DEFAULT '{}',
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS policy(
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY,
    at TEXT,
    actor TEXT,
    action TEXT,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS signing_key(
    id INTEGER PRIMARY KEY CHECK(id=1),
    private_pem TEXT,
    public_pem TEXT
);
"""

_PRIVATE_KEY = None
_PUBLIC_KEY = None
_PUBLIC_PEM = None


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def session_expiry():
    return (
        datetime.now(timezone.utc) + timedelta(seconds=REFRESH_TTL)
    ).isoformat(timespec="seconds")


def iso_plus(seconds):
    return datetime.fromtimestamp(time.time() + seconds, timezone.utc).isoformat(timespec="seconds")


def is_expired(expires_at):
    return datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc)


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = db()
    try:
        with conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO policy(key,value) VALUES('offline_grace_days','30')")
            conn.execute("INSERT OR IGNORE INTO policy(key,value) VALUES('preference_max_bytes','262144')")
            columns = [row["name"] for row in conn.execute("PRAGMA table_info(sessions)")]
            if "expires_at" not in columns:
                conn.execute("ALTER TABLE sessions ADD COLUMN expires_at TEXT")
                conn.execute(
                    "UPDATE sessions SET expires_at=? WHERE expires_at IS NULL",
                    (session_expiry(),),
                )
            row = conn.execute("SELECT id FROM signing_key WHERE id=1").fetchone()
            if row is None:
                key = ed25519.Ed25519PrivateKey.generate()
                private_pem = key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                ).decode()
                public_pem = key.public_key().public_bytes(
                    serialization.Encoding.PEM,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                ).decode()
                conn.execute(
                    "INSERT INTO signing_key(id,private_pem,public_pem) VALUES(1,?,?)",
                    (private_pem, public_pem),
                )
            conn.execute("PRAGMA user_version=1")
    finally:
        conn.close()
    _load_keys()


def _load_keys():
    global _PRIVATE_KEY, _PUBLIC_KEY, _PUBLIC_PEM
    conn = db()
    try:
        row = conn.execute("SELECT private_pem, public_pem FROM signing_key WHERE id=1").fetchone()
    finally:
        conn.close()
    _PRIVATE_KEY = serialization.load_pem_private_key(row["private_pem"].encode(), password=None)
    _PUBLIC_KEY = serialization.load_pem_public_key(row["public_pem"].encode())
    _PUBLIC_PEM = row["public_pem"]


def public_pem():
    if _PUBLIC_PEM is None:
        _load_keys()
    return _PUBLIC_PEM


def _b64e(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign_token(payload):
    if _PRIVATE_KEY is None:
        _load_keys()
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    signature = _PRIVATE_KEY.sign(body)
    return _b64e(body) + "." + _b64e(signature)


def verify_token(token, expected_type):
    try:
        body_part, sig_part = token.split(".")
        body = _b64d(body_part)
        if _PUBLIC_KEY is None:
            _load_keys()
        _PUBLIC_KEY.verify(_b64d(sig_part), body)
        payload = json.loads(body)
    except Exception as exc:
        raise ValueError("invalid token") from exc
    if payload.get("type") != expected_type:
        raise ValueError("invalid token type")
    if int(payload.get("exp", 0)) <= int(time.time()):
        raise ValueError("token expired")
    return payload


def make_access_token(account_id):
    now = int(time.time())
    return sign_token({"account_id": account_id, "type": "access", "iat": now, "exp": now + ACCESS_TTL})


def make_offline_token(account_id, grace_days):
    now = int(time.time())
    return sign_token({"account_id": account_id, "type": "offline", "iat": now, "exp": now + grace_days * 86400})


def new_refresh_token():
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest()


def create_session(conn, account_id):
    token, token_hash = new_refresh_token()
    conn.execute(
        "INSERT INTO sessions(account_id,refresh_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,0)",
        (account_id, token_hash, now_iso(), session_expiry()),
    )
    return token


def get_policy(conn):
    rows = conn.execute("SELECT key, value FROM policy").fetchall()
    return {row["key"]: row["value"] for row in rows}


def get_policy_int(conn, key, default):
    row = conn.execute("SELECT value FROM policy WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    return int(row["value"])


def audit(conn, actor, action, detail=""):
    conn.execute(
        "INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)",
        (now_iso(), actor, action, detail),
    )


def check_admin_token(header_value):
    if not ADMIN_TOKEN or not header_value:
        return False
    parts = header_value.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return hmac.compare_digest(parts[1].encode(), ADMIN_TOKEN.encode())


def read_version():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSION")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip() or "0.1.0"
    except OSError:
        return "0.1.0"


def exchange_code(code):
    response = httpx.post(
        "https://github.com/login/oauth/access_token",
        data={
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "code": code,
        },
        headers={"Accept": "application/json"},
        timeout=15,
    )
    response.raise_for_status()
    token = response.json().get("access_token")
    if not token:
        raise ValueError("token exchange failed")
    return token


def fetch_user(github_token):
    response = httpx.get(
        GITHUB_API + "/user",
        headers={"Authorization": "Bearer " + github_token, "Accept": "application/vnd.github+json"},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    return {"id": int(data["id"]), "login": str(data["login"])}