'use strict';
// Tests for the deterministic half of the content pipeline.
//
// `--stub` is not a test. A replay reads recorded agent output and walks the one path that
// recorded run happened to take, so it never executes a rejected schema, never runs the
// retry-with-feedback loop, and never sees a correction that has nothing to apply. Those are
// exactly the places the pipeline's interesting claims live.
//
//   node --test "test/*.test.js"
//
// Use that form. A bare `node --test` picks up test/fixtures/fake-writer.js — a stand-in for
// the CLI, not a test — and blocks forever waiting for a prompt on stdin.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GDD = path.join(ROOT, '..', 'Junkstronaut GDD Short.txt');

const { chunkDocument } = require('../lib/chunk');
const { buildIndex, retrieve, tokenize, fold } = require('../lib/retrieve');
const { plan, sourceBlock, itemBlock } = require('../lib/prompt');
const {
  checkCitations, checkCoverage, checkReadsAs, checkExtremes, scoreRetrieval,
} = require('../lib/verify');
const { parseArgs, applyCorrections, retrievalTweak, emitLoader } = require('../run-content');
const { BARK_STATES, POSTMORTEM_STATES, VOICE_QUERY, debrisQuery, altitudeThird } = require('../lib/items');

const gddText = fs.readFileSync(GDD, 'utf8');
const chunks = chunkDocument(gddText);
const index = buildIndex(chunks, 'bm25');

// ---------------------------------------------------------------- chunking

test('every chunk is verbatim document text', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const src = norm(gddText);
  for (const c of chunks) {
    assert.ok(src.includes(norm(c.text)), `${c.id} is not verbatim`);
  }
});

