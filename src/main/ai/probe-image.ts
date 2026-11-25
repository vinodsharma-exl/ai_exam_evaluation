/**
 * Builds a small PNG with the word "TEST" in large block letters, for the vision check in
 * Test connection. It is generated in code (5×7 pixel font, scaled up), so no binary asset ships.
 */
import { deflateSync } from 'node:zlib';
import { PROBE_VISION_EXPECTED } from '../../shared/prompts/templates';

const FONT: Record<string, string[]> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encodes an 8-bit grayscale image (0 = black, 255 = white) as PNG. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ink: 0 = black; higher values give lighter strokes (e.g. 190 ≈ faint pencil). paper: background level. */
export function renderWordPng(word: string, scale = 12, margin = 24, ink = 0, paper = 255): Buffer {
  const glyphW = 5;
  const glyphH = 7;
  const gap = 2;
  const cols = word.length * (glyphW + gap) - gap;
  const width = cols * scale + margin * 2;
  const height = glyphH * scale + margin * 2;
  const px = new Uint8Array(width * height).fill(paper);
  [...word].forEach((ch, i) => {
    const g = FONT[ch];
    if (!g) throw new Error(`No glyph for ${ch}`);
    for (let gy = 0; gy < glyphH; gy++)
      for (let gx = 0; gx < glyphW; gx++) {
        if (g[gy]![gx] !== '1') continue;
        const x0 = margin + (i * (glyphW + gap) + gx) * scale;
        const y0 = margin + gy * scale;
        for (let y = y0; y < y0 + scale; y++) px.fill(ink, y * width + x0, y * width + x0 + scale);
      }
  });
  return encodeGrayPng(width, height, px);
}

let cached: Buffer | null = null;
export function probePng(): Buffer {
  return (cached ??= renderWordPng(PROBE_VISION_EXPECTED));
}
