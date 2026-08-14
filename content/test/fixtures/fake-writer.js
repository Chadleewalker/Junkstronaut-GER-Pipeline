#!/usr/bin/env node
'use strict';
// A stand-in for the Claude CLI that writes schema-valid nonsense.
//
// It reads a prompt on stdin, works out which agent it is being asked to be, scrapes the item
// ids and chunk ids straight out of that prompt, and returns an object that satisfies the
// matching schema. The words are deliberately worthless — the point is to exercise the
// orchestrator end to end, not to write content.
//
// What that buys is the thing a `--stub` replay cannot give you: a replay only ever walks the
// path one recorded run happened to take, so it never sees a schema rejection, never sees a
// retry, and never sees the critic return a correction for an item the writer worded
// differently. This fake can be told to do all three.
//
//   node fake-writer.js [behaviour]
//
//     ok        (default) valid output for whichever agent the prompt describes
//     critic-revise   the critic flags the first item and supplies a correction
//     malformed       not JSON at all, so the retry-with-feedback path runs
//     unknown-cite    the writer cites a chunk id that was never in the prompt

const fs = require('fs');

const behaviour = process.argv[2] || 'ok';

let prompt = '';
try { prompt = fs.readFileSync(0, 'utf8'); } catch { prompt = ''; }

function envelope(text) {
  process.stdout.write(JSON.stringify({
    type: 'result',
    result: text,
    modelUsage: { 'fake-writer': { outputTokens: 1 } },
  }) + '\n');
}

if (behaviour === 'malformed') {
  envelope('I am afraid I cannot do that.');
  process.exit(0);
}

// Item ids come out of the numbered "ITEMS/STATES/PIECES TO WRITE" block, which is the same
// shape for all three writers: "12. some_id" possibly followed by indented detail lines.
const ids = [...prompt.matchAll(/^\s*\d+\.\s+([a-z0-9_]+)\s*$/gm)].map((m) => m[1]);
const chunkIds = [...new Set([...prompt.matchAll(/^\[(\d+(?:\.\d+)?[a-z]?)\]/gm)].map((m) => m[1]))];
const cite = (i) => [behaviour === 'unknown-cite' ? '99.9z' : (chunkIds[i % chunkIds.length] || '1a')];

// The art reader is given a sheet, a cell count and no ids at all — so it is identified by its
// charter and its reply is keyed by cell number. It cannot scrape ids because it is never shown
// any, which is exactly the property art.test.js asserts.
if (/# Art Reader/.test(prompt)) {
  const n = Number((prompt.match(/It holds (\d+) sprites/) || [])[1] || 1);
  const sheet = (prompt.match(/Sheet id:\s*(\S+)/) || [])[1] || 'sheet1';
  envelope(JSON.stringify({
    sheet,
    unreadable: false,
    cells: Array.from({ length: n }, (_, i) => ({
      cell: i + 1,
      depicts: `A fake object number ${i + 1}`,
      detail: 'A fake description of a drawn shape, long enough to satisfy the schema minimum.',
      condition: 'intact',
      bulk: 'compact',
      palette: ['grey'],
      legible: 'clear',
    })),
  }));
  process.exit(0);
}

// The art matcher is given ids and readings and never an image. `art-mismatch` makes it disagree
// with the first piece, which is how the orchestrator's mismatch handling gets exercised.
if (/# Art Matcher/.test(prompt)) {
  const artIds = [...new Set([...prompt.matchAll(/^([a-z][a-z0-9_]+)$/gm)].map((x) => x[1]))];
  envelope(JSON.stringify({
    verdicts: artIds.map((id, i) => (behaviour === 'art-mismatch' && i === 0 ? {
      id,
      verdict: 'mismatch',
      evidence: 'reading: "A fake object number 1"',
      why: 'The fake matcher always disagrees with the first piece so the mismatch path runs.',
      suggested_id: 'fake_object',
      flag_for_human: '',
    } : {
      id,
      verdict: 'match',
      evidence: 'reading: "A fake object"',
      why: 'The fake matcher agrees with everything it was not told to disagree with.',
      suggested_id: '',
      flag_for_human: '',
    })),
  }));
  process.exit(0);
}

// The critic is identified by its own charter heading rather than by the presence of items,
// because it is given the same item block the writer was.
if (/# Lore Critic/.test(prompt)) {
  const reviews = ids.map((id, i) => {
    if (behaviour === 'critic-revise' && i === 0) {
      return {
        id,
        verdict: 'revise',
        issues: [{
          type: 'contradicts_gdd',
          quote: 'the fake line',
          evidence: '[1a] the fake passage that settles it, quoted at length',
          cites: cite(i),
          why: 'the fake critic always flags the first item so the correction path runs',
        }],
        corrected: {
          line: 'corrected fake line, long enough to satisfy the pattern',
          display_name: 'Corrected Fake Name',
          title: 'CORRECTED',
          cause: 'corrected fake cause, long enough to satisfy the pattern',
          rule_broken: 'corrected fake rule, long enough to satisfy the pattern',
          armstrong: 'corrected fake bark, long enough here',
          flavour: 'corrected fake flavour text, long enough to satisfy the minimum length the schema asks for',
        },
      };
    }
    return { id, verdict: 'pass', issues: [] };
  });
  envelope(JSON.stringify({
    agent: 'lore-critic',
    verdict: behaviour === 'critic-revise' ? 'revise' : 'pass',
    summary: 'A fake critique produced by the test fixture, not by a model.',
    reviews,
  }));
  process.exit(0);
}

if (/# Bark Writer/.test(prompt)) {
  envelope(JSON.stringify({
    agent: 'bark-writer',
    barks: ids.map((id, i) => ({
      id,
      line: `fake bark for ${id}, kid`,
      grounded_in: cite(i),
      why: 'a fake justification, long enough to pass the minimum length',
    })),
  }));
  process.exit(0);
}

if (/# Debris Flavourist/.test(prompt)) {
  // reads_as has to agree with the mechanical block or the deterministic checks fail, which
  // is the point: the fixture reads the same fields the checks read.
  const mech = new Map([...prompt.matchAll(
    /^([a-z0-9_]+)\n\s+(\d+) kg \| ([\d,]+) m \((\w+) third\) \| (\w+)(\s*\|\s*FRAGILE)?/gm)]
    .map((m) => [m[1], { third: m[4], size: m[5], fragile: Boolean(m[6]) }]));
  envelope(JSON.stringify({
    agent: 'debris-flavourist',
    pieces: ids.map((id, i) => {
      const m = mech.get(id) || {};
      const reads = [m.third === 'top' ? 'high' : m.third === 'bottom' ? 'low' : 'solid'];
      if (m.fragile) reads.push('fragile');
      return {
        id,
        display_name: `Fake ${id.replace(/_/g, ' ')}`.slice(0, 42),
        flavour: `Fake flavour text for ${id}, written by the test fixture and long enough to pass.`,
        reads_as: [...new Set(reads)],
        grounded_in: cite(i),
      };
    }),
  }));
  process.exit(0);
}

if (/# Post-Mortem Writer/.test(prompt)) {
  envelope(JSON.stringify({
    agent: 'postmortem-writer',
    screens: ids.map((id, i) => ({
      id,
      title: id.toUpperCase().slice(0, 32),
      cause: `A fake cause for ${id}, long enough to satisfy the schema pattern.`,
      rule_broken: `A fake rule for ${id}, long enough to satisfy the schema pattern.`,
      armstrong: `Fake bark for ${id}, kid.`,
      grounded_in: cite(i),
    })),
  }));
  process.exit(0);
}

envelope('the fake writer did not recognise this charter');
