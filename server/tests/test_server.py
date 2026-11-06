import os
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="stickmate-test-")
os.environ["STICKMATE_DATA_DIR"] = TMP
os.environ["STICKMATE_DB_PATH"] = os.path.join(TMP, "stickmate.db")
os.environ["STICKMATE_ADMIN_TOKEN"] = "test-admin-token"
os.environ["GITHUB_CLIENT_ID"] = "test-client-id"
os.environ["GITHUB_CLIENT_SECRET"] = "test-client-secret"
os.environ["STICKMATE_PUBLIC_URL"] = "http://testserver"
os.environ["STICKMATE_GITHUB_API"] = "https://api.github.test"

import pytest
from fastapi.testclient import TestClient

import core
import app as app_module
import admin as admin_module

ADMIN_HEADERS = {"Authorization": "Bearer test-admin-token"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app_module.app) as c:
        yield c


@pytest.fixture(scope="module")
def admin_client():
    with TestClient(admin_module.app) as c:
        c.headers.update(ADMIN_HEADERS)
        yield c


def sign_in(client, monkeypatch, github_id, login):
    monkeypatch.setattr(core, "exchange_code", lambda code: "gh-token-" + code)
    monkeypatch.setattr(core, "fetch_user", lambda token: {"id": github_id, "login": login})
    start = client.post("/auth/device/start").json()
    redirect = client.get(
        "/auth/github/start",
        params={"user_code": start["user_code"]},
        follow_redirects=False,
    )
    assert redirect.status_code == 302
    query = parse_qs(urlparse(redirect.headers["location"]).query)
    state = query["state"][0]
    callback = client.get("/auth/github/callback", params={"code": "fake-code", "state": state})
    assert callback.status_code == 200
    assert "Signed in. You can close this window." in callback.text
    poll = client.post("/auth/device/poll", json={"device_code": start["device_code"]}).json()
    assert poll["status"] == "ok"
    return poll


def auth(token):
    return {"Authorization": "Bearer " + token}


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == core.read_version()


def test_public_key(client):
    response = client.get("/auth/public-key")
    assert response.status_code == 200
    assert response.json()["public_key"].startswith("-----BEGIN PUBLIC KEY-----")


def test_device_start_and_poll_pending(client):
    response = client.post("/auth/device/start")
    assert response.status_code == 200
    body = response.json()
    assert len(body["user_code"]) == 8
    assert body["user_code"].isupper()
    assert body["interval"] == 5
    assert body["expires_in"] == 600
    assert body["verification_uri"] == "http://testserver/auth/verify?user_code=" + body["user_code"]
    poll = client.post("/auth/device/poll", json={"device_code": body["device_code"]})
    assert poll.json() == {"status": "pending"}
    page = client.get("/auth/verify", params={"user_code": body["user_code"]})
    assert page.status_code == 200
    assert "Sign in with GitHub" in page.text
    assert "/auth/github/start?user_code=" + body["user_code"] in page.text


def test_device_poll_expired(client):
    from contextlib import closing

    start = client.post("/auth/device/start").json()
    with closing(core.db()) as conn, conn:
        conn.execute(
            "UPDATE device_codes SET expires_at=? WHERE code=?",
            ("2000-01-01T00:00:00+00:00", start["device_code"]),
        )
    poll = client.post("/auth/device/poll", json={"device_code": start["device_code"]})
    assert poll.json() == {"status": "expired"}


def test_full_authorized_flow(client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 101, "alice")
    assert tokens["account"]["login"] == "alice"
    assert isinstance(tokens["account"]["id"], int)
    payload = core.verify_token(tokens["access_token"], "access")
    assert payload["account_id"] == tokens["account"]["id"]
    assert payload["exp"] - payload["iat"] == 3600
    offline = core.verify_token(tokens["offline_token"], "offline")
    assert offline["account_id"] == tokens["account"]["id"]
    assert tokens["refresh_token"]
    again = client.post("/auth/device/poll", json={"device_code": "gone"})
    assert again.status_code == 400


