import json
from contextlib import closing

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import core

core.init_db()

app = FastAPI(title="StickMate Admin")

POLICY_LIMITS = {
    "offline_grace_days": (1, 3650),
    "preference_max_bytes": (1, 10485760),
    "auth_rate_limit": (1, 10000),
    "sync_rate_limit": (1, 100000),
}

PANEL_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>StickMate Admin</title>
<style>
body{font-family:monospace;margin:20px;background:#fff;color:#111}
table{border-collapse:collapse}
td,th{border:1px solid #111;padding:4px 8px;text-align:left}
button,input{border:1px solid #111;border-radius:0;padding:4px;background:#fff;font-family:monospace}
section{margin-top:16px}
label{margin-right:12px}
</style>
</head>
<body>
<h1>StickMate Admin</h1>
<div id="login">
<input id="token" type="password" placeholder="Admin token">
<button onclick="signIn()">Sign in</button>
<span id="loginmsg"></span>
</div>
<div id="panel" hidden>
<section><h2>Status</h2><pre id="status"></pre></section>
<section><h2>Accounts</h2><table id="accounts"></table></section>
<section><h2>Policy</h2>
<div id="policy"></div>
<button onclick="savePolicy()">Save</button> <span id="policymsg"></span>
</section>
<section><button onclick="loadAudit()">Load audit</button><pre id="audit"></pre></section>
</div>
<script>
let token = "";
const POLICY_KEYS = [
  ["offline_grace_days", 1, 3650],
  ["preference_max_bytes", 1, 10485760],
  ["auth_rate_limit", 1, 10000],
  ["sync_rate_limit", 1, 100000]
];
for (const [key, low, high] of POLICY_KEYS) {
  const label = document.createElement("label");
  label.textContent = key + " ";
  const input = document.createElement("input");
  input.type = "number";
  input.id = "policy-" + key;
  input.min = low;
  input.max = high;
  label.appendChild(input);
  document.getElementById("policy").appendChild(label);
}
async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({"Authorization": "Bearer " + token}, opts.headers || {});
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function signIn() {
  token = document.getElementById("token").value;
  try {
    await api("/admin/health");
    document.getElementById("login").hidden = true;
    document.getElementById("panel").hidden = false;
    await refresh();
  } catch (e) {
    token = "";
    document.getElementById("loginmsg").textContent = "Sign in failed";
  }
}
async function refresh() {
  const s = await api("/admin/status");
  document.getElementById("status").textContent = JSON.stringify(s);
  const rows = await api("/admin/accounts");
  const t = document.getElementById("accounts");
  t.innerHTML = "<tr><th>id</th><th>login</th><th>suspended</th><th>created</th><th>actions</th></tr>";
  for (const a of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
    tr.children[0].textContent = a.id;
    tr.children[1].textContent = a.login;
    tr.children[2].textContent = a.suspended;
    tr.children[3].textContent = a.created_at;
    for (const act of ["suspend", "unsuspend", "revoke"]) {
      const b = document.createElement("button");
      b.textContent = act;
      b.onclick = async () => {
        await api("/admin/accounts/" + a.id + "/" + act, {method: "POST"});
        await refresh();
      };
      tr.children[4].appendChild(b);
    }
    t.appendChild(tr);
  }
  const p = await api("/admin/policy");
  for (const [key] of POLICY_KEYS) {
    document.getElementById("policy-" + key).value = p[key];
  }
}
async function savePolicy() {
  for (const [key] of POLICY_KEYS) {
    await api("/admin/policy", {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({key: key, value: document.getElementById("policy-" + key).value})
    });
  }
  document.getElementById("policymsg").textContent = "Saved";
  await refresh();
}
async function loadAudit() {
  const rows = await api("/admin/audit");
  document.getElementById("audit").textContent = JSON.stringify(rows, null, 1);
}
</script>
</body>
</html>
"""


class PolicyBody(BaseModel):
    key: str
    value: str


def require_admin(authorization: str = Header(default="")):
    if not core.check_admin_token(authorization):
        raise HTTPException(status_code=401, detail="invalid admin token")


def get_account_or_404(conn, account_id):
    row = conn.execute("SELECT id, login FROM accounts WHERE id=?", (account_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="account not found")
    return row


@app.get("/admin/", response_class=HTMLResponse)
def panel():
    return PANEL_HTML


@app.get("/admin/health")
def health(_=Depends(require_admin)):
    return {"status": "ok"}


@app.get("/admin/accounts")
def accounts(_=Depends(require_admin)):
    with closing(core.db()) as conn:
        rows = conn.execute(
            "SELECT id, login, suspended, created_at FROM accounts ORDER BY id"
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/admin/accounts/{account_id}/suspend")
def suspend(account_id: int, _=Depends(require_admin)):
    with closing(core.db()) as conn, conn:
        get_account_or_404(conn, account_id)
        conn.execute("UPDATE accounts SET suspended=1 WHERE id=?", (account_id,))
        conn.execute("UPDATE sessions SET revoked=1 WHERE account_id=?", (account_id,))
        core.audit(conn, "admin", "suspend", json.dumps({"account_id": account_id}))
    return {"status": "ok"}


@app.post("/admin/accounts/{account_id}/unsuspend")
def unsuspend(account_id: int, _=Depends(require_admin)):
    with closing(core.db()) as conn, conn:
        get_account_or_404(conn, account_id)
        conn.execute("UPDATE accounts SET suspended=0 WHERE id=?", (account_id,))
        core.audit(conn, "admin", "unsuspend", json.dumps({"account_id": account_id}))
    return {"status": "ok"}


@app.post("/admin/accounts/{account_id}/revoke")
def revoke(account_id: int, _=Depends(require_admin)):
    with closing(core.db()) as conn, conn:
        get_account_or_404(conn, account_id)
        conn.execute("UPDATE sessions SET revoked=1 WHERE account_id=?", (account_id,))
        core.audit(conn, "admin", "revoke", json.dumps({"account_id": account_id}))
    return {"status": "ok"}


@app.get("/admin/policy")
def get_policy(_=Depends(require_admin)):
    with closing(core.db()) as conn:
        return core.get_policy(conn)


@app.put("/admin/policy")
def put_policy(body: PolicyBody, _=Depends(require_admin)):
    if body.key not in POLICY_LIMITS:
        raise HTTPException(status_code=400, detail="unknown policy key")
    low, high = POLICY_LIMITS[body.key]
    try:
        number = int(body.value)
    except ValueError:
        raise HTTPException(status_code=400, detail="value must be a whole number")
    if number < low or number > high:
        raise HTTPException(status_code=400, detail="value out of range")
    with closing(core.db()) as conn, conn:
        conn.execute(
            "INSERT INTO policy(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (body.key, str(number)),
        )
        core.audit(conn, "admin", "policy_update", json.dumps({"key": body.key, "value": number}))
    return {"status": "ok", "key": body.key, "value": str(number)}


@app.get("/admin/status")
def status(_=Depends(require_admin)):
    with closing(core.db()) as conn:
        accounts_count = conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"]
        sessions_count = conn.execute(
            "SELECT COUNT(*) AS n FROM sessions WHERE revoked=0"
        ).fetchone()["n"]
    return {"accounts": accounts_count, "active_sessions": sessions_count, "version": core.read_version()}


@app.get("/admin/audit")
def audit_log(_=Depends(require_admin)):
    with closing(core.db()) as conn:
        rows = conn.execute(
            "SELECT id, at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 100"
        ).fetchall()
    return [dict(row) for row in rows]


if __name__ == "__main__":
    uvicorn.run(app, host=core.ADMIN_BIND, port=core.ADMIN_PORT)