test('no chunk starts or ends mid-sentence', () => {
  for (const c of chunks) {
    // A chunk may legitimately end on a table row or a bullet, which have no terminator.
    const last = c.text.trim().slice(-1);
    const startsClean = /^[A-Z(*§"'\d\t—]/.test(c.text.trim());
    assert.ok(startsClean, `${c.id} starts mid-sentence: ${JSON.stringify(c.text.slice(0, 40))}`);
    assert.ok(/[.!?):\d\w]/.test(last), `${c.id} ends oddly: ${JSON.stringify(c.text.slice(-40))}`);
  }
});

test('a heading written "1. Title" is found as well as "2.2 Title"', () => {
  // The regression this guards: without the optional dot, §1 and §3 stop being headings and
  // their bodies get filed under whichever numbered sub-section came before them.
  const sections = new Set(chunks.map((c) => c.section));
  for (const want of ['1', '2.2', '3', '4.4', '5']) {
    assert.ok(sections.has(want), `section ${want} was not found`);
  }
  const three = chunks.find((c) => c.section === '3');
  assert.match(three.title, /AI Architecture/);
});

test('a repeated heading continues its section rather than opening an empty one', () => {
  // The GDD writes "4.5 Open, and deliberately not written down as settled" twice, on
  // consecutive lines.
  const parts = chunks.filter((c) => c.section === '4.5');
  assert.ok(parts.length >= 1);
  assert.ok(parts.every((p) => p.chars > 0));
});

test('a long section is split and a short one is not', () => {
  const long = chunks.filter((c) => c.section === '2.2');
  assert.ok(long.length > 1, '§2.2 is 6,400 characters and must be split');
  assert.ok(long.every((c) => c.of === long.length));
  assert.deepStrictEqual(long.map((c) => c.id).slice(0, 3), ['2.2a', '2.2b', '2.2c']);

  const short = chunks.filter((c) => c.section === '2.3');
  assert.strictEqual(short.length, 1);
  assert.strictEqual(short[0].id, '2.3');
});

test('the document title block is not indexed', () => {
  // It is above the first heading and would score on any query naming the game.
  assert.ok(!chunks.some((c) => /Multi-Agent AI for Game Development/.test(c.text)));
});

// ---------------------------------------------------------------- tokenising

test('numbers keep their digits and lose their separators', () => {
  assert.strictEqual(fold('3,600'), '3600');
  assert.strictEqual(fold('8,000'), '8000');
  assert.strictEqual(fold('268.8'), '268.8');
  assert.ok(tokenize('the module is ~3,600 kg').includes('3600'));
});

test('plurals fold but "pass" and "mass" survive', () => {
  assert.strictEqual(fold('passes'), 'pass');
  assert.strictEqual(fold('mass'), 'mass');
  assert.strictEqual(fold('barks'), 'bark');
  assert.strictEqual(fold('bodies'), 'body');
});

test('a query can find a passage by the number it states', () => {
  const r = retrieve(index, '3,600 kg module', { k: 3 });
  assert.ok(r.hits.some((h) => h.section === '2.6'),
    'the 3,600 kg module lives in §2.6 and must be findable by its mass');
});

// ---------------------------------------------------------------- retrieval

test('every hand-labelled state retrieves the section a human said answers it', () => {
  const labelled = [...BARK_STATES, ...POSTMORTEM_STATES];
  const score = scoreRetrieval(plan(index, labelled, { k: 3 }).perItem);
  assert.strictEqual(score.labelled, labelled.length);
  assert.strictEqual(score.precision_at_1, 1,
    `misses: ${JSON.stringify(score.misses)}`);
});

test('BM25 beats raw overlap on the same labels — the tweak the ReadMe reports', () => {
  const t = retrievalTweak(gddText, [...BARK_STATES, ...POSTMORTEM_STATES]);
  assert.ok(t.after.precision_at_1 > t.before.precision_at_1,
    `${t.before.precision_at_1} -> ${t.after.precision_at_1}`);
  assert.ok(t.after.mean_retrieved_chars_per_query < t.before.mean_retrieved_chars_per_query / 2,
    'sub-chunking should more than halve the characters retrieved per query');
  assert.ok(t.before.meta_section_wins_rank_1 > 0,
    'the retired retriever let §3 win player-facing queries outright — that is what was fixed');
  assert.strictEqual(t.after.meta_section_wins_rank_1, 0,
    '§3 and §4 describe how the game gets built and must never win a player-facing query');
});

test('scores are reproducible and ties break on chunk id', () => {
  const a = retrieve(index, 'commit floor 8,000 m', { k: 4 });
  const b = retrieve(index, 'commit floor 8,000 m', { k: 4 });
  assert.deepStrictEqual(a.hits.map((h) => [h.id, h.score]), b.hits.map((h) => [h.id, h.score]));
});

test('a query that matches nothing returns nothing rather than the longest chunk', () => {
  const r = retrieve(index, 'zzzzqqq wwwwxxx', { k: 3 });
  assert.strictEqual(r.hits.length, 0);
});

// ---------------------------------------------------------------- prompt shape

test('passages are printed once no matter how many items retrieved them', () => {
  const p = plan(index, BARK_STATES, { k: 3, voiceQuery: VOICE_QUERY, voiceK: 2 });
  const block = sourceBlock(p.pool);
  for (const c of p.pool) {
    const marker = `[${c.id}]`;
    const count = block.split(marker).length - 1;
    assert.strictEqual(count, 1, `${c.id} printed ${count} times`);
  }
});

test('the prompt carries a fraction of the document, not the document', () => {
  const p = plan(index, BARK_STATES, { k: 3, voiceQuery: VOICE_QUERY, voiceK: 2 });
  const perItem = p.perItem.reduce((a, e) => a + e.hits.reduce((b, h) => b + h.chars, 0), 0)
    / p.perItem.length;
  assert.ok(perItem / gddText.length < 0.10,
    `each item should be written from under 10% of the document, got ${(perItem / gddText.length * 100).toFixed(1)}%`);
});

test('every item block names the chunks that item retrieved', () => {
  const p = plan(index, POSTMORTEM_STATES, { k: 3 });
  const block = itemBlock(p.perItem, (id) => id);
  for (const e of p.perItem) {
    assert.match(block, new RegExp(`${e.id}\\n\\s+retrieved for this item: ${e.hits[0].id} `));
  }
});

// ---------------------------------------------------------------- verification

test('a citation to a chunk that was never in the prompt fails', () => {
  const p = plan(index, POSTMORTEM_STATES, { k: 3 });
  const poolIds = new Set(p.pool.map((c) => c.id));
  const items = [{ id: 'landed', grounded_in: ['99.9z'] }];
  const [r] = checkCitations(items, p.perItem, poolIds);
  assert.strictEqual(r.result, 'fail');
  assert.match(r.detail, /never in the prompt/);
});

test('a citation from the shared pool passes but says so', () => {
  const p = plan(index, POSTMORTEM_STATES, { k: 3 });
  const poolIds = new Set(p.pool.map((c) => c.id));
  const notMine = p.perItem.find((e) => e.id !== 'landed').hits[0].id;
  const mine = p.perItem.find((e) => e.id === 'landed');
  if (mine.hits.some((h) => h.id === notMine)) return; // the ids overlap; nothing to assert
  const [r] = checkCitations([{ id: 'landed', grounded_in: [notMine] }], p.perItem, poolIds);
  assert.strictEqual(r.result, 'pass');
  assert.match(r.detail, /shared pool/);
});

test('coverage catches a missing item, an invented one and a duplicate', () => {
  const want = ['a', 'b', 'c'];
  assert.strictEqual(checkCoverage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], want, 't')[0].result, 'pass');
  assert.match(checkCoverage([{ id: 'a' }, { id: 'b' }], want, 't')[0].detail, /missing c/);
  assert.match(checkCoverage([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'z' }], want, 't')[0].detail, /invented z/);
  assert.match(checkCoverage([{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }], want, 't')[0].detail, /duplicated a/);
});

