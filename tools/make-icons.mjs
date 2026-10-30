// Rasterises the app icon (same design as public/icons/icon.svg) to PNG with
// no native dependencies: hand-coded shapes, 4x4 supersampling, zlib + CRC32.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SS = 4; // subsamples per axis

const hex = (h, a = 1) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a,
];

// ---- shapes (design space is 512x512) ------------------------------------
function inRoundRect(x, y, rx0, ry0, w, h, r) {
  if (x < rx0 || y < ry0 || x >= rx0 + w || y >= ry0 + h) return false;
  const cx = x < rx0 + r ? rx0 + r : x > rx0 + w - r ? rx0 + w - r : x;
  const cy = y < ry0 + r ? ry0 + r : y > ry0 + h - r ? ry0 + h - r : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const BG0 = hex('#0b1020'), BG1 = hex('#151c33');
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

// Each layer: (x, y) -> [r,g,b,a(0..1)] or null. `bgRadius` set per output.
function makeLayers(bgRadius) {
  const rr = (x0, y0, w, h, r, col) => (x, y) => (inRoundRect(x, y, x0, y0, w, h, r) ? col : null);
  const circ = (cx, cy, r, col) => (x, y) => (inCircle(x, y, cx, cy, r) ? col : null);
  const BEZEL = hex('#5a6aa6'), SCREEN = hex('#1a2342');
  return [
    // background: diagonal linear gradient (matches SVG x1,y1=0,0 -> x2,y2=1,1)
    (x, y) => {
      if (bgRadius > 0 && !inRoundRect(x, y, 0, 0, 512, 512, bgRadius)) return null;
      return lerp(BG0, BG1, Math.min(1, Math.max(0, (x + y) / 1024)));
    },
    rr(56, 84, 196, 344, 30, BEZEL), rr(62, 90, 184, 332, 24, SCREEN),
    rr(260, 84, 196, 344, 30, BEZEL), rr(266, 90, 184, 332, 24, SCREEN),
    // soft puck glow: radial gradient, white -> pale -> transparent cyan
    (x, y) => {
      const d = Math.hypot(x - 256, y - 256) / 104;
      if (d >= 1) return null;
      const stops = [[0, [255, 255, 255, 0.6]], [0.35, [207, 233, 255, 0.3]], [1, [79, 209, 255, 0]]];
      for (let i = 1; i < stops.length; i++) {
        if (d <= stops[i][0]) {
          const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
          const t = (d - t0) / (t1 - t0);
          return c0.map((v, k) => v + (c1[k] - v) * t);
        }
      }
      return null;
    },
    circ(154, 340, 50, hex('#c9501b')), circ(154, 340, 43, hex('#ff7a45')), circ(154, 340, 20, hex('#ffb08c')),
    circ(358, 172, 50, hex('#1b94c4')), circ(358, 172, 43, hex('#4fd1ff')), circ(358, 172, 20, hex('#b4ecff')),
    circ(256, 256, 38, hex('#ffffff')), circ(256, 256, 26, hex('#d9e2f5')),
  ];
}

// ---- rasteriser -----------------------------------------------------------
function render(size, { bgRadius }) {
  const layers = makeLayers(bgRadius);
  const px = new Uint8Array(size * size * 4);
  const scale = 512 / size;
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let R = 0, G = 0, B = 0, A = 0; // premultiplied accumulators
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxl + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          let r = 0, g = 0, b = 0, a = 0; // premultiplied sample colour
          for (const layer of layers) {
            const c = layer(x, y);
            if (!c) continue;
            const ca = c[3];
            r = c[0] * ca + r * (1 - ca);
            g = c[1] * ca + g * (1 - ca);
            b = c[2] * ca + b * (1 - ca);
            a = ca + a * (1 - ca);
          }
          R += r; G += g; B += b; A += a;
        }
      }
      const o = (py * size + pxl) * 4;
      const alpha = A / n;
      if (alpha > 0) {
        px[o] = Math.round(R / n / alpha);
        px[o + 1] = Math.round(G / n / alpha);
        px[o + 2] = Math.round(B / n / alpha);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---- PNG encoder ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// opaque=true writes 8-bit RGB (colour type 2, no alpha channel at all).
function encodePng(size, rgba, opaque) {
  const bpp = opaque ? 3 : 4;
  const stride = size * bpp;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = y * (stride + 1) + 1 + x * bpp;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (!opaque) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- outputs ----------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const targets = [
  // rounded-square icons keep transparent corners
  { file: 'icon-192.png', size: 192, bgRadius: 112, opaque: false },
  { file: 'icon-512.png', size: 512, bgRadius: 112, opaque: false },
  { file: 'favicon-32.png', size: 32, bgRadius: 112, opaque: false },
  // iOS masks the icon itself and fills transparency with black: full-bleed, opaque RGB
  { file: 'apple-touch-icon.png', size: 180, bgRadius: 0, opaque: true },
];
for (const t of targets) {
  const png = encodePng(t.size, render(t.size, t), t.opaque);
  writeFileSync(join(OUT, t.file), png);
  console.log(`${t.file}  ${t.size}x${t.size}  ${png.length} bytes`);
}
