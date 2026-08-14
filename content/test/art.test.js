'use strict';
// Tests for the art stage.
//
// The interesting claim here is not "it renders a sheet" — it is that the two agents are kept
// apart: the reader never learns a piece's name, and the matcher never sees a picture. That
// separation is the only reason a verdict means anything, and it is one careless prompt edit away
// from quietly disappearing. Most of what follows tests exactly that.
//
//   node --test "test/*.test.js"

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { contactSheet, decodePng, encodePng } = require('../lib/sheet');
const {
  findArtDir, resolveSprites, planSheets, renderSheets, sheetInputs, attachReading, matchInputs,
  PER_SHEET,
} = require('../lib/art');

// -- a tiny PNG to test against, built rather than committed ------------------
// Committing binary fixtures to test a PNG reader is circular: if the writer is wrong, the
// fixture is wrong in the same way. These are generated from known pixel values.

function makePng(w, h, rgba) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgba[0]; px[i * 4 + 1] = rgba[1]; px[i * 4 + 2] = rgba[2]; px[i * 4 + 3] = rgba[3];
  }
  return { png: encodePng(w, h, px), px };
}

function tmpArt(ids, { pattern = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-art-'));
  ids.forEach((id, i) => {
    const { png } = makePng(8 + i, 8, [10 * i, 20, 30, 255]);
    fs.writeFileSync(path.join(dir, pattern ? pattern.replace('%d', String(i + 1)) : `${id}.png`), png);
  });
  return dir;
}

const piecesFor = (ids) => ids.map((id, i) => ({
  id, display_name: id, mass_kg: 10 + i, altitude_m: 50000 + i * 1000,
  size_class: 'small', fragile: i % 2 === 0,
}));

// ---------------------------------------------------------------- png codec

test('a PNG survives a round trip through the reader and the writer', () => {
  const { png, px } = makePng(9, 5, [200, 100, 50, 255]);
  const file = path.join(os.tmpdir(), `junk-rt-${process.pid}.png`);
  fs.writeFileSync(file, png);
  const back = decodePng(file);
  assert.strictEqual(back.w, 9);
  assert.strictEqual(back.h, 5);
  assert.deepStrictEqual(back.px, px);
  fs.rmSync(file, { force: true });
});

test('every scanline filter decodes to the same image', () => {
  // The pack's own files use filters the encoder here never emits, so the decoder is exercised
  // against all five rather than only the one we write.
  const w = 6, h = 4;
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = (i * 7) & 0xff; px[i * 4 + 1] = (i * 13) & 0xff;
    px[i * 4 + 2] = (i * 29) & 0xff; px[i * 4 + 3] = 255;
  }
  for (const filter of [0, 1, 2, 3, 4]) {
    const stride = w * 4;
    const raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) {
      raw[y * (stride + 1)] = filter;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? px[y * stride + x - 4] : 0;
        const up = y > 0 ? px[(y - 1) * stride + x] : 0;
        const ul = (x >= 4 && y > 0) ? px[(y - 1) * stride + x - 4] : 0;
        let v = px[y * stride + x];
        if (filter === 1) v -= a;
        else if (filter === 2) v -= up;
        else if (filter === 3) v -= (a + up) >> 1;
        else if (filter === 4) {
          const p = a + up - ul;
          const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          v -= (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
        }
        raw[y * (stride + 1) + 1 + x] = v & 0xff;
      }
    }
    const crcT = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (const y of b) c = crcT[(c ^ y) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(body));
      return Buffer.concat([len, body, cc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const file = path.join(os.tmpdir(), `junk-f${filter}-${process.pid}.png`);
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
    assert.deepStrictEqual(decodePng(file).px, px, `filter ${filter} did not round trip`);
    fs.rmSync(file, { force: true });
  }
});

test('an unsupported PNG is rejected by name rather than decoded into noise', () => {
  const file = path.join(os.tmpdir(), `junk-bad-${process.pid}.png`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; ihdr[9] = 2; // RGB, no alpha — not what this reader handles
  const buf = Buffer.alloc(8 + 12 + 13);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); buf.write('IHDR', 12, 'ascii'); ihdr.copy(buf, 16);
  fs.writeFileSync(file, buf);
  assert.throws(() => decodePng(file), /unsupported PNG/);
  fs.rmSync(file, { force: true });
});

// ---------------------------------------------------------------- contact sheet

test('the contact sheet numbers cells left to right, then top to bottom', () => {
  const dir = tmpArt(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => path.join(dir, `${id}.png`));
  const sheet = contactSheet(files, { cols: 5, cell: 40, scale: 2 });
  assert.strictEqual(sheet.cells.length, 7);
  assert.deepStrictEqual(sheet.cells.map((c) => c.cell), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(sheet.cells[4], { ...sheet.cells[4], row: 1, col: 5 });
  assert.deepStrictEqual(sheet.cells[5], { ...sheet.cells[5], row: 2, col: 1 });
  assert.strictEqual(sheet.width, 200);
  assert.strictEqual(sheet.height, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the sheet it writes is a PNG this codebase can read back', () => {
  const dir = tmpArt(['a', 'b']);
  const sheet = contactSheet([path.join(dir, 'a.png'), path.join(dir, 'b.png')], { cols: 2, cell: 30, scale: 2 });
  const file = path.join(dir, 'sheet.png');
  fs.writeFileSync(file, sheet.png);
  const back = decodePng(file);
  assert.strictEqual(back.w, 60);
  assert.strictEqual(back.h, 30);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the blindness invariant

test('the reader is never told a name — only a file, a grid and cell numbers', () => {
  const ids = ['torn_foil_blanket', 'cracked_solar_array', 'armstrongs_module'];
  const sheets = planSheets(piecesFor(ids));
  const text = JSON.stringify(sheetInputs({ ...sheets[0], file: '/tmp/sheet1.png' }));
  for (const id of ids) {
    assert.ok(!text.includes(id), `the reader's prompt leaked "${id}"`);
  }
  for (const word of ['foil', 'solar', 'Armstrong', 'blanket']) {
    assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `the reader's prompt leaked "${word}"`);
  }
  assert.match(text, /cell/i);
});

test('the matcher is never given an image — only the name and the blind reading', () => {
  const pieces = piecesFor(['cracked_solar_array']);
  const readings = [{
    id: 'cracked_solar_array', depicts: 'Blue cells broken into two shards',
    detail: 'A panel of blue cells split across the middle.', condition: 'cracked',
    bulk: 'flat', palette: ['blue'], legible: 'clear',
  }];
  const text = JSON.stringify(matchInputs(pieces, readings));
  assert.ok(!/\.png/i.test(text), 'the matcher was handed a path to a sprite');
  assert.ok(!/Read tool|contact sheet/i.test(text), 'the matcher was invited to look at the art');
  assert.match(text, /cracked_solar_array/);
  assert.match(text, /Blue cells broken into two shards/);
});

// ---------------------------------------------------------------- sheet planning

test('sheet composition depends on the catalogue alone, so a replay needs no art', () => {
  const ids = Array.from({ length: 32 }, (_, i) => `p${i}`);
  const a = planSheets(piecesFor(ids));
  const b = planSheets(piecesFor(ids));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, Math.ceil(32 / PER_SHEET));
  assert.strictEqual(a[0].pieces.length, PER_SHEET);
  assert.strictEqual(a[a.length - 1].pieces.length, 32 % PER_SHEET || PER_SHEET);
  // Cell numbers restart at 1 on each sheet — the reader is told nothing about the sheets around it.
  for (const s of a) assert.strictEqual(s.pieces[0].cell, 1);
});

test('a reply that skips a cell is reported, not quietly dropped', () => {
  const sheet = planSheets(piecesFor(['a', 'b', 'c']))[0];
  const { rows, gaps } = attachReading(sheet, {
    cells: [
      { cell: 1, depicts: 'x', detail: 'd', condition: 'intact', bulk: 'flat', palette: ['grey'], legible: 'clear' },
      { cell: 3, depicts: 'y', detail: 'd', condition: 'intact', bulk: 'flat', palette: ['grey'], legible: 'clear' },
    ],
  });
  assert.deepStrictEqual(rows.map((r) => r.id), ['a', 'c']);
  assert.deepStrictEqual(gaps, ['b']);
});

test('a reading is attached by cell number, not by the order it came back in', () => {
  const sheet = planSheets(piecesFor(['a', 'b']))[0];
  const { rows } = attachReading(sheet, {
    cells: [
      { cell: 2, depicts: 'second', detail: 'd', condition: 'intact', bulk: 'flat', palette: ['grey'], legible: 'clear' },
      { cell: 1, depicts: 'first', detail: 'd', condition: 'intact', bulk: 'flat', palette: ['grey'], legible: 'clear' },
    ],
  });
  assert.strictEqual(rows.find((r) => r.id === 'a').depicts, 'first');
  assert.strictEqual(rows.find((r) => r.id === 'b').depicts, 'second');
});

// ---------------------------------------------------------------- sprite resolution

test('sprites resolve through the map, and an unmapped piece is named', () => {
  const dir = tmpArt(['x', 'y'], { pattern: 'sprite (%d).png' });
  const pieces = piecesFor(['alpha', 'beta', 'gamma']);
  const map = { filename_pattern: 'sprite (%d).png', catalogue: { alpha: 1, beta: 2 } };
  const { resolved, missing } = resolveSprites(pieces, dir, map);
  assert.deepStrictEqual(resolved.map((p) => p.id), ['alpha', 'beta']);
  assert.deepStrictEqual(missing, ['gamma']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder named for the pieces works with no map at all', () => {
  const dir = tmpArt(['alpha', 'beta']);
  const { resolved, missing } = resolveSprites(piecesFor(['alpha', 'beta']), dir, null);
  assert.strictEqual(resolved.length, 2);
  assert.strictEqual(missing.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no art is a normal state, and an empty --art is an error', () => {
  assert.strictEqual(findArtDir(false, ROOT), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-empty-'));
  assert.throws(() => findArtDir(empty, ROOT), /no PNGs found/);
  fs.rmSync(empty, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rendering

test('rendering a planned sheet writes one PNG per sheet', () => {
  const ids = ['a', 'b', 'c'];
  const dir = tmpArt(ids);
  const pieces = piecesFor(ids);
  const { resolved } = resolveSprites(pieces, dir, null);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-sheets-'));
  const rendered = renderSheets(planSheets(pieces), new Map(resolved.map((p) => [p.id, p])), out);
  assert.strictEqual(rendered.length, 1);
  assert.ok(fs.existsSync(rendered[0].file));
  assert.ok(decodePng(rendered[0].file).w > 0);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('the review page carries the verdict and says why it cannot be published', () => {
  const { renderArtReview } = require('../lib/artsheet');
  const dir = tmpArt(['alpha']);
  const html = renderArtReview([{
    id: 'alpha', display_name: 'Alpha', flavour: 'A line about alpha.',
    spriteFile: path.join(dir, 'alpha.png'),
    mass_kg: 100, altitude_m: 60000, size_class: 'small', fragile: true,
    verdict: 'mismatch', why: 'The drawing is a hex nut.', evidence: 'reading: "A hex nut"',
    suggested_id: 'hex_nut', depicts: 'A hex nut', detail: 'Six flats.', legible: 'clear',
  }], { generatedAt: 'now', catalogPath: 'config/x.json', artDir: 'assets/y' });
  assert.match(html, /data-verdict="mismatch"/);
  assert.match(html, /The drawing is a hex nut/);
  assert.match(html, /hex_nut/);
  assert.match(html, /data:image\/png;base64,/);
  // The page embeds the pack, so it must say so — this is the artifact that cannot be published.
  assert.match(html, /not for redistribution/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- end to end

test('the art stage runs end to end and the writer is told where the id is wrong', () => {
  // A folder named for the pieces, so no sprite map is needed and the fixture stands alone.
  const catalog = JSON.parse(fs.readFileSync(
    [path.join(ROOT, '..', 'crew', 'out', 'data', 'debris_catalog.json'),
      path.join(ROOT, '..', 'config', 'debris_catalog.json')].find((p) => fs.existsSync(p)), 'utf8'));
  const art = tmpArt(catalog.debris.map((p) => p.id));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-e2e-art-'));

  const stdout = execFileSync(process.execPath,
    [path.join(ROOT, 'run-content.js'), '--art', art, '--out', out], {
      cwd: ROOT,
      env: {
        ...process.env,
        JUNK_AGENT_CMD: `node "${path.join(ROOT, 'test', 'fixtures', 'fake-writer.js')}" art-mismatch`,
      },
      encoding: 'utf8',
    });

  assert.match(stdout, /Reading the art/);
  assert.match(stdout, /sprites described/);

  const reading = JSON.parse(fs.readFileSync(path.join(out, 'art', 'art_reading.json'), 'utf8'));
  assert.strictEqual(reading.readings.length, catalog.debris.length,
    'every catalogue piece came back with a reading');

  const match = JSON.parse(fs.readFileSync(path.join(out, 'art', 'art_match.json'), 'utf8'));
  assert.strictEqual(match.totals.judged, catalog.debris.length);
  assert.strictEqual(match.totals.mismatch, 1, 'the fixture disagrees with exactly one piece');

  // The point of the whole stage: a disagreement has to reach the writer, or the flavour text
  // goes on describing the name. This is the assertion that would have caught the original bug.
  const prompt = fs.readFileSync(path.join(out, 'logs', 'debris-flavourist.attempt1.prompt.md'), 'utf8');
  assert.match(prompt, /WHAT A BLIND READER SAW/);
  assert.match(prompt, /the id and the drawing disagree \(mismatch\)/);
  assert.match(prompt, /Describe what is drawn, not what the id claims/);

  // And the writer gets the pictures, not only a description of them. The reader's words are a
  // second opinion; the sprite is the source. A prompt that carries the paraphrase but not the
  // sheets is the telephone game this stage was built to end.
  assert.match(prompt, /THE ART — open every sheet before you write/);
  assert.match(prompt, /sheet1\.png/);
  assert.match(prompt, /1=/, 'the writer is told which cell holds which piece');

  // The page that embeds the pack is written only where the pack is.
  assert.ok(fs.existsSync(path.join(out, 'report', 'art.html')), 'the review page was written');

  fs.rmSync(art, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('with no art the stage stands down and every other artifact is still written', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-noart-'));
  const stdout = execFileSync(process.execPath,
    [path.join(ROOT, 'run-content.js'), '--no-art', '--out', out], {
      cwd: ROOT,
      env: { ...process.env, JUNK_AGENT_CMD: `node "${path.join(ROOT, 'test', 'fixtures', 'fake-writer.js')}" ok` },
      encoding: 'utf8',
    });
  assert.match(stdout, /Reading the art — skipped/);
  assert.ok(!fs.existsSync(path.join(out, 'art', 'art_reading.json')));
  assert.ok(!fs.existsSync(path.join(out, 'report', 'art.html')),
    'no art means no page that embeds it');
  // The published copy of this project runs exactly this way, so the rest must be intact.
  for (const f of ['content/debris_flavour.json', 'report/content.html', 'run.json']) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} was not written`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test('a reads_as failure on a piece the art disputes says so, and still fails', () => {
  const { checkReadsAs } = require('../lib/verify');
  const catalog = new Map([['torn_foil_blanket', {
    id: 'torn_foil_blanket', mass_kg: 15, altitude_m: 52500, size_class: 'small', fragile: true,
  }]]);
  const band = { min: 52500, max: 277000 };
  const written = [{ id: 'torn_foil_blanket', reads_as: ['light', 'low'] }]; // no `fragile`

  const plain = checkReadsAs(written, catalog, band)[0];
  assert.strictEqual(plain.result, 'fail');
  assert.ok(!/art audit/.test(plain.detail), 'with no audit it is just a failure');

  const attributed = checkReadsAs(written, catalog, band, [{
    id: 'torn_foil_blanket', verdict: 'mismatch', suggested_id: 'cracked_hull_plate',
  }])[0];
  // Still a failure. The audit explains it, it does not excuse it — a check that softened
  // because another agent agreed with the writer would stop being a fact about two files.
  assert.strictEqual(attributed.result, 'fail');
  assert.match(attributed.detail, /catalog says fragile/);
  assert.match(attributed.detail, /art audit disputes/);
  assert.match(attributed.detail, /cracked_hull_plate/);
  assert.match(attributed.detail, /reconcile the catalogue rather than the writing/);
});
