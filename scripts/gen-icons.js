#!/usr/bin/env node
// Gera os ícones PNG do PWA (192, 512 e maskable 512) e o favicon SVG a partir da mesma arte
// pixel do mascote — sem dependências (encoder PNG próprio com zlib).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PARTS, PALETTE } from '../public/js/mascot-art.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// grade 32x32 com a pose "idle"
const grid = Array.from({ length: 32 }, () => Array(32).fill(null));
for (const part of PARTS) {
  if (!part.icon) continue;
  for (const [x, y, w, h, color] of part.rects) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && i < 32 && j >= 0 && j < 32) grid[j][i] = PALETTE[color];
  }
}

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

function render(size, artFraction) {
  const px = Math.floor((size * artFraction) / 32);
  const off = Math.floor((size - px * 32) / 2);
  const rgba = Buffer.alloc(size * size * 4);
  for (let p = 0; p < size * size; p++) rgba[p * 4 + 3] = 255; // fundo preto opaco
  for (let j = 0; j < 32; j++)
    for (let i = 0; i < 32; i++) {
      const c = grid[j][i];
      if (!c) continue;
      const [r, g, b] = hex(c);
      for (let y = off + j * px; y < off + (j + 1) * px; y++)
        for (let x = off + i * px; x < off + (i + 1) * px; x++) {
          const k = (y * size + x) * 4;
          rgba[k] = r;
          rgba[k + 1] = g;
          rgba[k + 2] = b;
        }
    }
  return png(size, size, rgba);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, 0.86));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, 0.86));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, 0.6));

let rects = '';
for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) if (grid[j][i]) rects += `<rect x="${i}" y="${j}" width="1" height="1" fill="${grid[j][i]}"/>`;
fs.writeFileSync(
  path.join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${rects}</svg>\n`
);
console.log('Ícones gerados em public/icons/');
