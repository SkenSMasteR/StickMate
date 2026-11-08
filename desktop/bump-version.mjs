import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-nightly\.[1-9]\d{7})?$/.test(version ?? "")) {
  console.error("Usage: node bump-version.mjs X.Y.Z[-nightly.YYYYMMDD]");
  process.exit(1);
}

const targets = [
  ["package.json", /("version": ")([^"]+)(")/],
  ["src-tauri/tauri.conf.json", /("version": ")([^"]+)(")/],
  ["src-tauri/Cargo.toml", /(^version = ")([^"]+)(")/m],
  ["src-tauri/Cargo.lock", /(name = "stickmate"\r?\nversion = ")([^"]+)(")/]
];

for (const [file, pattern] of targets) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  let found = false;
  const after = before.replace(pattern, (_match, head, current, tail) => {
    found = true;
    return head + version + tail;
  });
  if (!found) {
    console.error(`Version not found in ${file}`);
    process.exit(1);
  }
  if (after !== before) {
    writeFileSync(path, after);
  }
}

const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
lock.packages[""].version = version;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(version);