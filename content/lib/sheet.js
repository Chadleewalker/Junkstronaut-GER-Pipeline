'use strict';
// Contact sheets, so an agent can actually see the art.
//
// The sprites in this pack are ~29x29 px. At that size a model reading them one at a time is
// guessing at a smudge; the same sprites at 7x on a neutral ground are unambiguous. So the
// pipeline renders its own contact sheets rather than handing over raw files, and it renders
// them with code — deterministic, replayable, and identical on every run.
//
// PNG in, PNG out, zlib only. No dependency, in line with the rest of the repo. Handles the
// 8-bit RGBA non-interlaced files this pack ships; anything else throws by name rather than
// silently producing a garbled sheet.

const fs = require('fs');
const zlib = require('zlib');

// -- decode -----------------------------------------------------------------

function decodePng(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const depth = b[24], colour = b[25], interlace = b[28];
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${file}: unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace}) — this reader handles 8-bit RGBA only`);
  }

  let o = 8; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    if (b.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Undo the per-scanline filters. Each output byte depends on ones already written, so this
  // walks in place rather than building intermediate rows.
  const stride = w * 4, bpp = 4;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
      } else if (ft !== 0) throw new Error(`${file}: unknown scanline filter ${ft}`);
      px[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, px };
}

// -- encode -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(w, h, px) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none. The sheet compresses well enough flat.
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -- contact sheet ----------------------------------------------------------

// Mid-grey with a slight cool bias: dark sprites and bright sprites both stay legible on it,
// and it is nothing like any colour in the pack, so a sprite's own edges never disappear.
const GROUND = [58, 61, 70];

/**
 * Tile sprites into one sheet. Cells are numbered left-to-right, top-to-bottom starting at 1,
 * and the returned `cells` array is the key the agent is given — position is the only handle
 * it has on which sprite is which, so it is returned rather than recomputed by the caller.
 */
function contactSheet(files, { cols = 5, cell = 210, scale = 7 } = {}) {
  if (!files.length) throw new Error('contactSheet: no files');
  const rows = Math.ceil(files.length / cols);
  const W = cols * cell, H = rows * cell;
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = GROUND[0]; px[i * 4 + 1] = GROUND[1]; px[i * 4 + 2] = GROUND[2]; px[i * 4 + 3] = 255;
  }

  const cells = files.map((file, i) => {
    const img = decodePng(file);
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    // Nearest-neighbour only — pixel art must not be smoothed, and a blurred sheet would
    // make the reading worse than no sheet at all.
    const dw = Math.min(img.w * scale, cell - 6), dh = Math.min(img.h * scale, cell - 6);
    const ox = cx + ((cell - dw) >> 1), oy = cy + ((cell - dh) >> 1);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = (Math.floor(y * img.h / dh) * img.w + Math.floor(x * img.w / dw)) * 4;
        const d = ((oy + y) * W + ox + x) * 4;
        const a = img.px[s + 3] / 255;
        for (let c = 0; c < 3; c++) px[d + c] = Math.round(img.px[s + c] * a + px[d + c] * (1 - a));
      }
    }
    // A white L in each cell's corner. Without it a reader has to infer the grid from the
    // sprites themselves, and a cell holding a small sprite reads as empty space.
    for (let k = 0; k < 7; k++) {
      for (const [x, y] of [[cx + k, cy], [cx, cy + k]]) {
        const d = (y * W + x) * 4;
        px[d] = 235; px[d + 1] = 238; px[d + 2] = 242;
      }
    }
    return { cell: i + 1, file, row: Math.floor(i / cols) + 1, col: (i % cols) + 1, w: img.w, h: img.h };
  });

  return { png: encodePng(W, H, px), cells, cols, rows, width: W, height: H };
}

module.exports = { contactSheet, decodePng, encodePng };
