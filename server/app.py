import hashlib
import html
import json
import secrets
import string
from contextlib import closing
from urllib.parse import urlencode

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel

import core

core.init_db()

app = FastAPI(title="StickMate API")


class DevicePollBody(BaseModel):
    device_code: str


class RefreshBody(BaseModel):
    refresh_token: str


class PreferencesPutBody(BaseModel):
    base_revision: int
    data: dict


def current_account(authorization: str = Header(default="")):
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="missing token")
    try:
        payload = core.verify_token(parts[1], "access")
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid token")
    with closing(core.db()) as conn:
        row = conn.execute(
            "SELECT id, login, suspended FROM accounts WHERE id=?",
            (payload["account_id"],),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="unknown account")
    if row["suspended"]:
        raise HTTPException(status_code=403, detail="account suspended")
    return {"id": row["id"], "login": row["login"]}


def issue_tokens(conn, account_id):
    grace_days = core.get_policy_int(conn, "offline_grace_days", 30)
    refresh_token = core.create_session(conn, account_id)
    return {
        "access_token": core.make_access_token(account_id),
        "refresh_token": refresh_token,
        "offline_token": core.make_offline_token(account_id, grace_days),
    }


@app.get("/health")
def health():
    return {"status": "ok", "version": core.read_version()}


@app.get("/auth/public-key")
def public_key():
    return {"public_key": core.public_pem()}


@app.post("/auth/device/start")
def device_start():
    device_code = secrets.token_urlsafe(32)
    user_code = "".join(secrets.choice(string.ascii_uppercase) for _ in range(8))
    with closing(core.db()) as conn, conn:
        conn.execute(
            "INSERT INTO device_codes(code,user_code,account_id,status,created_at,expires_at) VALUES(?,?,NULL,'pending',?,?)",
            (device_code, user_code, core.now_iso(), core.iso_plus(core.DEVICE_TTL)),
        )
    return {
        "device_code": device_code,
        "user_code": user_code,
        "verification_uri": core.PUBLIC_URL + "/auth/verify?user_code=" + user_code,
        "interval": 5,
        "expires_in": core.DEVICE_TTL,
    }


@app.get("/auth/verify", response_class=HTMLResponse)
def verify_page(user_code: str = ""):
    safe_code = html.escape(user_code)
    return (
        "<!doctype html><html><head><title>StickMate sign in</title></head><body>"
        "<p>Enter this code in the app if asked: <b>" + safe_code + "</b></p>"
        '<p><a href="/auth/github/start?user_code=' + safe_code + '">Sign in with GitHub</a></p>'
        "</body></html>"
    )


@app.get("/auth/github/start")
def github_start(user_code: str = ""):
    if not core.GITHUB_CLIENT_ID:
        return PlainTextResponse("GitHub sign in is not configured", status_code=400)
    with closing(core.db()) as conn, conn:
        row = conn.execute(
            "SELECT code, status, expires_at FROM device_codes WHERE user_code=?",
            (user_code,),
        ).fetchone()
        if row is None or row["status"] != "pending" or core.is_expired(row["expires_at"]):
            return PlainTextResponse("Invalid or expired code", status_code=400)
        state = secrets.token_urlsafe(24)
        conn.execute(
            "INSERT INTO oauth_states(state,device_code,created_at,expires_at) VALUES(?,?,?,?)",
            (state, row["code"], core.now_iso(), core.iso_plus(core.DEVICE_TTL)),
        )
    params = urlencode(
        {
            "client_id": core.GITHUB_CLIENT_ID,
            "state": state,
            "scope": "read:user",
            "redirect_uri": core.PUBLIC_URL + "/auth/github/callback",
        }
    )
    return RedirectResponse("https://github.com/login/oauth/authorize?" + params, status_code=302)


@app.get("/auth/github/callback")
def github_callback(code: str = "", state: str = ""):
    try:
        with closing(core.db()) as conn, conn:
            row = conn.execute(
                "SELECT device_code, expires_at FROM oauth_states WHERE state=?",
                (state,),
            ).fetchone()
            if row is None or core.is_expired(row["expires_at"]):
                raise ValueError("invalid state")
            conn.execute("DELETE FROM oauth_states WHERE state=?", (state,))
            device = conn.execute(
                "SELECT code, status, expires_at FROM device_codes WHERE code=?",
                (row["device_code"],),
            ).fetchone()
            if device is None or device["status"] != "pending" or core.is_expired(device["expires_at"]):
                raise ValueError("invalid device code")
            github_token = core.exchange_code(code)
            user = core.fetch_user(github_token)
            account = conn.execute(
                "SELECT id FROM accounts WHERE github_id=?",
                (user["id"],),
            ).fetchone()
            if account is None:
                cursor = conn.execute(
                    "INSERT INTO accounts(github_id,login,created_at,suspended) VALUES(?,?,?,0)",
                    (user["id"], user["login"], core.now_iso()),
                )
                account_id = cursor.lastrowid
            else:
                account_id = account["id"]
                conn.execute("UPDATE accounts SET login=? WHERE id=?", (user["login"], account_id))
            conn.execute(
                "UPDATE device_codes SET status='authorized', account_id=? WHERE code=?",
                (account_id, device["code"]),
            )
            core.audit(conn, "account:" + str(account_id), "github_sign_in", user["login"])
    except Exception:
        return PlainTextResponse("Sign in failed", status_code=400)
    return HTMLResponse(
        "<!doctype html><html><head><title>StickMate</title></head><body>"
        "<p>Signed in. You can close this window.</p></body></html>"
    )


