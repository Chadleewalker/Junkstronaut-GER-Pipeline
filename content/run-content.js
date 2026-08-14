#!/usr/bin/env node
'use strict';
// The Junkstronaut content pipeline.
//
// Retrieval-grounded generation of the three pieces of written content the design document
// promises and the game does not have, with a critic that reads every line back against the
// passages it was written from.
//
//   GDD --> chunk --> index
//                       |
//        per-item query |--> retrieved passages --> writer --> deterministic checks
//                                      |                            |
//                                      +-------> lore critic <------+
//                                                     |
//                                          corrections applied, originals kept
//                                                     |
//                                        critic re-reads only what changed
//                                                     |
//                                    still failing? --+--> circuit breaker: needs_human.json
//
// Three writers, one critic charter run three times, and a re-check pass. The orchestrator
// contains no model: chunking, retrieval, scoring, the coverage and citation checks, and the
// decision to apply a correction are all deterministic. Agents write and agents judge;
// scaffolding decides what happens next. That is the same division the tuning crew runs on
// and it is the reason a recorded run replays byte-for-byte.
//
//   node run-content.js                run the real pipeline (needs Claude Code, signed in)
//   node run-content.js --stub         replay recorded output — no model calls, no credentials
//   node run-content.js --record       run for real, then save the logs as replay fixtures
//   node run-content.js --gdd <file>   point at a different design document
//   node run-content.js --catalog <f>  point at a different debris catalog
//   node run-content.js --out <dir>    write artifacts somewhere else
//   node run-content.js --reuse a,b    replay these agents, run the rest live

const fs = require('fs');
const path = require('path');

// Shared with the tuning crew on purpose. `agent.js` is the prompt-build / invoke / retry
// loop, `schema.js` is the validation gate that feeds its own errors back on a retry, and
// `envelope.js` digs the reply out of the CLI's noisy stdout. Re-writing any of the three
// here would be three more places for the same bug.
const { runAgent } = require('../crew/lib/agent');

const { chunkDocument } = require('./lib/chunk');
const { buildIndex } = require('./lib/retrieve');
const { plan, sourceBlock, itemBlock } = require('./lib/prompt');
const { renderReport } = require('./lib/render');
const { renderArtReview } = require('./lib/artsheet');
const {
  findArtDir, resolveSprites, planSheets, renderSheets, sheetInputs, attachReading, matchInputs,
} = require('./lib/art');
const {
  checkCitations, checkCoverage, checkReadsAs, checkExtremes, scoreRetrieval,
} = require('./lib/verify');
const { collectEscalations } = require('./lib/escalate');
const {
  VOICE_QUERY, CANON_BARKS, BARK_STATES, POSTMORTEM_STATES, debrisQuery, altitudeThird,
} = require('./lib/items');