test('fiction that disagrees with the mechanics fails, in both directions', () => {
  const band = { min: 50000, max: 280000 };
  const catalog = new Map([
    ['heavy_high', { id: 'heavy_high', mass_kg: 1600, altitude_m: 276000, size_class: 'large', fragile: false }],
    ['glass', { id: 'glass', mass_kg: 40, altitude_m: 60000, size_class: 'small', fragile: true }],
  ]);
  const results = checkReadsAs([
    { id: 'heavy_high', reads_as: ['heavy', 'low'] },   // wrong: 276 km is not low
    { id: 'glass', reads_as: ['light'] },               // wrong: the catalog flags it fragile
  ], catalog, band);
  assert.strictEqual(results[0].result, 'fail');
  assert.match(results[0].detail, /claims low at 276,000 m/);
  assert.strictEqual(results[1].result, 'fail');
  assert.match(results[1].detail, /catalog says fragile/);

  const good = checkReadsAs([
    { id: 'heavy_high', reads_as: ['heavy', 'high', 'large'] },
    { id: 'glass', reads_as: ['light', 'low', 'fragile'] },
  ], catalog, band);
  assert.ok(good.every((r) => r.result === 'pass'), JSON.stringify(good));
});

test('the heaviest and lightest pieces are checked by name', () => {
  const band = { min: 50000, max: 280000 };
  const catalog = [
    { id: 'big', mass_kg: 1600, altitude_m: 276000, size_class: 'large', fragile: false },
    { id: 'mid', mass_kg: 300, altitude_m: 160000, size_class: 'medium', fragile: false },
    { id: 'wee', mass_kg: 62, altitude_m: 52000, size_class: 'small', fragile: false },
  ];
  const bad = checkExtremes([
    { id: 'big', reads_as: ['high'] },
    { id: 'wee', reads_as: ['light'] },
  ], catalog, band);
  assert.strictEqual(bad[0].result, 'fail');
  assert.strictEqual(bad[1].result, 'pass');
});

// ---------------------------------------------------------------- correction

test('a correction is applied and the draft it replaced is kept', () => {
  const items = [{ id: 'a', line: 'the wrong line' }, { id: 'b', line: 'a fine line' }];
  const { corrections, unresolved } = applyCorrections(items, {
    reviews: [
      { id: 'a', verdict: 'revise', issues: [{ type: 'contradicts_gdd' }], corrected: { line: 'the right line' } },
      { id: 'b', verdict: 'pass', issues: [] },
    ],
  }, ['line']);

  assert.strictEqual(items[0].line, 'the right line', 'the item is corrected in place');
  assert.strictEqual(corrections.length, 1);
  assert.strictEqual(corrections[0].before.line, 'the wrong line', 'the rejected draft is the evidence');
  assert.strictEqual(corrections[0].after.line, 'the right line');
  assert.strictEqual(unresolved.length, 0);
});

