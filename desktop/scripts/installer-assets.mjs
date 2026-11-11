import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "nsis");

const BG = [250, 250, 250];
const BORDER = [228, 228, 231];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function decodePng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("only 8-bit PNG supported");
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      px[d] = cur[s];
      px[d + 1] = cur[s + 1];
      px[d + 2] = cur[s + 2];
      px[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, px };
}

function sample(img, fx, fy) {
  const x = Math.min(img.width - 1, Math.max(0, fx));
  const y = Math.min(img.height - 1, Math.max(0, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const out = [0, 0, 0, 0];
  for (let ch = 0; ch < 4; ch++) {
    const i00 = (y0 * img.width + x0) * 4 + ch;
    const i10 = (y0 * img.width + x1) * 4 + ch;
    const i01 = (y1 * img.width + x0) * 4 + ch;
    const i11 = (y1 * img.width + x1) * 4 + ch;
    const top = img.px[i00] * (1 - tx) + img.px[i10] * tx;
    const bot = img.px[i01] * (1 - tx) + img.px[i11] * tx;
    out[ch] = top * (1 - ty) + bot * ty;
  }
  return out;
}

function canvas(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = BG[0];
    px[i * 3 + 1] = BG[1];
    px[i * 3 + 2] = BG[2];
  }
  return { width, height, px };
}

function set(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 3;
  c.px[i] = rgb[0];
  c.px[i + 1] = rgb[1];
  c.px[i + 2] = rgb[2];
}

function blit(c, img, dx, dy, size) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(img, ((x + 0.5) / size) * img.width, ((y + 0.5) / size) * img.height);
      const alpha = a / 255;
      if (alpha <= 0) continue;
      const i = ((dy + y) * c.width + (dx + x)) * 3;
      if (dx + x < 0 || dy + y < 0 || dx + x >= c.width || dy + y >= c.height) continue;
      c.px[i] = Math.round(r * alpha + c.px[i] * (1 - alpha));
      c.px[i + 1] = Math.round(g * alpha + c.px[i + 1] * (1 - alpha));
      c.px[i + 2] = Math.round(b * alpha + c.px[i + 2] * (1 - alpha));
    }
  }
}

function writeBmp(path, c) {
  const rowSize = Math.ceil((c.width * 3) / 4) * 4;
  const dataSize = rowSize * c.height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(c.width, 18);
  buf.writeInt32LE(c.height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < c.height; y++) {
    const srcY = c.height - 1 - y;
    for (let x = 0; x < c.width; x++) {
      const s = (srcY * c.width + x) * 3;
      const d = 54 + y * rowSize + x * 3;
      buf[d] = c.px[s + 2];
      buf[d + 1] = c.px[s + 1];
      buf[d + 2] = c.px[s];
    }
  }
  writeFileSync(path, buf);
  return buf.length;
}

function writePng(path, c) {
  const stride = c.width * 3;
  const raw = Buffer.alloc((stride + 1) * c.height);
  for (let y = 0; y < c.height; y++) {
    raw[y * (stride + 1)] = 0;
    c.px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.width, 0);
  ihdr.writeUInt32BE(c.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  writeFileSync(path, png);
}

const logo = decodePng(join(root, "src", "assets", "logo-light.png"));

mkdirSync(outDir, { recursive: true });

const header = canvas(150, 57);
for (let x = 0; x < header.width; x++) set(header, x, header.height - 1, BORDER);
blit(header, logo, 8, 8, 40);

const sidebar = canvas(164, 314);
for (let y = 0; y < sidebar.height; y++) set(sidebar, sidebar.width - 1, y, BORDER);
blit(sidebar, logo, 22, 36, 120);

const hSize = writeBmp(join(outDir, "header.bmp"), header);
const sSize = writeBmp(join(outDir, "sidebar.bmp"), sidebar);
writePng(join(outDir, "header-preview.png"), header);
writePng(join(outDir, "sidebar-preview.png"), sidebar);

console.log(`header.bmp ${hSize} bytes`);
console.log(`sidebar.bmp ${sSize} bytes`);