const ROOT = __dirname;
const K = 3;         // passages retrieved per item
const VOICE_K = 2;   // passages retrieved for the one standing voice query

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = {
    mode: 'live', record: false, out: null, gdd: null, catalog: null, art: null, reuse: [],
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stub') args.mode = 'stub';
    else if (a === '--strict') args.strict = true;
    else if (a === '--record') args.record = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--gdd') args.gdd = argv[++i];
    else if (a === '--catalog') args.catalog = argv[++i];
    else if (a === '--art') args.art = argv[++i];
    else if (a === '--no-art') args.art = false;
    else if (a === '--reuse') args.reuse = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const USAGE = `
Junkstronaut content pipeline — retrieval-grounded writing, with a critic on the gate.

  node run-content.js               run the real pipeline (needs Claude Code, signed in)
  node run-content.js --stub        replay recorded output — no model calls, no credentials
  node run-content.js --record      run for real, then save the logs as replay fixtures
  node run-content.js --gdd <file>  point at a different design document
  node run-content.js --catalog <f> point at a different debris catalog
  node run-content.js --art <dir>   read the sprites in this folder and audit them against the
                                    catalogue's names (default: found beside the game's assets)
  node run-content.js --no-art      skip the art stage even if art is present
  node run-content.js --out <dir>   write artifacts somewhere else (default: content/out)
  node run-content.js --strict      exit 3 if the circuit breaker tripped, so a CI job or a
                                    build step cannot ship content nobody has looked at
  node run-content.js --reuse a,b   replay these agents from stubs, run the rest live
                                    (e.g. --reuse bark-writer, while iterating on the critic)

Environment:
  JUNK_MODEL             model alias for the agents (default: opus)
  JUNK_AGENT_CMD         replace the agent command entirely (the test seam)
  JUNK_AGENT_TIMEOUT_MS  per-agent timeout in ms (default: 1500000)
`.trim();

// ---------------------------------------------------------------- helpers

const t0 = Date.now();
function log(msg) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${msg}`);
}

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => JSON.parse(read(f));

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function findFile(explicit, candidates, what) {
  if (explicit) return path.resolve(explicit);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`could not find ${what}. Looked for:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

// The item-count bounds live in the schemas as placeholders and are tightened here from the
// real inputs. A hardcoded "25 pieces" is a lie the day somebody adds a piece to the catalog,
// and the failure would arrive as a schema rejection three retries deep rather than as
// something a reader could see.
function schemaFor(name, arrayProp, count) {
  const s = readJson(path.join(ROOT, 'schemas', `${name}.schema.json`));
  s.properties[arrayProp].minItems = count;
  s.properties[arrayProp].maxItems = count;
  return s;
}

// The `reads_as` vocabulary is the eight descriptive words in the schema file plus whatever
// the catalog calls its size classes. Hardcoding `small|medium|large` is what failed three
// pieces on the first live run for describing an `oversized` dish as large: the writing was
// right and the enum was out of date with the data it was supposed to describe.
function debrisSchema(count, catalog) {
  const s = schemaFor('debris-flavour', 'pieces', count);
  const words = s.properties.pieces.items.properties.reads_as.items;
  words.enum = [...words.enum, ...Object.keys(catalog.size_classes || {})];
  return s;
}

// ---------------------------------------------------------------- retrieval tweak
//
// The retrieval this pipeline started with, kept runnable so the improvement is a measurement
// rather than a claim. v1: whole sections as chunks, scored by raw term overlap. v2: sections
// split at sentence boundaries to ~1,100 characters, scored by BM25.
//
// Both are scored against the `expect` labels hand-written in lib/items.js — the section a
// human says answers each query, decided by reading the document and never by looking at what
// either retriever returned.
function retrievalTweak(gddText, allItems) {
  const v1 = buildIndex(chunkDocument(gddText, { maxChars: Number.MAX_SAFE_INTEGER }), 'overlap');
  const v2 = buildIndex(chunkDocument(gddText), 'bm25');

  const measure = (index, label) => {
    const p = plan(index, allItems, { k: K });
    const score = scoreRetrieval(p.perItem);
    const chars = p.perItem.reduce((a, e) => a + e.hits.reduce((b, h) => b + h.chars, 0), 0);
    // §3 and §4 are the document talking about how the game gets BUILT — agent architecture,
    // token budgets, risk registers. They are never the answer to "what does the player see
    // when the chute shreds", so a §3 passage WINNING a player-facing query is the retriever
    // losing the plot outright. Counted at rank 1 as well as across the top three, because the
    // two say different things: §3's QA invariant list does restate real rules, so appearing
    // third is defensible, and appearing first is not.
    const isMeta = (h) => h.section.startsWith('3') || h.section.startsWith('4');
    const metaTop = p.perItem.filter((e) => e.hits[0] && isMeta(e.hits[0])).length;
    const meta = p.perItem.reduce((a, e) => a + e.hits.filter(isMeta).length, 0);
    return {
      label,
      chunks: index.N,
      mean_chunk_chars: Math.round(index.chunks.reduce((a, c) => a + c.chars, 0) / index.N),
      precision_at_1: score.precision_at_1,
      recall_at_3: score.recall_at_k,
      mean_retrieved_chars_per_query: Math.round(chars / p.perItem.length),
      meta_section_wins_rank_1: metaTop,
      meta_section_hits_in_top3: meta,
      misses: score.misses,
      per_item: p.perItem.map((e) => ({ id: e.id, hits: e.hits.map((h) => `${h.id} (${h.score})`) })),
    };
  };

  return {
    before: measure(v1, 'v1 — whole sections, raw term overlap'),
    after: measure(v2, 'v2 — sentence-bounded sub-chunks, BM25'),
  };
}

// ---------------------------------------------------------------- correction

// Apply the critic's corrections and keep everything about the originals.
//
// The rejected draft is the evidence, so it is never overwritten in place: `items` comes back
// corrected, `corrections` carries before, the critic's reasoning, and after. Deterministic —
// the critic decides what is wrong and writes the fix, the orchestrator decides that a
// non-passing verdict with a `corrected` block is what gets applied, and neither does the
// other's job.
function applyCorrections(items, critique, textFields) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const corrections = [];
  const unresolved = [];

  for (const r of critique.reviews || []) {
    const item = byId.get(r.id);
    if (!item) continue;
    if (r.verdict === 'pass') continue;

    // Only the text fields this content type owns, and only strings. A critic that also
    // rewrites `grounded_in` or `reads_as` is editing the writer's record of what it was
    // shown, which is not a correction — it is the evidence being tidied. Those keys are
    // dropped here rather than rejected by the schema, and that choice is deliberate: the
    // first live run DID reject one for exactly that, and the retry came back having
    // re-derived its judgement and quietly dropped three of its four findings. A schema gate
    // that bounces a valid finding on a formatting technicality does not cost you the
    // formatting, it costs you the finding.
    const patch = r.corrected || {};
    const changed = Object.keys(patch).filter((f) =>
      textFields.includes(f) && typeof patch[f] === 'string' && patch[f] !== item[f]);
    if (!changed.length) {
      // A non-passing verdict with nothing to apply is a finding about the critic, not about
      // the content, and it has to be visible rather than silently treated as a pass.
      unresolved.push({ id: r.id, verdict: r.verdict, issues: r.issues || [] });
      continue;
    }

    const before = {};
    for (const f of changed) before[f] = item[f];
    corrections.push({
      id: r.id,
      verdict: r.verdict,
      issues: r.issues || [],
      before,
      after: Object.fromEntries(changed.map((f) => [f, patch[f]])),
    });
    for (const f of changed) item[f] = patch[f];
  }

  return { corrections, unresolved };
}

