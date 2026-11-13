#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "SkenSMasteR/StickMate";
const dry = process.argv.includes("--dry-run");

async function main() {
  let suffix;
  if (process.platform === "win32" && process.arch === "x64") suffix = "-setup.exe";
  else if (process.platform === "linux" && process.arch === "x64") suffix = ".AppImage";
  else {
    console.error(`no StickMate build for ${process.platform} ${process.arch}`);
    return 1;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "stickmate-installer" },
  });
  if (!res.ok) {
    console.error(`could not read the latest release (${res.status})`);
    return 1;
  }
  const release = await res.json();
  const asset = release.assets.find((item) => item.name.endsWith(suffix));
  if (!asset) {
    console.error(`the latest release has no ${suffix} build`);
    return 1;
  }

  if (dry) {
    console.log(`${release.tag_name} ${asset.name} ${asset.browser_download_url}`);
    return 0;
  }

  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) {
    console.error(`could not download ${asset.name} (${dl.status})`);
    return 1;
  }
  const file = path.join(os.tmpdir(), asset.name);
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));

  if (process.platform === "win32") {
    spawn(file, [], { detached: true, stdio: "ignore" }).unref();
    console.log(`StickMate ${release.tag_name} installer launched`);
  } else {
    const dir = path.join(os.homedir(), ".local", "bin");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "stickmate");
    fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o755);
    console.log(`StickMate ${release.tag_name} installed to ${target}`);
  }
  return 0;
}

process.exitCode = await main();