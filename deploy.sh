#!/usr/bin/env bash
set -euo pipefail

REPO="SkenSMasteR/StickMate"
BASE="/opt/stickmate"
RELEASES="$BASE/releases"
DATA="$BASE/data"
VENV="$BASE/venv"
CURRENT="$BASE/current"
ENV_FILE="/etc/stickmate/stickmate.env"
TMP_DIR=""

cleanup() {
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

die() {
  echo "Error: $*" >&2
  exit 1
}

require_root() {
  [[ $EUID -eq 0 ]] || die "this command must run as root."
}

latest_server_version() {
  gh release list --repo "$REPO" --limit 50 --json tagName,isPrerelease \
    --jq '.[] | select(.isPrerelease == false) | select(.tagName | startswith("server-v")) | .tagName' \
    | sed 's/^server-v//' | sort -V | tail -n 1
}

download_and_verify() {
  local version="$1" tmp tarball
  tmp=$(mktemp -d)
  TMP_DIR="$tmp"
  gh release download "server-v$version" --repo "$REPO" \
    --pattern "stickmate-server-*.tar.gz" --dir "$tmp" >/dev/null \
    || die "download of server-v$version failed."
  tarball="$tmp/stickmate-server-$version.tar.gz"
  [[ -f "$tarball" ]] || die "release asset not found."
  gh attestation verify "$tarball" --repo "$REPO" >/dev/null \
    || die "attestation verification failed."
  mkdir -p "$RELEASES/$version"
  tar -xzf "$tarball" -C "$RELEASES/$version"
  rm -rf "$tmp"
  TMP_DIR=""
}

activate_release() {
  local version="$1"
  ln -sfn "$RELEASES/$version" "$CURRENT"
  chmod 0755 "$CURRENT/deploy.sh"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check \
    -r "$CURRENT/server/requirements.txt"
  chown -R stickmate:stickmate "$BASE"
}

health_check() {
  local i
  for i in 1 2 3 4 5; do
    if curl -fsS http://127.0.0.1:8710/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

current_version() {
  cat "$CURRENT/server/VERSION" 2>/dev/null || true
}

previous_version() {
  local cur="$1" prev
  prev=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
    | grep -vx "$cur" | sort -V | tail -n 1 || true)
  [[ -n "$prev" ]] || die "no previous release found."
  printf '%s\n' "$prev"
}

rollback_release() {
  local cur prev
  cur=$(current_version)
  prev=$(previous_version "$cur")
  activate_release "$prev"
  systemctl restart stickmate-api stickmate-admin
  health_check || die "rollback health check failed."
  echo "Rolled back to $prev."
}

backup_db() {
  local db="$DATA/stickmate.db" ts
  [[ -f "$db" ]] || return 0
  ts=$(date +%Y%m%d%H%M%S)
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$DATA/stickmate.db.bak-$ts'"
  else
    cp "$db" "$DATA/stickmate.db.bak-$ts"
  fi
}

ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    return 0
  fi
  local tmp ver num
  tmp=$(mktemp -d)
  TMP_DIR="$tmp"
  ver=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [[ -n "$ver" ]] || die "could not resolve latest gh release."
  num="${ver#v}"
  curl -fsSL "https://github.com/cli/cli/releases/download/$ver/gh_${num}_linux_amd64.tar.gz" \
    -o "$tmp/gh.tar.gz" || die "gh download failed."
  tar -xzf "$tmp/gh.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/gh_${num}_linux_amd64/bin/gh" /usr/local/bin/gh
  rm -rf "$tmp"
  TMP_DIR=""
}

write_env_template() {
  local token="CHANGE_ME"
  if command -v openssl >/dev/null 2>&1; then
    token=$(openssl rand -hex 32)
  fi
  cat > "$ENV_FILE" <<EOF
GITHUB_CLIENT_ID=CHANGE_ME
GITHUB_CLIENT_SECRET=CHANGE_ME
STICKMATE_ADMIN_TOKEN=$token
STICKMATE_PUBLIC_URL=https://CHANGE_ME
STICKMATE_ADMIN_BIND=127.0.0.1
EOF
  chmod 0600 "$ENV_FILE"
  echo "Edit $ENV_FILE to set your secrets."
}

install_units() {
  install -m 0644 \
    "$CURRENT/systemd/stickmate-api.service" \
    "$CURRENT/systemd/stickmate-admin.service" \
    "$CURRENT/systemd/stickmate-update.service" \
    "$CURRENT/systemd/stickmate-update.timer" \
    /etc/systemd/system/
  systemctl daemon-reload
}

cmd_install() {
  require_root
  local version
  if ! id stickmate >/dev/null 2>&1; then
    useradd --system --home "$BASE" --shell /usr/sbin/nologin stickmate
  fi
  ensure_gh
  mkdir -p "$RELEASES" "$DATA" /etc/stickmate
  if [[ ! -f "$ENV_FILE" ]]; then
    write_env_template
  fi
  version=$(latest_server_version)
  [[ -n "$version" ]] || die "no server release found."
  download_and_verify "$version"
  if [[ ! -d "$VENV" ]]; then
    python3 -m venv "$VENV"
  fi
  activate_release "$version"
  install_units
  systemctl enable --now stickmate-api stickmate-admin stickmate-update.timer
  echo "StickMate $version installed."
}

cmd_update() {
  require_root
  local version cur
  version=$(latest_server_version)
  [[ -n "$version" ]] || die "no server release found."
  cur=$(current_version)
  if [[ "$version" == "$cur" ]]; then
    exit 0
  fi
  download_and_verify "$version"
  backup_db
  activate_release "$version"
  systemctl restart stickmate-api stickmate-admin
  if ! health_check; then
    rollback_release
    exit 1
  fi
  echo "Updated to $version."
}

cmd_rollback() {
  require_root
  rollback_release
}

cmd_start() {
  require_root
  systemctl start stickmate-api stickmate-admin stickmate-update.timer
}

cmd_stop() {
  require_root
  systemctl stop stickmate-api stickmate-admin
}

cmd_restart() {
  require_root
  systemctl restart stickmate-api stickmate-admin
}

cmd_status() {
  systemctl --no-pager --lines=0 status stickmate-api stickmate-admin stickmate-update.timer || true
  echo "Version: $(current_version)"
}

cmd_logs() {
  journalctl -u stickmate-api -u stickmate-admin -n 100 --no-pager "$@"
}

usage() {
  echo "Usage: deploy.sh {install|start|stop|restart|status|logs|update|rollback}" >&2
}

main() {
  local cmd="${1:-}"
  if [[ $# -gt 0 ]]; then
    shift
  fi
  case "$cmd" in
    install) cmd_install ;;
    update) cmd_update ;;
    rollback) cmd_rollback ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"