def test_github_start_redirect(client):
    start = client.post("/auth/device/start").json()
    redirect = client.get(
        "/auth/github/start",
        params={"user_code": start["user_code"]},
        follow_redirects=False,
    )
    assert redirect.status_code == 302
    location = redirect.headers["location"]
    assert location.startswith("https://github.com/login/oauth/authorize?")
    query = parse_qs(urlparse(location).query)
    assert query["client_id"] == ["test-client-id"]
    assert query["scope"] == ["read:user"]
    assert query["redirect_uri"] == ["http://testserver/auth/github/callback"]


def test_callback_bad_state(client):
    response = client.get("/auth/github/callback", params={"code": "x", "state": "nope"})
    assert response.status_code == 400


def test_refresh_rotates(client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 102, "bob")
    old_refresh = tokens["refresh_token"]
    response = client.post("/auth/refresh", json={"refresh_token": old_refresh})
    assert response.status_code == 200
    rotated = response.json()
    assert rotated["status"] == "ok"
    assert rotated["refresh_token"] != old_refresh
    assert "account" not in rotated
    core.verify_token(rotated["access_token"], "access")
    core.verify_token(rotated["offline_token"], "offline")
    replay = client.post("/auth/refresh", json={"refresh_token": old_refresh})
    assert replay.status_code == 401
    preferences = client.get("/preferences", headers=auth(rotated["access_token"]))
    assert preferences.status_code == 200


def test_logout(client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 103, "carol")
    response = client.post("/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    assert response.json() == {"status": "ok"}
    after = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert after.status_code == 401


def test_suspended_account_rejected(client, admin_client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 104, "dave")
    account_id = tokens["account"]["id"]
    response = admin_client.post(f"/admin/accounts/{account_id}/suspend")
    assert response.status_code == 200
    denied = client.get("/preferences", headers=auth(tokens["access_token"]))
    assert denied.status_code == 403
    refresh_denied = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refresh_denied.status_code in (401, 403)
    response = admin_client.post(f"/admin/accounts/{account_id}/unsuspend")
    assert response.status_code == 200
    fresh = sign_in(client, monkeypatch, 104, "dave")
    assert fresh["account"]["id"] == account_id
    allowed = client.get("/preferences", headers=auth(fresh["access_token"]))
    assert allowed.status_code == 200


def test_preferences_get_put_and_conflict(client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 105, "erin")
    headers = auth(tokens["access_token"])
    initial = client.get("/preferences", headers=headers).json()
    assert initial == {"revision": 0, "data": {}}
    put = client.put(
        "/preferences",
        headers=headers,
        json={"base_revision": 0, "data": {"theme": "dark"}},
    )
    assert put.status_code == 200
    assert put.json() == {"revision": 1}
    current = client.get("/preferences", headers=headers).json()
    assert current == {"revision": 1, "data": {"theme": "dark"}}
    conflict = client.put(
        "/preferences",
        headers=headers,
        json={"base_revision": 0, "data": {"theme": "light"}},
    )
    assert conflict.status_code == 409
    assert conflict.json() == {"error": "conflict", "revision": 1}


def test_preference_size_limit(client, admin_client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 106, "frank")
    headers = auth(tokens["access_token"])
    response = admin_client.put(
        "/admin/policy", json={"key": "preference_max_bytes", "value": "64"}
    )
    assert response.status_code == 200
    big = client.put(
        "/preferences",
        headers=headers,
        json={"base_revision": 0, "data": {"blob": "x" * 200}},
    )
    assert big.status_code == 413
    small = client.put(
        "/preferences",
        headers=headers,
        json={"base_revision": 0, "data": {"a": 1}},
    )
    assert small.status_code == 200
    admin_client.put("/admin/policy", json={"key": "preference_max_bytes", "value": "262144"})


def test_access_token_required(client, monkeypatch):
    assert client.get("/preferences").status_code == 401
    assert client.get("/preferences", headers=auth("garbage")).status_code == 401
    tokens = sign_in(client, monkeypatch, 107, "grace")
    offline_as_access = client.get("/preferences", headers=auth(tokens["offline_token"]))
    assert offline_as_access.status_code == 401


def test_admin_auth_required(admin_client):
    plain = TestClient(admin_module.app)
    paths = ["/admin/health", "/admin/accounts", "/admin/policy", "/admin/status", "/admin/audit"]
    for path in paths:
        assert plain.get(path).status_code == 401
        assert plain.get(path, headers=auth("wrong-token")).status_code == 401
    assert plain.post("/admin/accounts/1/suspend").status_code == 401
    assert plain.put("/admin/policy", json={"key": "offline_grace_days", "value": "7"}).status_code == 401
    for path in paths:
        assert admin_client.get(path).status_code == 200


def test_admin_panel_html(admin_client):
    response = admin_client.get("/admin/")
    assert response.status_code == 200
    assert "Admin token" in response.text
    assert "localStorage" not in response.text


def test_admin_suspend_revokes_sessions(client, admin_client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 108, "heidi")
    account_id = tokens["account"]["id"]
    admin_client.post(f"/admin/accounts/{account_id}/suspend")
    rows = admin_client.get("/admin/accounts").json()
    match = [row for row in rows if row["id"] == account_id]
    assert match and match[0]["suspended"] == 1
    replay = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert replay.status_code in (401, 403)
    admin_client.post(f"/admin/accounts/{account_id}/unsuspend")


def test_admin_revoke(client, admin_client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 109, "ivan")
    account_id = tokens["account"]["id"]
    response = admin_client.post(f"/admin/accounts/{account_id}/revoke")
    assert response.status_code == 200
    replay = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert replay.status_code == 401
    still_valid = client.get("/preferences", headers=auth(tokens["access_token"]))
    assert still_valid.status_code == 200


def test_admin_policy_update_and_validation(admin_client):
    current = admin_client.get("/admin/policy").json()
    assert current["offline_grace_days"] == "30"
    assert current["preference_max_bytes"] == "262144"
    response = admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "7"})
    assert response.status_code == 200
    assert admin_client.get("/admin/policy").json()["offline_grace_days"] == "7"
    assert admin_client.put("/admin/policy", json={"key": "unknown_key", "value": "1"}).status_code == 400
    assert admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "abc"}).status_code == 400
    assert admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "0"}).status_code == 400
    assert admin_client.put("/admin/policy", json={"key": "preference_max_bytes", "value": "99999999"}).status_code == 400
    admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "30"})