@app.post("/auth/device/poll")
def device_poll(body: DevicePollBody):
    with closing(core.db()) as conn, conn:
        row = conn.execute(
            "SELECT code, status, account_id, expires_at FROM device_codes WHERE code=?",
            (body.device_code,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=400, detail="invalid device code")
        if core.is_expired(row["expires_at"]) or row["status"] == "expired":
            conn.execute("DELETE FROM device_codes WHERE code=?", (body.device_code,))
            return {"status": "expired"}
        if row["status"] == "pending":
            return {"status": "pending"}
        account = conn.execute(
            "SELECT id, login, suspended FROM accounts WHERE id=?",
            (row["account_id"],),
        ).fetchone()
        if account is None or account["suspended"]:
            raise HTTPException(status_code=403, detail="account suspended")
        tokens = issue_tokens(conn, account["id"])
        conn.execute("DELETE FROM device_codes WHERE code=?", (body.device_code,))
        tokens["status"] = "ok"
        tokens["account"] = {"id": account["id"], "login": account["login"]}
        return tokens


@app.post("/auth/refresh")
def refresh(body: RefreshBody):
    token_hash = hashlib.sha256(body.refresh_token.encode()).hexdigest()
    with closing(core.db()) as conn, conn:
        session = conn.execute(
            "SELECT id, account_id, revoked FROM sessions WHERE refresh_hash=?",
            (token_hash,),
        ).fetchone()
        if session is None or session["revoked"]:
            raise HTTPException(status_code=401, detail="invalid refresh token")
        account = conn.execute(
            "SELECT id, suspended FROM accounts WHERE id=?",
            (session["account_id"],),
        ).fetchone()
        if account is None:
            raise HTTPException(status_code=401, detail="invalid refresh token")
        if account["suspended"]:
            raise HTTPException(status_code=403, detail="account suspended")
        conn.execute("UPDATE sessions SET revoked=1 WHERE id=?", (session["id"],))
        tokens = issue_tokens(conn, account["id"])
        tokens["status"] = "ok"
        return tokens


@app.post("/auth/logout")
def logout(body: RefreshBody):
    token_hash = hashlib.sha256(body.refresh_token.encode()).hexdigest()
    with closing(core.db()) as conn, conn:
        conn.execute("UPDATE sessions SET revoked=1 WHERE refresh_hash=?", (token_hash,))
    return {"status": "ok"}


@app.get("/preferences")
def get_preferences(account=Depends(current_account)):
    with closing(core.db()) as conn, conn:
        conn.execute(
            "INSERT OR IGNORE INTO preferences(account_id,revision,data,updated_at) VALUES(?,0,'{}',?)",
            (account["id"], core.now_iso()),
        )
        row = conn.execute(
            "SELECT revision, data FROM preferences WHERE account_id=?",
            (account["id"],),
        ).fetchone()
    return {"revision": row["revision"], "data": json.loads(row["data"])}


@app.put("/preferences")
def put_preferences(body: PreferencesPutBody, account=Depends(current_account)):
    serialized = json.dumps(body.data, separators=(",", ":"))
    with closing(core.db()) as conn, conn:
        max_bytes = core.get_policy_int(conn, "preference_max_bytes", 262144)
        if len(serialized.encode("utf-8")) > max_bytes:
            raise HTTPException(status_code=413, detail="preferences too large")
        conn.execute(
            "INSERT OR IGNORE INTO preferences(account_id,revision,data,updated_at) VALUES(?,0,'{}',?)",
            (account["id"], core.now_iso()),
        )
        row = conn.execute(
            "SELECT revision FROM preferences WHERE account_id=?",
            (account["id"],),
        ).fetchone()
        if body.base_revision != row["revision"]:
            return JSONResponse({"error": "conflict", "revision": row["revision"]}, status_code=409)
        new_revision = row["revision"] + 1
        conn.execute(
            "UPDATE preferences SET revision=?, data=?, updated_at=? WHERE account_id=?",
            (new_revision, serialized, core.now_iso(), account["id"]),
        )
    return {"revision": new_revision}


if __name__ == "__main__":
    uvicorn.run(app, host=core.API_BIND, port=core.API_PORT)