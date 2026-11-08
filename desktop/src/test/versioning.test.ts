import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "stickmate version "));
  directories.push(root);
  mkdirSync(join(root, "src-tauri"));
  copyFileSync(resolve("bump-version.mjs"), join(root, "bump-version.mjs"));
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    writeFileSync(join(root, file), '{"version": "0.1.8"}\n');
  }
  writeFileSync(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "stickmate"\nversion = "0.1.8"\n');
  writeFileSync(join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "stickmate"\nversion = "0.1.8"\n');
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "0.1.8", packages: { "": { version: "0.1.8" }, dependency: { version: "1.2.3" } } }));
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release version stamping", () => {
  test.each(["0.1.9", "0.1.8-nightly.20261107"])("stamps %s into every manifest", (version) => {
    const root = fixture();
    const result = spawnSync(process.execPath, [join(root, "bump-version.mjs"), version], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
      expect(JSON.parse(readFileSync(join(root, file), "utf8")).version).toBe(version);
    }
    for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
      expect(readFileSync(join(root, file), "utf8")).toContain(`version = "${version}"`);
    }
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    expect(lock.packages.dependency.version).toBe("1.2.3");
  });

  test.each(["0.1.8.20261107", "01.1.8", "0.1.8-nightly.01261107", "invalid"])("rejects %s without modifying files", (version) => {
    const root = fixture();
    const before = readFileSync(join(root, "package.json"), "utf8");
    const result = spawnSync(process.execPath, [join(root, "bump-version.mjs"), version], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });
});