def test_offline_token_grace_days(client, admin_client, monkeypatch):
    admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "7"})
    tokens = sign_in(client, monkeypatch, 110, "judy")
    payload = core.verify_token(tokens["offline_token"], "offline")
    assert payload["exp"] - payload["iat"] == 7 * 86400
    admin_client.put("/admin/policy", json={"key": "offline_grace_days", "value": "30"})
    rotated = client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).json()
    payload = core.verify_token(rotated["offline_token"], "offline")
    assert payload["exp"] - payload["iat"] == 30 * 86400


def test_verify_token_rejects_tampered(client, monkeypatch):
    tokens = sign_in(client, monkeypatch, 111, "mallory")
    token = tokens["access_token"]
    body, signature = token.split(".")
    tampered = body[:-2] + ("aa" if body[-2:] != "aa" else "bb") + "." + signature
    with pytest.raises(ValueError):
        core.verify_token(tampered, "access")
    with pytest.raises(ValueError):
        core.verify_token(token, "offline")


def test_admin_status_and_audit(admin_client):
    status = admin_client.get("/admin/status").json()
    assert status["accounts"] >= 1
    assert status["active_sessions"] >= 1
    assert status["version"] == core.read_version()
    rows = admin_client.get("/admin/audit").json()
    assert 1 <= len(rows) <= 100
    actions = {row["action"] for row in rows}
    assert "suspend" in actions
    assert "policy_update" in actions
    assert all(set(row) == {"id", "at", "actor", "action", "detail"} for row in rows)