test('a non-passing verdict with nothing to apply is reported, not silently passed', () => {
  const items = [{ id: 'a', line: 'unchanged' }];
  const { corrections, unresolved } = applyCorrections(items, {
    reviews: [{ id: 'a', verdict: 'reject', issues: [{ type: 'wrong_voice' }] }],
  }, ['line']);
  assert.strictEqual(corrections.length, 0);
  assert.strictEqual(unresolved.length, 1);
  assert.strictEqual(unresolved[0].verdict, 'reject');
  assert.strictEqual(items[0].line, 'unchanged');
});

test('a correction that rewrites the writer\'s citations is dropped, not applied', () => {
  // The schema tolerates an array here so a finding is never bounced on a formatting
  // technicality — a retry re-derives the judgement and loses findings. The filter is what
  // keeps the evidence intact.
  const items = [{ id: 'a', line: 'the wrong line', grounded_in: ['1a'], reads_as: ['light'] }];
  const { corrections } = applyCorrections(items, {
    reviews: [{
      id: 'a',
      verdict: 'revise',
      issues: [],
      corrected: { line: 'the right line', grounded_in: ['2.2a'], reads_as: ['heavy'] },
    }],
  }, ['line']);
  assert.strictEqual(corrections.length, 1);
  assert.deepStrictEqual(Object.keys(corrections[0].after), ['line'], 'only the text field moves');
  assert.deepStrictEqual(items[0].grounded_in, ['1a']);
  assert.deepStrictEqual(items[0].reads_as, ['light']);
});

test('a correction that only touches fields the type does not own is ignored', () => {
  const items = [{ id: 'a', line: 'keep me', grounded_in: ['1a'] }];
  const { corrections, unresolved } = applyCorrections(items, {
    reviews: [{ id: 'a', verdict: 'revise', issues: [], corrected: { grounded_in: '2.2a' } }],
  }, ['line']);
  assert.strictEqual(corrections.length, 0);
  assert.strictEqual(unresolved.length, 1, 'a citation is not a text field and must not be rewritten by the critic');
  assert.deepStrictEqual(items[0].grounded_in, ['1a']);
});

// ---------------------------------------------------------------- items and arguments

test('debris queries are built from the piece, and thirds are computed not guessed', () => {
  const band = { min: 50000, max: 280000 };
  assert.strictEqual(altitudeThird(52000, band), 'bottom third');
  assert.strictEqual(altitudeThird(160000, band), 'middle third');
  assert.strictEqual(altitudeThird(276000, band), 'top third');
  const q = debrisQuery({ altitude_m: 276000, mass_kg: 1600, size_class: 'large', fragile: true }, band);
  assert.match(q, /276000/);
  assert.match(q, /top third/);
  assert.match(q, /fragile/);
});

