// Generates a 1024x1024 source PNG for the app icon — a simple, flat padlock
// mark on a solid rounded square. No gradients. Run: node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const buf = new Float32Array(S * S * 4); // straight RGBA, 0..1

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const ia = 1 - a;
  buf[i] = buf[i] * ia + r * a;
  buf[i + 1] = buf[i + 1] * ia + g * a;
  buf[i + 2] = buf[i + 2] * ia + b * a;
  buf[i + 3] = buf[i + 3] * ia + a;
}

// signed distance helpers (negative = inside); coverage with 1px AA
const cov = (sd) => Math.min(Math.max(0.5 - sd, 0), 1);

function sdRoundRect(px, py, cx, cy, w, h, r) {
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function fillRoundRect(cx, cy, w, h, r, [cr, cg, cb], alpha = 1) {
  const x0 = Math.max(0, Math.floor(cx - w / 2 - 2));
  const x1 = Math.min(S, Math.ceil(cx + w / 2 + 2));
  const y0 = Math.max(0, Math.floor(cy - h / 2 - 2));
  const y1 = Math.min(S, Math.ceil(cy + h / 2 + 2));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const c = cov(sdRoundRect(x + 0.5, y + 0.5, cx, cy, w, h, r)) * alpha;
      if (c > 0) blend(x, y, cr, cg, cb, c);
    }
}

// Ring arc (for the padlock shackle): annulus, optionally only the top half.
function fillRing(cx, cy, outer, inner, [cr, cg, cb], topHalfOnly = true) {
  const x0 = Math.max(0, Math.floor(cx - outer - 2));
  const x1 = Math.min(S, Math.ceil(cx + outer + 2));
  const y0 = Math.max(0, Math.floor(cy - outer - 2));
  const y1 = Math.min(S, Math.ceil(cy + outer + 2));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (topHalfOnly && y > cy) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const sd = Math.max(d - outer, inner - d);
      const c = cov(sd);
      if (c > 0) blend(x, y, cr, cg, cb, c);
    }
}

// --- compose ----------------------------------------------------------------
const ACCENT = [0x2f / 255, 0x6f / 255, 0xed / 255];
const WHITE = [1, 1, 1];

// background rounded square
fillRoundRect(S / 2, S / 2, 880, 880, 200, ACCENT);

// shackle (lock bail) sitting above the body
fillRing(S / 2, 430, 150, 96, WHITE);
// square off the shackle legs into the body
fillRoundRect(S / 2 - 123, 470, 54, 90, 6, WHITE);
fillRoundRect(S / 2 + 123, 470, 54, 90, 6, WHITE);

// lock body
fillRoundRect(S / 2, 600, 460, 320, 70, WHITE);

// two "port" slots punched into the body (back to accent)
fillRoundRect(S / 2 - 80, 600, 60, 150, 30, ACCENT);
fillRoundRect(S / 2 + 80, 600, 60, 150, 30, ACCENT);

// --- encode PNG -------------------------------------------------------------
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = y * (S * 4 + 1) + 1 + x * 4;
    const a = buf[i + 3];
    // store straight (un-premultiplied) RGBA
    raw[o] = Math.round((a > 0 ? buf[i] / 1 : 0) * 255);
    raw[o + 1] = Math.round(buf[i + 1] * 255);
    raw[o + 2] = Math.round(buf[i + 2] * 255);
    raw[o + 3] = Math.round(a * 255);
  }
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png", png.length, "bytes");
