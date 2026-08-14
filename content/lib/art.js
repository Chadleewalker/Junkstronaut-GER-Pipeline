'use strict';
// The art stage: look at the sprites, then decide whether each one is the thing its name says.
//
// Two calls, deliberately separated, and the separation is the whole point:
//
//   1. the READER is shown contact sheets and NOT the names. It says what is drawn.
//   2. the MATCHER is shown the names and the reader's words, and NEVER the pictures.
//
// A single agent given both would read the picture through the name and confirm whatever it was
// told — the same failure the lore critic avoids by never seeing the writer's reasoning. Splitting
// them costs one extra call and buys a verdict whose evidence can be traced.
//
// This stage is optional. The pipeline runs without art, and must: the sprite pack is licensed for
// use and not for redistribution, so a published copy of this project has no art in it and every
// other stage has to keep working.

const fs = require('fs');
const path = require('path');
const { contactSheet } = require('./sheet');

const SHEET_COLS = 5;
const SHEET_ROWS = 3;      // 15 per sheet. Enough context to compare cells, small enough to stay
                           // legible at 7x, and it bounds how much one bad call can poison.
const PER_SHEET = SHEET_COLS * SHEET_ROWS;

/**
 * Find the art directory. Explicit `--art` wins; otherwise look where the game keeps it. Returns
 * null rather than throwing — no art is a normal state, not an error.
 */
function findArtDir(explicit, root) {
  if (explicit === false) return null;
  const candidates = explicit ? [path.resolve(explicit)] : [
    path.join(root, '..', 'assets', 'asteroid and Space junks'),
    path.join(root, '..', 'assets', 'debris'),
    path.join(root, 'art'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      if (fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.png'))) return dir;
    }
  }
  if (explicit) throw new Error(`--art: no PNGs found in ${path.resolve(explicit)}`);
  return null;
}

/**
 * Resolve each catalogue piece to a sprite file.
 *
 * The mapping file says which numbered sprite belongs to which id. It is a hand-made record — the
 * thing this stage exists to audit — so a piece with no mapping or a missing file is reported
 * rather than skipped silently: an unmapped piece is exactly the kind of gap that hides.
 */
function resolveSprites(pieces, artDir, spriteMap) {
  const pattern = (spriteMap && spriteMap.filename_pattern) || null;
  const table = (spriteMap && spriteMap.catalogue) || {};
  const missing = [];
  const resolved = [];

  for (const p of pieces) {
    const n = table[p.id];
    let file = null;
    if (n !== undefined && pattern) {
      const candidate = path.join(artDir, pattern.replace('%d', String(n)));
      if (fs.existsSync(candidate)) file = candidate;
    }
    if (!file) {
      // Fall back to a file named for the id, which is how a pack organised by name would look.
      for (const ext of ['.png', '.PNG']) {
        const candidate = path.join(artDir, p.id + ext);
        if (fs.existsSync(candidate)) { file = candidate; break; }
      }
    }
    if (file) resolved.push({ ...p, spriteFile: file, spriteRef: n !== undefined ? String(n) : path.basename(file) });
    else missing.push(p.id);
  }
  return { resolved, missing };
}

/**
 * How the pieces divide into sheets. Pure — it depends only on the catalogue order, never on which
 * files exist. That is what lets a replay reproduce the same cell numbering on a machine with no
 * art on it at all, which is the normal case for a published copy of this project.
 */
function planSheets(pieces) {
  const sheets = [];
  for (let i = 0; i * PER_SHEET < pieces.length; i++) {
    const slice = pieces.slice(i * PER_SHEET, (i + 1) * PER_SHEET);
    sheets.push({
      id: `sheet${i + 1}`,
      cols: SHEET_COLS,
      rows: Math.ceil(slice.length / SHEET_COLS),
      // The agent is given cell numbers and nothing else. This mapping stays on our side of the
      // seam and is only used to attach the reply back to ids after the call returns.
      pieces: slice.map((p, n) => ({ cell: n + 1, id: p.id })),
    });
  }
  return sheets;
}

/** Render each planned sheet to a PNG. Live only — needs the art on disk. */
function renderSheets(sheets, byId, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  return sheets.map((sheet) => {
    const files = sheet.pieces.map(({ id }) => byId.get(id).spriteFile);
    const rendered = contactSheet(files, { cols: SHEET_COLS });
    const file = path.join(outDir, `${sheet.id}.png`);
    fs.writeFileSync(file, rendered.png);
    return { ...sheet, file, rows: rendered.rows };
  });
}

/** The prompt input for one rendered sheet — cell numbers and grid shape, never a name. */
function sheetInputs(sheet) {
  return {
    'THE CONTACT SHEET': [
      `Open this image with your Read tool before answering:`,
      ``,
      `  ${String(sheet.file).replace(/\\/g, '/')}`,
      ``,
      `It holds ${sheet.pieces.length} sprites in a ${sheet.cols}-wide grid, ${sheet.rows} row(s) deep.`,
      `Cells are numbered left to right, then top to bottom, starting at 1. Each cell has a white`,
      `corner mark at its top-left. Every cell in the grid holds a sprite.`,
      ``,
      `Sheet id: ${sheet.id}`,
    ].join('\n'),
  };
}

/** Attach a reading back to piece ids, and report cells the reader dropped or invented. */
function attachReading(sheet, reading) {
  const byCell = new Map((reading.cells || []).map((c) => [c.cell, c]));
  const rows = [];
  const gaps = [];
  for (const { cell, id } of sheet.pieces) {
    const c = byCell.get(cell);
    if (!c) { gaps.push(id); continue; }
    rows.push({
      id,
      sheet: sheet.id,
      cell,
      depicts: c.depicts,
      detail: c.detail,
      condition: c.condition,
      bulk: c.bulk,
      palette: c.palette,
      legible: c.legible,
    });
  }
  return { rows, gaps };
}

/** The matcher's view: the assignment and the blind reading, side by side. No image path. */
function matchInputs(pieces, readings) {
  const byId = new Map(readings.map((r) => [r.id, r]));
  const block = pieces
    .filter((p) => byId.has(p.id))
    .map((p) => {
      const r = byId.get(p.id);
      return [
        `${p.id}`,
        `   name shown to the player: ${p.display_name || '(none)'}`,
        `   mechanical fields: ${Math.round(p.mass_kg)} kg | ${p.altitude_m.toLocaleString()} m | ${p.size_class}${p.fragile ? ' | FRAGILE' : ''}`,
        `   blind reading of the sprite: ${r.depicts} (${r.legible})`,
        `      ${r.detail}`,
        `      condition: ${r.condition} | silhouette: ${r.bulk} | colours: ${(r.palette || []).join(', ')}`,
      ].join('\n');
    }).join('\n\n');
  return { 'PIECES TO JUDGE — the assignment, and what a blind reader saw': block };
}

module.exports = {
  findArtDir, resolveSprites, planSheets, renderSheets, sheetInputs, attachReading, matchInputs,
  PER_SHEET,
};
