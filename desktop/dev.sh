#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not on PATH."
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is not installed, install it from https://rustup.rs."
  exit 1
fi
if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1; then
  echo "Missing Linux prerequisites, install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies."
  npm install
fi
echo "Starting development app."
npm run tauri dev