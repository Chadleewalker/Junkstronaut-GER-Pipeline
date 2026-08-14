'use strict';
// The circuit breaker's own tests.
//
// The breaker is the part of this pipeline whose failure mode is silence: if it collects
// nothing, every run reports "clear" and the content ships unread, which is exactly the
// state the breaker exists to prevent and is indistinguishable from a good run. So every
// test here plants a KNOWN failure and asserts it comes back out — a suite that only
// checked the clean case would pass against a breaker that returns [] unconditionally.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  collectEscalations, fromChecks, fromUnresolved, fromRecheck, fromArt,
} = require('../lib/escalate');

const ISSUE = {
  type: 'contradicts_gdd',
  quote: 'burns up on the way down',
  evidence: 'The document says the shield is spent, not that the cargo is lost.',
  why: 'The line states an outcome the design document does not support.',
};

// ---------------------------------------------------------------- each source

test('a failed deterministic check is escalated, a passing one is not', () => {
  const out = fromChecks({
    debris: [
      { id: 'a', check: 'reads_as_matches_mechanics', result: 'pass', detail: 'fine' },
      { id: 'b', check: 'reads_as_matches_mechanics', result: 'fail', detail: 'claims low at 700,000 m' },
    ],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'b');
  assert.strictEqual(out[0].kind, 'check_failed');
  assert.match(out[0].detail, /claims low/);
});

test('a check failure the art audit disputed is labelled as a data conflict, not a writing fault', () => {
  const [e] = fromChecks({
    debris: [{
      id: 'torn_foil_blanket',
      check: 'reads_as_matches_mechanics',
      result: 'fail',
      detail: 'catalog says fragile, reads_as does not claim it; the art audit disputes this piece\'s id (mismatch)',
    }],
  });
  assert.match(e.looks_like, /reconcile the data/);
});

test('a non-passing verdict with no usable correction is escalated', () => {
  const out = fromUnresolved({
    barks: { corrections: [], unresolved: [{ id: 'first_launch', verdict: 'revise', issues: [ISSUE] }] },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'no_usable_correction');
});

test('an item still flagged after the refine pass is escalated as refine_exhausted', () => {
  const out = fromRecheck({
    debris: {
      verdict: 'revise',
      reviews: [
        { id: 'kept', verdict: 'pass', issues: [] },
        { id: 'bent_truss_section', verdict: 'revise', issues: [ISSUE] },
      ],
    },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'bent_truss_section');
  assert.strictEqual(out[0].kind, 'refine_exhausted');
});

test('critic issues are rendered as text, never as [object Object]', () => {
  const [e] = fromRecheck({ debris: { reviews: [{ id: 'x', verdict: 'revise', issues: [ISSUE] }] } });
  assert.doesNotMatch(e.detail, /\[object Object\]/);
  assert.match(e.detail, /contradicts_gdd/);
  assert.match(e.detail, /does not support/);
});

test('an art mismatch escalates; a match does not; a flag_for_human on a loose piece does', () => {
  const out = fromArt([
    { id: 'ok_piece', verdict: 'match', flag_for_human: '' },
    { id: 'torn_foil_blanket', verdict: 'mismatch', flag_for_human: '', suggested_id: 'cracked_hull_plate' },
    { id: 'delaminated_radiator_fin', verdict: 'loose', flag_for_human: 'art and tuning disagree on FRAGILE.' },
  ]);
  assert.deepStrictEqual(out.map((e) => e.id), ['torn_foil_blanket', 'delaminated_radiator_fin']);
  assert.match(out[0].detail, /cracked_hull_plate/);
  assert.match(out[1].detail, /FRAGILE/);
});

// ---------------------------------------------------------------- the whole thing

test('a clean run does not trip the breaker', () => {
  const e = collectEscalations({
    checks: { barks: [{ id: 'a', check: 'coverage', result: 'pass', detail: '' }] },
    applied: { barks: { corrections: [], unresolved: [] } },
    recheck: { barks: { verdict: 'pass', reviews: [{ id: 'a', verdict: 'pass', issues: [] }] } },
    artVerdicts: [{ id: 'a', verdict: 'match', flag_for_human: '' }],
  });
  assert.strictEqual(e.tripped, false);
  assert.strictEqual(e.total, 0);
  assert.deepStrictEqual(e.items, []);
});

test('collectEscalations survives a run with no art stage and no re-check', () => {
  const e = collectEscalations({ checks: {}, applied: {}, recheck: {}, artVerdicts: [] });
  assert.strictEqual(e.tripped, false);
  assert.doesNotThrow(() => collectEscalations());
});

test('one item tripping two wires counts twice in total and once in distinct_items', () => {
  const e = collectEscalations({
    checks: { debris: [{ id: 'torn_foil_blanket', check: 'reads_as_matches_mechanics', result: 'fail', detail: 'catalog says fragile' }] },
    artVerdicts: [{ id: 'torn_foil_blanket', verdict: 'mismatch', flag_for_human: '' }],
  });
  assert.strictEqual(e.total, 2);
  assert.strictEqual(e.distinct_items, 1);
  assert.deepStrictEqual(e.by_kind, { check_failed: 1, data_conflict: 1 });
});

test('every escalation carries an id, a kind, a detail and a reason it was not retried', () => {
  const e = collectEscalations({
    checks: { debris: [{ id: 'a', check: 'c', result: 'fail', detail: 'd' }] },
    applied: { barks: { unresolved: [{ id: 'b', verdict: 'reject', issues: [ISSUE] }] } },
    recheck: { debris: { reviews: [{ id: 'c', verdict: 'revise', issues: [ISSUE] }] } },
    artVerdicts: [{ id: 'd', verdict: 'mismatch' }],
  });
  assert.strictEqual(e.items.length, 4);
  for (const item of e.items) {
    for (const key of ['id', 'type', 'kind', 'detail', 'looks_like']) {
      assert.ok(item[key], `${item.kind || 'item'} is missing ${key}`);
    }
  }
});

// ---------------------------------------------------------------- the recorded run
//
// The committed run is the evidence the README cites, so the numbers in it are asserted
// here rather than trusted. This is the check that would catch the breaker being wired in
// but collecting nothing: the recorded run has three items the critic could not settle and
// seven sprites whose id the audit disputes, and a needs_human.json that reports zero
// findings against that input is the silent failure this file exists for.

const OUT = path.join(__dirname, '..', 'out');

test('the recorded run ships a needs_human.json, and it is not empty', () => {
  const file = path.join(OUT, 'checks', 'needs_human.json');
  if (!fs.existsSync(file)) {
    assert.fail('no checks/needs_human.json in out/ — run `node run-content.js --stub` first');
  }
  const n = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(n.tripped, true);
  assert.ok(n.total >= 3, `expected at least the 3 unsettled debris items, got ${n.total}`);
  assert.ok(n.items.some((i) => i.kind === 'refine_exhausted'),
    'the recorded run has items the critic could not settle — none came through as refine_exhausted');
  assert.ok(n.items.some((i) => i.kind === 'data_conflict'),
    'the recorded run has disputed sprites — none came through as data_conflict');
});

test('the manifest and the breaker file agree on the count', () => {
  const run = JSON.parse(fs.readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const n = JSON.parse(fs.readFileSync(path.join(OUT, 'checks', 'needs_human.json'), 'utf8'));
  assert.strictEqual(run.totals.escalated, n.total);
  assert.strictEqual(run.totals.escalated_items, n.distinct_items);
});

test('the breaker changed no content — the flagged items still ship, as written', () => {
  const n = JSON.parse(fs.readFileSync(path.join(OUT, 'checks', 'needs_human.json'), 'utf8'));
  const flavour = JSON.parse(fs.readFileSync(path.join(OUT, 'content', 'debris_flavour.json'), 'utf8'));
  const flagged = n.items.filter((i) => i.type === 'debris').map((i) => i.id);
  assert.ok(flagged.length > 0, 'expected debris findings in the recorded run');
  for (const id of flagged) {
    assert.ok(flavour.pieces[id], `${id} was escalated and then dropped from the output`);
    assert.ok(flavour.pieces[id].flavour.length > 0, `${id} shipped with empty flavour`);
  }
});