// ---------------------------------------------------------------- the pipeline

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'out');
  const logDir = path.join(outDir, 'logs');
  const stubDir = path.join(ROOT, 'stubs');
  fs.mkdirSync(logDir, { recursive: true });

  // These agents write text and return JSON. They call no tools, so they do not need the
  // crew's `--dangerously-skip-permissions`, and a default that does not ask for powers it
  // will not use is the better default. JUNK_AGENT_CMD still overrides everything.
  const model = process.env.JUNK_MODEL || 'opus';
  if (!process.env.JUNK_AGENT_CMD) {
    process.env.JUNK_AGENT_CMD = `claude -p --output-format json --model ${model}`;
  }

  const gddPath = findFile(args.gdd, [
    path.join(ROOT, '..', 'Junkstronaut GDD Short.txt'),
    path.join(ROOT, 'Junkstronaut GDD Short.txt'),
  ], 'the design document');
  const gddText = read(gddPath);

  // The catalog belongs to the tuning crew and a live crew run rewrites it mid-flight, so a
  // replay reads the snapshot taken when the fixtures were recorded. Without that, `--stub`
  // is only reproducible until somebody upstream runs `node run-crew.js` — the recorded
  // flavour would be describing pieces that no longer have those masses.
  const snapshot = path.join(ROOT, 'data', 'debris_catalog.snapshot.json');
  const catalogPath = args.catalog
    ? path.resolve(args.catalog)
    : (args.mode === 'stub' && fs.existsSync(snapshot))
      ? snapshot
      : findFile(null, [
        // The tuning-crew repo writes it here; the game repo carries it as shipped config.
        // Listing both is what lets the same pipeline run unmodified in either tree.
        path.join(ROOT, '..', 'crew', 'out', 'data', 'debris_catalog.json'),
        path.join(ROOT, '..', 'config', 'debris_catalog.json'),
        snapshot,
      ], 'the debris catalog');
  const catalog = readJson(catalogPath);
  const pieces = catalog.debris;
  const band = {
    min: Math.min(...pieces.map((p) => p.altitude_m)),
    max: Math.max(...pieces.map((p) => p.altitude_m)),
  };

  // Which sprite belongs to which piece. Metadata, not art — it ships everywhere the catalog
  // does, and the art stage exists precisely because nothing has ever checked it.
  const spriteMapPath = [
    path.join(ROOT, '..', 'config', 'debris_sprites.json'),
    path.join(ROOT, 'data', 'debris_sprites.json'),
  ].find((p) => fs.existsSync(p));
  const spriteMap = spriteMapPath ? readJson(spriteMapPath) : null;

  log(`Junkstronaut content pipeline — ${args.mode === 'stub' ? 'REPLAY (no model calls)' : 'live'}`);
  log(`design document: ${path.basename(gddPath)} (${gddText.length.toLocaleString()} chars)`);
  log(`debris catalog:  ${path.relative(ROOT, catalogPath)} (${pieces.length} pieces)`);
  console.log('');

  // -- 1. chunk and index ---------------------------------------------------
  log('1/7  Chunking the design document and building the index');
  const chunks = chunkDocument(gddText);
  const index = buildIndex(chunks, 'bm25');
  const sections = [...new Set(chunks.map((c) => c.section))];
  log(`     ${chunks.length} chunks across ${sections.length} sections, ` +
      `mean ${Math.round(chunks.reduce((a, c) => a + c.chars, 0) / chunks.length)} chars`);

  // -- 2. retrieve ----------------------------------------------------------
  log('2/7  Retrieving per item — one query per game state, logged with its scores');

  const debrisItems = pieces.map((p) => ({
    id: p.id,
    expect: ['2.6'],
    query: debrisQuery(p, band),
  }));

  const plans = {
    barks: plan(index, BARK_STATES, { k: K, voiceQuery: VOICE_QUERY, voiceK: VOICE_K }),
    debris: plan(index, debrisItems, { k: K, voiceQuery: VOICE_QUERY, voiceK: VOICE_K }),
    postmortems: plan(index, POSTMORTEM_STATES, { k: K, voiceQuery: VOICE_QUERY, voiceK: VOICE_K }),
  };
  // Two shares, and both are reported because they answer different questions. The per-item
  // figure is what "grounded in retrieved passages" means: it is how much of the document any
  // one line was written from. The pooled figure is how much of the document is in the prompt
  // once, because the passages are printed once and cited by id — and with eighteen bark
  // states spanning §1 to §2.7, that union is large no matter how precise each query is.
  // Reporting only the first would be flattering; reporting only the second would be wrong.
  const perItemChars = (p) =>
    p.perItem.reduce((a, e) => a + e.hits.reduce((b, h) => b + h.chars, 0), 0) / p.perItem.length;

  for (const [name, p] of Object.entries(plans)) {
    const per = perItemChars(p);
    log(`     ${name.padEnd(12)} ${p.perItem.length} queries x ${K} passages — ` +
        `${Math.round(per).toLocaleString()} chars per item (${((per / gddText.length) * 100).toFixed(1)}% of the document), ` +
        `${p.pool.length} distinct passages pooled into the prompt ` +
        `(${((p.chars / gddText.length) * 100).toFixed(0)}%)`);
  }

  const labelled = [...BARK_STATES, ...POSTMORTEM_STATES];
  const accuracy = scoreRetrieval(plan(index, labelled, { k: K }).perItem);
  log(`     retrieval accuracy on ${accuracy.labelled} hand-labelled states: ` +
      `P@1 ${(accuracy.precision_at_1 * 100).toFixed(0)}%, recall@${K} ${(accuracy.recall_at_k * 100).toFixed(0)}%`);

  const tweak = retrievalTweak(gddText, labelled);
  log(`     retrieval tweak: P@1 ${(tweak.before.precision_at_1 * 100).toFixed(0)}% -> ` +
      `${(tweak.after.precision_at_1 * 100).toFixed(0)}%, ` +
      `${tweak.before.mean_retrieved_chars_per_query.toLocaleString()} -> ` +
      `${tweak.after.mean_retrieved_chars_per_query.toLocaleString()} chars per query`);
  console.log('');

  // -- the agent seam -------------------------------------------------------
  const models = new Set();
  const charter = (name) => read(path.join(ROOT, 'agents', `${name}.md`));

  const call = (name, inputs, schema, label) => {
    const r = runAgent({
      name: label || name,
      charter: charter(name),
      inputs,
      schema,
      logDir,
      mode: args.reuse.includes(label || name) ? 'stub' : args.mode,
      stubDir,
      log,
    });
    if (r.model) models.add(r.model);
    return r;
  };

  // -- 3. read the art ------------------------------------------------------
  // Optional, and it has to be. The sprite pack is licensed for use and not for redistribution, so
  // a published copy of this project has no art in it — but the readings and the verdicts are text
  // and they ship. In a replay those come back out of the recorded envelopes, which is why the
  // sheet plan is computed from the catalogue rather than from whatever files happen to be present.
  const artSheets = planSheets(pieces);
  let artReadings = [];
  let artVerdicts = [];
  let artRendered = null;
  const artDir = findArtDir(args.art, ROOT);
  // In a replay the art is optional but the recording is not: a published copy has the readings in
  // stubs/ and no pixels, so the stage runs from those. A tree with neither just skips.
  const hasArtStubs = fs.existsSync(path.join(stubDir, 'art-reader.sheet1.attempt1.log'));
  const runArt = args.art !== false && (artDir || (args.mode === 'stub' && hasArtStubs));

  if (runArt) {
    log('3/7  Reading the art — described blind, then matched against the names');
    if (artDir) {
      const { resolved, missing } = resolveSprites(pieces, artDir, spriteMap);
      if (missing.length) {
        // An unmapped piece would silently shift every later cell number, so this is fatal rather
        // than a warning. The whole point of the stage is that the mapping gets audited.
        throw new Error(
          `art: ${missing.length} catalogue piece(s) have no sprite in ${artDir} — ${missing.join(', ')}.\n` +
          `  Fix the mapping in the sprite map, or run with --no-art.`);
      }
      const byId = new Map(resolved.map((p) => [p.id, p]));
      artRendered = renderSheets(artSheets, byId, path.join(outDir, 'art', 'sheets'));
      log(`     ${resolved.length} sprites from ${path.basename(artDir)} across ` +
          `${artRendered.length} contact sheet(s) at 7x`);
    } else {
      log('     no art on disk — replaying the recorded readings, sheets not rendered');
    }

    const readingSchema = readJson(path.join(ROOT, 'schemas', 'art-reading.schema.json'));
    const gaps = [];
    for (let i = 0; i < artSheets.length; i++) {
      const sheet = artRendered ? artRendered[i] : artSheets[i];
      const run = call('art-reader', sheetInputs(sheet), readingSchema, `art-reader.${sheet.id}`);
      if (run.object.unreadable) throw new Error(`art-reader could not open ${sheet.id}`);
      const { rows, gaps: g } = attachReading(artSheets[i], run.object);
      artReadings.push(...rows);
      gaps.push(...g);
    }
    if (gaps.length) log(`     ${gaps.length} cell(s) came back unread: ${gaps.join(', ')}`);
    const clear = artReadings.filter((r) => r.legible === 'clear').length;
    log(`     art-reader         ${artReadings.length} sprites described, ${clear} read clearly`);

    const matchSchema = readJson(path.join(ROOT, 'schemas', 'art-match.schema.json'));
    const matchRun = call('art-matcher', matchInputs(pieces, artReadings), matchSchema, 'art-matcher');
    artVerdicts = matchRun.object.verdicts;
    const tally = artVerdicts.reduce((a, v) => { a[v.verdict] = (a[v.verdict] || 0) + 1; return a; }, {});
    log(`     art-matcher        ${tally.match || 0} match, ${tally.loose || 0} loose, ` +
        `${tally.mismatch || 0} disagree`);
    console.log('');
  } else {
    log('3/7  Reading the art — skipped, no art present (point at a folder with --art <dir>)');
    console.log('');
  }

  // -- 4. generate ----------------------------------------------------------
  log('4/7  Writing — each agent sees the retrieved passages and nothing else about the game');

  const canonBlock = CANON_BARKS
    .map((c) => `- ${c.source} — "${c.line}"\n  fires: ${c.state}`).join('\n');

  const barkRun = call('bark-writer', {
    'SOURCE PASSAGES FROM THE DESIGN DOCUMENT': sourceBlock(plans.barks.pool),
    'CANON LINES — already in the document, do not rewrite them': canonBlock,
    'STATES TO WRITE': itemBlock(plans.barks.perItem, (id) => {
      const s = BARK_STATES.find((x) => x.id === id);
      return `${s.id}\n   state: ${s.state}\n   fires when: ${s.trigger}\n   this line's job: ${s.job}`;
    }),
  }, schemaFor('barks', 'barks', BARK_STATES.length), 'bark-writer');
  const barks = barkRun.object.barks;
  log(`     bark-writer        ${barks.length} lines, ` +
      `mean ${Math.round(barks.reduce((a, b) => a + b.line.length, 0) / barks.length)} chars`);

  const mechanicalBlock = pieces.map((p) =>
    `${p.id}\n   ${Math.round(p.mass_kg)} kg | ${p.altitude_m.toLocaleString()} m (${altitudeThird(p.altitude_m, band)}) | ` +
    `${p.size_class}${p.fragile ? ' | FRAGILE' : ''}`).join('\n');

  // What is actually drawn, where the art stage ran. Until this existed the writer was handed an
  // id and nothing else, so it described the NAME — which is why a sprite of a dented steel plate
  // shipped with a sentence about foil that tears. The id is a label somebody typed; the reading
  // is evidence about the picture the player will see, and it wins.
  const readingById = new Map(artReadings.map((r) => [r.id, r]));
  const verdictById = new Map(artVerdicts.map((v) => [v.id, v]));
  const artInputs = {};

  // The writer gets the pictures themselves, not just a description of them. It used to work from
  // the reader's paraphrase, which is a game of telephone: the reader saw "a chipped notch out of
  // the upper right edge and a fracture across the face" and the writer, one hop downstream, wrote
  // "cracked end to end". The detail that makes a piece recognisable on screen is exactly what a
  // paraphrase drops, so the agent writing the words a player reads while looking at the sprite is
  // now the agent looking at the sprite.
  //
  // The reader and the matcher stay blind. They are the audit, and an audit whose judge can see
  // both halves is not an audit — see lib/art.js. This is the one agent allowed both.
  if (artRendered) {
    artInputs['THE ART — open every sheet before you write'] = [
      ...artRendered.map((s) => `${s.id}: ${String(s.file).replace(/\\/g, '/')}` +
        `\n   ${s.cols} wide, ${s.rows} row(s), cells numbered left to right then top to bottom` +
        `\n   ${s.pieces.map((c) => `${c.cell}=${c.id}`).join('  ')}`),
    ].join('\n\n');
  }

  if (readingById.size) {
    artInputs['WHAT A BLIND READER SAW IN EACH SPRITE — a second opinion, not a substitute for looking'] = pieces
      .filter((p) => readingById.has(p.id))
      .map((p) => {
        const r = readingById.get(p.id);
        const v = verdictById.get(p.id);
        const flag = v && v.verdict !== 'match'
          ? `\n   NOTE: the id and the drawing disagree (${v.verdict}). ${v.why} ` +
            `Describe what is drawn, not what the id claims.`
          : '';
        return `${p.id}\n   drawn: ${r.depicts} (${r.legible})\n   ${r.detail}\n` +
               `   condition: ${r.condition} | silhouette: ${r.bulk} | colours: ${(r.palette || []).join(', ')}${flag}`;
      }).join('\n\n');
  }

  const debrisRun = call('debris-flavourist', {
    'SOURCE PASSAGES FROM THE DESIGN DOCUMENT': sourceBlock(plans.debris.pool),
    "THE LOOT TABLE'S MECHANICAL FIELDS — decided, and not yours to change": mechanicalBlock,
    ...artInputs,
    'PIECES TO WRITE': itemBlock(plans.debris.perItem, (id) => id),
  }, debrisSchema(pieces.length, catalog), 'debris-flavourist');
  const flavour = debrisRun.object.pieces;
  log(`     debris-flavourist  ${flavour.length} pieces named and described`);

  const pmRun = call('postmortem-writer', {
    'SOURCE PASSAGES FROM THE DESIGN DOCUMENT': sourceBlock(plans.postmortems.pool),
    'CANON LINES — already in the document, do not rewrite them': canonBlock,
    'STATES TO WRITE': itemBlock(plans.postmortems.perItem, (id) => {
      const s = POSTMORTEM_STATES.find((x) => x.id === id);
      return `${s.id}\n   terminal state: ${s.state}\n   detector: ${s.detector}`;
    }),
  }, schemaFor('postmortems', 'screens', POSTMORTEM_STATES.length), 'postmortem-writer');
  const screens = pmRun.object.screens;
  log(`     postmortem-writer  ${screens.length} screens`);
  console.log('');

  // -- 4. check, deterministically then with the critic ----------------------
  log('5/7  Checking — code first, then the critic reads every line against its sources');

  const poolIds = (p) => new Set(p.pool.map((c) => c.id));
  const checks = {
    barks: [
      ...checkCoverage(barks, BARK_STATES.map((s) => s.id), 'barks'),
      ...checkCitations(barks, plans.barks.perItem, poolIds(plans.barks)),
    ],
    debris: [
      ...checkCoverage(flavour, pieces.map((p) => p.id), 'debris'),
      ...checkCitations(flavour, plans.debris.perItem, poolIds(plans.debris)),
      ...checkReadsAs(flavour, new Map(pieces.map((p) => [p.id, p])), band, artVerdicts),
      ...checkExtremes(flavour, pieces, band),
    ],
    postmortems: [
      ...checkCoverage(screens, POSTMORTEM_STATES.map((s) => s.id), 'postmortems'),
      ...checkCitations(screens, plans.postmortems.perItem, poolIds(plans.postmortems)),
    ],
  };
  for (const [name, list] of Object.entries(checks)) {
    const failed = list.filter((c) => c.result === 'fail');
    log(`     ${name.padEnd(12)} ${list.length - failed.length}/${list.length} deterministic checks passed`);
    for (const f of failed) log(`       FAIL ${f.check} ${f.id} — ${f.detail}`);
  }

  // The critic never sees `why`. That field is the writer's justification for its own line,
  // and a critic reading it is a critic being argued with — the same reason the tuning crew's
  // Spec Auditor is given the design document instead of the other agents' reasoning.
  const strip = (list, drop) => list.map((o) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k))));

  const critique = (type, planEntry, generated, spec, extra = {}) => call('lore-critic', {
    'SOURCE PASSAGES FROM THE DESIGN DOCUMENT': sourceBlock(planEntry.pool),
    'CANON LINES — already in the document': canonBlock,
    'WHAT EACH ITEM WAS ASKED FOR': spec,
    ...extra,
    'THE GENERATED CONTENT UNDER REVIEW': JSON.stringify(generated, null, 2),
  }, readJson(path.join(ROOT, 'schemas', 'critique.schema.json')), `lore-critic.${type}`);

  const barkSpec = itemBlock(plans.barks.perItem, (id) => {
    const s = BARK_STATES.find((x) => x.id === id);
    return `${s.id}\n   state: ${s.state}\n   this line's job: ${s.job}`;
  });
  const pmSpec = itemBlock(plans.postmortems.perItem, (id) => {
    const s = POSTMORTEM_STATES.find((x) => x.id === id);
    return `${s.id}\n   terminal state: ${s.state}\n   detector: ${s.detector}`;
  });
  const debrisSpec = itemBlock(plans.debris.perItem, (id) => id);

  // Per-type inputs, defined once and used by both the first critique and the re-check.
  // Keeping them in one place is not tidiness: the re-check used to be built inline without
  // them, so the debris re-check judged flavour text with no loot table in front of it and
  // failed three pieces for stating masses the table it was not shown states exactly.
  //
  // The art block is here for a harder reason. The first run after the writer was given the
  // sprites, the critic — which has the ids and the table but no pictures — "corrected" a
  // description of a cracked grey PLATE back into a crumpled foil SHEET, reasoning from the id
  // `torn_foil_blanket`. The audit had already established that id is wrong. So the pipeline
  // found the error and then enforced it one stage later, which is worse than never having
  // looked: it launders a known-bad label into a reviewed, corrected line.
  //
  // Adding a source for the writer and not for its judge is what caused that. The critic gets
  // the same findings now — as text, never the images, so it stays a reader of records rather
  // than a second opinion about what is drawn.
  const artForCritic = artReadings.length ? pieces
    .filter((p) => readingById.has(p.id))
    .map((p) => {
      const r = readingById.get(p.id);
      const v = verdictById.get(p.id);
      return `${p.id}\n   the sprite shows: ${r.depicts} (${r.legible}) — ${r.detail}` +
        (v ? `\n   audit: ${v.verdict}${v.verdict === 'match' ? '' : ` — ${v.why}`}` : '');
    }).join('\n\n') : null;

  const extras = {
    barks: {},
    debris: {
      "THE LOOT TABLE'S MECHANICAL FIELDS — the fiction must match these": mechanicalBlock,
      ...(artForCritic ? {
        'WHAT THE SPRITES SHOW — where a name and its picture disagree, the picture is the game':
          artForCritic,
      } : {}),
    },
    postmortems: {},
  };
  const itemSpecs = { barks: barkSpec, debris: debrisSpec, postmortems: pmSpec };

  const critiques = {
    barks: critique('barks', plans.barks, strip(barks, ['why']), itemSpecs.barks, extras.barks).object,
    debris: critique('debris', plans.debris, flavour, itemSpecs.debris, extras.debris).object,
    postmortems: critique('postmortems', plans.postmortems, screens, itemSpecs.postmortems, extras.postmortems).object,
  };

  const TEXT_FIELDS = {
    barks: ['line'],
    debris: ['display_name', 'flavour'],
    postmortems: ['title', 'cause', 'rule_broken', 'armstrong'],
  };
  const generated = { barks, debris: flavour, postmortems: screens };

  const applied = {};
  for (const type of Object.keys(critiques)) {
    const c = critiques[type];
    const counts = (c.reviews || []).reduce((a, r) => {
      a[r.verdict] = (a[r.verdict] || 0) + 1;
      return a;
    }, {});
    applied[type] = applyCorrections(generated[type], c, TEXT_FIELDS[type]);
    log(`     ${type.padEnd(12)} critic ${c.verdict.toUpperCase()} — ` +
        `${counts.pass || 0} pass, ${counts.revise || 0} revise, ${counts.reject || 0} reject; ` +
        `${applied[type].corrections.length} correction(s) applied`);
    for (const u of applied[type].unresolved) {
      log(`       ${u.id}: verdict ${u.verdict} with no usable correction — left as written`);
    }
  }

  // -- the re-check. Only what changed, and only if something did. -----------
  //
  // A correction nobody re-read is a correction on trust. This pass hands the critic the
  // corrected items and the same passages, with no memory that it wrote them — the fixtures
  // are separate logs, and a fresh agent call has no history — so a verdict of pass here is
  // the correction holding rather than the critic agreeing with itself.
  const recheck = {};
  for (const type of Object.keys(critiques)) {
    const ids = applied[type].corrections.map((c) => c.id);
    if (!ids.length) continue;
    const subset = generated[type].filter((i) => ids.includes(i.id));
    const planSubset = {
      pool: plans[type].pool,
      perItem: plans[type].perItem.filter((p) => ids.includes(p.id)),
    };
    const spec = itemBlock(planSubset.perItem, (id) => id);
    const r = critique(`${type}.rev1`, planSubset, strip(subset, ['why']), spec, extras[type]).object;
    recheck[type] = r;
    const stillBad = (r.reviews || []).filter((x) => x.verdict !== 'pass');
    log(`     ${type.padEnd(12)} re-check of ${ids.length} corrected item(s): ` +
        `${r.verdict.toUpperCase()}${stillBad.length ? ` — ${stillBad.map((x) => x.id).join(', ')} still flagged` : ''}`);
  }
  console.log('');

  // -- 4b. the circuit breaker ----------------------------------------------
  //
  // One refine pass has now happened. Everything the loop could settle is settled; what is
  // left is what it could not, and the decision here is to STOP rather than to loop again.
  // See lib/escalate.js for why a second pass would be the wrong answer to every one of the
  // three reasons an item reaches this point.
  //
  // The breaker never edits content. It collects, it names, and it hands over — the generated
  // files are still written, because a human reviewing a flagged line needs to see the line.
  log('6/7  Circuit breaker');
  const escalations = collectEscalations({ checks, applied, recheck, artVerdicts });
  if (escalations.tripped) {
    log(`     TRIPPED — ${escalations.total} finding(s) across ${escalations.distinct_items} item(s), ` +
        `not retried: ${Object.entries(escalations.by_kind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    for (const e of escalations.items.slice(0, 8)) {
      log(`       ${e.kind.padEnd(20)} ${e.id} — ${e.detail}`);
    }
    if (escalations.items.length > 8) log(`       ... and ${escalations.items.length - 8} more, all in needs_human.json`);
  } else {
    log('     clear — every item passed its checks and its re-read');
  }
  console.log('');

  // -- 5. artifacts ---------------------------------------------------------
  log('7/7  Writing artifacts');

  const stamp = new Date().toISOString();
  const provenance = {
    generated_at: stamp,
    design_document: path.basename(gddPath),
    pipeline: 'content/run-content.js',
    note: 'Generated from passages retrieved from the design document, then checked against ' +
      'those same passages by the lore critic. Corrections and the drafts they replaced are ' +
      'in critique/critique_log.json.',
  };

  // The barks file ships the three canon lines alongside the generated ones, flagged by
  // `source`. The game needs one bark table, not two — and a reader needs to see at a glance
  // which lines came out of the document and which came out of this pipeline.
  const barkFile = {
    ...provenance,
    barks: [
      ...CANON_BARKS.map((c) => ({
        id: c.id, source: 'gdd', gdd_ref: c.source, state: c.state, trigger: null, line: c.line,
      })),
      ...barks.map((b) => {
        const s = BARK_STATES.find((x) => x.id === b.id);
        return {
          id: b.id, source: 'generated', gdd_ref: (b.grounded_in || []).map((g) => `§${g}`).join(', '),
          state: s.state, trigger: s.trigger, line: b.line,
        };
      }),
    ],
  };

  const flavourFile = {
    ...provenance,
    debris_catalog: path.relative(path.join(ROOT, '..'), catalogPath).replace(/\\/g, '/'),
    pieces: Object.fromEntries(flavour.map((p) => [p.id, {
      display_name: p.display_name,
      flavour: p.flavour,
      reads_as: p.reads_as,
      gdd_ref: (p.grounded_in || []).map((g) => `§${g}`).join(', '),
    }])),
  };

  const screenFile = {
    ...provenance,
    screens: Object.fromEntries(screens.map((s) => {
      const spec = POSTMORTEM_STATES.find((x) => x.id === s.id);
      return [s.id, {
        terminal_state: spec.state,
        detector: spec.detector,
        title: s.title,
        cause: s.cause,
        rule_broken: s.rule_broken,
        armstrong: s.armstrong,
        gdd_ref: (s.grounded_in || []).map((g) => `§${g}`).join(', '),
      }];
    })),
  };

  const contentDir = path.join(outDir, 'content');
  writeJson(path.join(contentDir, 'armstrong_barks.json'), barkFile);
  writeJson(path.join(contentDir, 'debris_flavour.json'), flavourFile);
  writeJson(path.join(contentDir, 'postmortem_screens.json'), screenFile);
  fs.writeFileSync(path.join(contentDir, 'content.gd'), emitLoader());

  writeJson(path.join(outDir, 'retrieval', 'retrieval_log.json'), {
    ...provenance,
    scoring: 'BM25 (k1=1.2, b=0.75) over sentence-bounded section chunks',
    index: {
      chunks: chunks.length,
      sections,
      mean_chunk_chars: Math.round(chunks.reduce((a, c) => a + c.chars, 0) / chunks.length),
    },
    accuracy,
    queries: Object.fromEntries(Object.entries(plans).map(([type, p]) => [type, {
      pool_chunks: p.pool.length,
      pool_chars: p.chars,
      share_of_document: Number((p.chars / gddText.length).toFixed(4)),
      voice_query: p.voice ? { query: p.voice.query, hits: p.voice.hits.map(trim) } : null,
      per_item: p.perItem.map((e) => ({ id: e.id, query: e.query, terms: e.terms, hits: e.hits.map(trim) })),
    }])),
  });
  writeJson(path.join(outDir, 'retrieval', 'tweak_comparison.json'), tweak);

  writeJson(path.join(outDir, 'critique', 'critique_log.json'), {
    ...provenance,
    method: 'The critic is given the generated items and the same retrieved passages the ' +
      'writer was given, and never the writer\'s reasoning. Corrections are applied by the ' +
      'orchestrator; the drafts they replaced are kept here as `before`.',
    by_type: Object.fromEntries(Object.keys(critiques).map((type) => [type, {
      verdict: critiques[type].verdict,
      summary: critiques[type].summary,
      reviews: critiques[type].reviews,
      corrections: applied[type].corrections,
      unresolved: applied[type].unresolved,
      recheck: recheck[type] || null,
    }])),
  });

  writeJson(path.join(outDir, 'checks', 'deterministic_checks.json'), { ...provenance, checks });

  // The art stage's findings are text, and text ships. The page that shows the sprites does not —
  // see lib/artsheet.js. Splitting them this way is what lets a published copy of this project
  // carry the audit without carrying the pack.
  if (artReadings.length) {
    writeJson(path.join(outDir, 'art', 'art_reading.json'), {
      ...provenance,
      note: 'What each sprite shows, described by an agent that was shown the picture and NOT the '
          + "piece's name. Blind on purpose: a reader told the name confirms the name.",
      art_directory: artDir ? path.relative(path.join(ROOT, '..'), artDir).replace(/\\/g, '/') : null,
      sprite_map: spriteMapPath ? path.relative(path.join(ROOT, '..'), spriteMapPath).replace(/\\/g, '/') : null,
      sheets: artSheets.map((s) => ({ id: s.id, cells: s.pieces.length, cols: s.cols })),
      readings: artReadings,
    });

    const tally = artVerdicts.reduce((a, v) => { a[v.verdict] = (a[v.verdict] || 0) + 1; return a; }, {});
    writeJson(path.join(outDir, 'art', 'art_match.json'), {
      ...provenance,
      note: 'Whether each piece\'s name and its picture describe the same object. The judge was '
          + 'given the name and the blind reading, and never the image — so its evidence is '
          + "quotable and its verdict cannot be a second opinion about what's drawn.",
      totals: {
        judged: artVerdicts.length,
        match: tally.match || 0,
        loose: tally.loose || 0,
        mismatch: tally.mismatch || 0,
      },
      verdicts: artVerdicts,
    });
  }

  const totals = {
    items: barks.length + flavour.length + screens.length,
    corrections: Object.values(applied).reduce((a, x) => a + x.corrections.length, 0),
    issues: Object.values(critiques).reduce(
      (a, c) => a + (c.reviews || []).reduce((b, r) => b + (r.issues || []).length, 0), 0),
    checks_run: Object.values(checks).reduce((a, l) => a + l.length, 0),
    checks_failed: Object.values(checks).reduce((a, l) => a + l.filter((c) => c.result === 'fail').length, 0),
    escalated: escalations.total,
    escalated_items: escalations.distinct_items,
  };

  const manifest = {
    pipeline: 'junkstronaut-content-pipeline',
    mode: args.mode,
    finished_at: stamp,
    duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    design_document: path.basename(gddPath),
    debris_catalog: path.relative(path.join(ROOT, '..'), catalogPath).replace(/\\/g, '/'),
    models: [...models],
    index: { chunks: chunks.length, sections: sections.length },
    retrieval: {
      k: K,
      precision_at_1: accuracy.precision_at_1,
      recall_at_k: accuracy.recall_at_k,
      labelled_states: accuracy.labelled,
      mean_chars_per_item: Math.round(
        Object.values(plans).reduce((a, p) => a + perItemChars(p), 0) / Object.keys(plans).length),
      share_of_document_per_item: Number(
        (Math.max(...Object.values(plans).map(perItemChars)) / gddText.length).toFixed(4)),
      share_of_document_pooled_max: Number(
        (Math.max(...Object.values(plans).map((p) => p.chars)) / gddText.length).toFixed(4)),
    },
    totals,
    agents: [
      { name: 'bark-writer', attempts: barkRun.attempts, produced: barks.length },
      { name: 'debris-flavourist', attempts: debrisRun.attempts, produced: flavour.length },
      { name: 'postmortem-writer', attempts: pmRun.attempts, produced: screens.length },
      ...Object.keys(critiques).map((t) => ({
        name: `lore-critic.${t}`,
        verdict: critiques[t].verdict,
        flagged: (critiques[t].reviews || []).filter((r) => r.verdict !== 'pass').length,
        rechecked: recheck[t] ? recheck[t].verdict : null,
      })),
    ],
    artifacts: [
      'content/armstrong_barks.json',
      'content/debris_flavour.json',
      'content/postmortem_screens.json',
      'content/content.gd',
      'retrieval/retrieval_log.json',
      'retrieval/tweak_comparison.json',
      'critique/critique_log.json',
      'checks/deterministic_checks.json',
      'checks/needs_human.json',
      'report/content.html',
    ],
  };
  writeJson(path.join(outDir, 'run.json'), manifest);

  // The breaker's own artifact. Written on every run, including a clean one — a file that
  // only appears when something is wrong is a file nobody learns to look for, and "tripped:
  // false" is a result rather than an absence.
  writeJson(path.join(outDir, 'checks', 'needs_human.json'), {
    ...provenance,
    method: 'The refine loop is one pass: write, judge, correct, re-judge. Anything still ' +
      'failing after that is escalated rather than retried — see content/lib/escalate.js for ' +
      'why a second pass would be the wrong answer. Nothing in this file changed any output; ' +
      'the generated content ships as written so a human can read the flagged line in place.',
    tripped: escalations.tripped,
    total: escalations.total,
    distinct_items: escalations.distinct_items,
    by_kind: escalations.by_kind,
    items: escalations.items,
  });

  fs.mkdirSync(path.join(outDir, 'report'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report', 'content.html'), renderReport({
    manifest, plans, generated, critiques, applied, recheck, checks, tweak, accuracy,
    canon: CANON_BARKS, specs: { barks: BARK_STATES, postmortems: POSTMORTEM_STATES }, pieces, band,
  }));

  // The art review page, only where the art is. It embeds the sprites, so it is the one artifact
  // this pipeline produces that cannot be published — the JSON above carries the same findings.
  if (artReadings.length && artVerdicts.length) {
    const byId = artDir
      ? new Map(resolveSprites(pieces, artDir, spriteMap).resolved.map((p) => [p.id, p]))
      : new Map();
    const items = pieces
      .filter((p) => readingById.has(p.id))
      .map((p) => {
        const v = verdictById.get(p.id) || {};
        const r = readingById.get(p.id);
        const f = flavour.find((x) => x.id === p.id) || {};
        return {
          id: p.id,
          display_name: f.display_name || p.display_name,
          flavour: f.flavour,
          spriteFile: byId.has(p.id) ? byId.get(p.id).spriteFile : null,
          mass_kg: p.mass_kg, altitude_m: p.altitude_m,
          size_class: p.size_class, fragile: p.fragile,
          verdict: v.verdict || 'loose', why: v.why, evidence: v.evidence,
          suggested_id: v.suggested_id, flag_for_human: v.flag_for_human,
          depicts: r.depicts, detail: r.detail, legible: r.legible,
        };
      });
    const common = {
      generatedAt: stamp,
      catalogPath: path.relative(path.join(ROOT, '..'), catalogPath).replace(/\\/g, '/'),
    };

    // The findings page always ships: it is how somebody sees what the audit concluded without
    // running anything and without receiving the art. Each tile carries the blind reader's own
    // words in place of the sprite, which is what the verdict rested on anyway.
    fs.writeFileSync(path.join(outDir, 'report', 'art-findings.html'),
      renderArtReview(items, { ...common, embedSprites: false }));

    // And the one with the pictures, only where the pictures are. Never published.
    if (artDir && items.every((i) => i.spriteFile)) {
      fs.writeFileSync(path.join(outDir, 'report', 'art.html'), renderArtReview(items, {
        ...common,
        artDir: path.relative(path.join(ROOT, '..'), artDir).replace(/\\/g, '/'),
      }));
    }
  }

  if (args.record) {
    fs.mkdirSync(stubDir, { recursive: true });
    const kept = new Set();
    let n = 0;
    for (const f of fs.readdirSync(logDir)) {
      if (!f.endsWith('.log') || f.endsWith('.err.log')) continue;
      fs.copyFileSync(path.join(logDir, f), path.join(stubDir, f));
      kept.add(f);
      n++;
    }
    // Prune fixtures this run did not produce. Without it, stubs/ silts up: a run whose critic
    // succeeded first time leaves the previous run's `.attempt2.log` sitting there, and the
    // directory stops describing any single run. Replay would still work — it looks for
    // attempt 1 first — but the evidence on disk would be an archaeological layer rather than
    // a recording, and somebody would eventually read it as one.
    for (const f of fs.readdirSync(stubDir)) {
      if (f.endsWith('.log') && !kept.has(f)) fs.unlinkSync(path.join(stubDir, f));
    }
    // Snapshot the catalog with the fixtures. The flavour text describes THESE masses at
    // THESE altitudes, and the crew rewrites its own copy on every run.
    writeJson(snapshot, catalog);
    // And the sprite map, for the same reason: the recorded readings are of the sprites THIS
    // mapping pointed at, so a replay that read a re-mapped file would attach them to the wrong
    // pieces. It is small, it is metadata, and it carries no art.
    if (spriteMap) writeJson(path.join(ROOT, 'data', 'debris_sprites.json'), spriteMap);
    log(`recorded ${n} agent logs to stubs/ and snapshotted the catalog — \`--stub\` replays this run`);
  }

  // -- summary --------------------------------------------------------------
  const line = '  ' + '-'.repeat(66);
  console.log('');
  console.log(line);
  console.log(`  Junkstronaut content pipeline — ${totals.items} items, ` +
    `${totals.corrections} corrected after review`);
  console.log(line);
  console.log(`  barks             ${barks.length} generated + ${CANON_BARKS.length} canon from the GDD`);
  console.log(`  debris flavour    ${flavour.length} pieces`);
  if (artVerdicts.length) {
    const t = artVerdicts.reduce((a, v) => { a[v.verdict] = (a[v.verdict] || 0) + 1; return a; }, {});
    console.log(`  art audit         ${artVerdicts.length} sprites read blind — ${t.match || 0} match ` +
      `their id, ${t.loose || 0} loose, ${t.mismatch || 0} disagree`);
  }
  console.log(`  post-mortems      ${screens.length} screens (5 terminal states + 4 stranded sub-cases)`);
  console.log(`  retrieval         P@1 ${(accuracy.precision_at_1 * 100).toFixed(0)}% on ${accuracy.labelled} ` +
    `hand-labelled states; each item written from ` +
    `${(manifest.retrieval.share_of_document_per_item * 100).toFixed(1)}% of the document or less`);
  console.log(`  critic            ${totals.issues} issue(s) raised, ${totals.corrections} correction(s) applied`);
  console.log(`  code checks       ${totals.checks_run - totals.checks_failed}/${totals.checks_run} passed`);
  console.log(`  circuit breaker   ${escalations.tripped
    ? `TRIPPED — ${escalations.total} finding(s) on ${escalations.distinct_items} item(s), escalated not retried`
    : 'clear — nothing needed a human'}`);
  if (models.size) console.log(`  models            ${[...models].join(', ')}`);
  console.log(`  artifacts         ${path.relative(process.cwd(), outDir) || outDir}`);
  console.log(line);
  console.log('');
  console.log('  Game-ready output:');
  console.log('    content/armstrong_barks.json     the radio barks, keyed by game state');
  console.log(`    content/debris_flavour.json      display names and flavour for all ${flavour.length} pieces`);
  console.log('    content/postmortem_screens.json  the end-of-run screens');
  console.log('    content/content.gd               the Godot autoload that loads all three');
  console.log('    report/content.html              query -> chunk -> output, and every correction');
  if (escalations.tripped) {
    console.log('');
    console.log('  Needs a human before this ships:');
    console.log(`    checks/needs_human.json          ${escalations.total} finding(s), each with why it was not retried`);
  }
  console.log('');

  // Exit code is 0 even when the breaker trips, because tripping is a RESULT and the run
  // that produced it succeeded. `--strict` is for the caller that wants it to be a failure —
  // a build step wiring this content into the game should not do so unread.
  return escalations.tripped && args.strict ? 3 : 0;
}