test('every state has a query and a label, and no id repeats within its own type', () => {
  // `burned_up` is deliberately both a bark state and a terminal state. The ids are scoped per
  // content type — they key different output files — so the check is per list, not across.
  for (const list of [BARK_STATES, POSTMORTEM_STATES]) {
    const ids = list.map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`);
  }
  for (const s of [...BARK_STATES, ...POSTMORTEM_STATES]) {
    assert.ok(s.query && s.query.length > 40, `${s.id} has no real query`);
    assert.ok(Array.isArray(s.expect) && s.expect.length, `${s.id} has no expect label`);
  }
});

test('arguments parse, and an unknown one is refused', () => {
  assert.deepStrictEqual(parseArgs(['--stub']).mode, 'stub');
  assert.strictEqual(parseArgs([]).mode, 'live');
  assert.strictEqual(parseArgs(['--record']).record, true);
  assert.deepStrictEqual(parseArgs(['--reuse', 'bark-writer,lore-critic.barks']).reuse,
    ['bark-writer', 'lore-critic.barks']);
  assert.strictEqual(parseArgs(['--out', 'x']).out, 'x');
});

test('the Godot loader is syntactically plausible and tab-indented', () => {
  const gd = emitLoader();
  assert.match(gd, /^extends Node/);
  assert.match(gd, /func bark\(state_id: String\) -> String:/);
  assert.ok(!/^ {2,}\S/m.test(gd), 'GDScript here is tab-indented; a stray space indent is a parse error');
});

// ---------------------------------------------------------------- end to end

test('the pipeline runs end to end against a fake CLI, and writes every artifact', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-content-'));
  execFileSync(process.execPath, [path.join(ROOT, 'run-content.js'), '--no-art', '--out', out], {
    cwd: ROOT,
    env: { ...process.env, JUNK_AGENT_CMD: `node "${path.join(ROOT, 'test', 'fixtures', 'fake-writer.js')}" ok` },
    encoding: 'utf8',
  });

  for (const f of [
    'content/armstrong_barks.json', 'content/debris_flavour.json',
    'content/postmortem_screens.json', 'content/content.gd',
    'retrieval/retrieval_log.json', 'retrieval/tweak_comparison.json',
    'critique/critique_log.json', 'checks/deterministic_checks.json',
    'report/content.html', 'run.json',
  ]) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} was not written`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
  // Counted from the catalog the run actually read, not typed in here. A hardcoded piece count
  // goes stale the day the tuning crew adds one — which is exactly what happened at 25.
  // Same two candidate paths run-content.js searches, so the suite passes in either repo.
  const catalogPath = [
    path.join(ROOT, '..', 'crew', 'out', 'data', 'debris_catalog.json'),
    path.join(ROOT, '..', 'config', 'debris_catalog.json'),
  ].find((p) => fs.existsSync(p));
  const pieces = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).debris.length;
  assert.strictEqual(manifest.totals.items, BARK_STATES.length + POSTMORTEM_STATES.length + pieces);
  assert.strictEqual(manifest.retrieval.precision_at_1, 1);

  const barks = JSON.parse(fs.readFileSync(path.join(out, 'content/armstrong_barks.json'), 'utf8'));
  assert.strictEqual(barks.barks.filter((b) => b.source === 'gdd').length, 3,
    'the three lines already in the GDD ship alongside the generated ones');

  const html = fs.readFileSync(path.join(out, 'report/content.html'), 'utf8');
  assert.match(html, /Query &rarr; retrieved passage &rarr; generated output/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('a malformed reply is retried with the reason fed back, then fails cleanly', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-content-'));
  let threw = null;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'run-content.js'), '--no-art', '--out', out], {
      cwd: ROOT,
      env: { ...process.env, JUNK_AGENT_CMD: `node "${path.join(ROOT, 'test', 'fixtures', 'fake-writer.js')}" malformed` },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'a writer that never returns JSON must fail the run');
  assert.match(String(threw.stderr), /bark-writer failed after 3 attempts/);

  // The retry has to carry the reason, not just try again.
  const second = fs.readFileSync(path.join(out, 'logs', 'bark-writer.attempt2.prompt.md'), 'utf8');
  assert.match(second, /YOUR PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(second, /reply contained no JSON object/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('a citation the writer invented is caught by code, not by the critic', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-content-'));
  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'run-content.js'), '--no-art', '--out', out], {
    cwd: ROOT,
    env: { ...process.env, JUNK_AGENT_CMD: `node "${path.join(ROOT, 'test', 'fixtures', 'fake-writer.js')}" unknown-cite` },
    encoding: 'utf8',
  });
  assert.match(stdout, /FAIL citations_exist/);
  const checks = JSON.parse(fs.readFileSync(path.join(out, 'checks', 'deterministic_checks.json'), 'utf8'));
  const failed = checks.checks.barks.filter((c) => c.result === 'fail');
  assert.ok(failed.length, 'every bark cited a chunk that was never in the prompt');
  fs.rmSync(out, { recursive: true, force: true });
});
