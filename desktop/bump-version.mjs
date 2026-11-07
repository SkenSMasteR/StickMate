import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node bump-version.mjs X.Y.Z");
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

console.log(version);