const trim = (h) => ({ id: h.id, section: h.section, score: h.score, matched: h.matched });

// A tiny Godot autoload. The three files are plain JSON so that the game does not need a
// custom resource to read content, and so that a human can diff a wording change.
function emitLoader() {
  return `extends Node
# Junkstronaut generated content — written by content/run-content.js.
#
# Autoload this as \`Content\`. The three JSON files beside it are the pipeline's output and
# are safe to overwrite with a fresh run; nothing here holds state.

const DIR := "res://content/"

var barks := {}       # state id -> line
var debris := {}      # debris id -> { display_name, flavour }
var screens := {}     # terminal state id -> { title, cause, rule_broken, armstrong }

func _ready() -> void:
\tfor entry in _load("armstrong_barks.json").get("barks", []):
\t\tbarks[entry["id"]] = entry["line"]
\tdebris = _load("debris_flavour.json").get("pieces", {})
\tscreens = _load("postmortem_screens.json").get("screens", {})

func bark(state_id: String) -> String:
\treturn barks.get(state_id, "")

func display_name(debris_id: String) -> String:
\treturn debris.get(debris_id, {}).get("display_name", debris_id)

func _load(file_name: String) -> Dictionary:
\tvar f := FileAccess.open(DIR + file_name, FileAccess.READ)
\tif f == null:
\t\tpush_error("content: could not open " + file_name)
\t\treturn {}
\tvar parsed: Variant = JSON.parse_string(f.get_as_text())
\treturn parsed if parsed is Dictionary else {}
`;
}

module.exports = { parseArgs, applyCorrections, retrievalTweak, emitLoader, USAGE };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('');
      console.error(`content pipeline failed: ${err.message}`);
      console.error('');
      console.error('The last prompt and reply for every agent are in content/out/logs/.');
      console.error('Artifacts are written at the end, so a late failure leaves out/ from the previous run.');
      process.exit(1);
    }
  );
}
