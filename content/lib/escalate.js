'use strict';
// The circuit breaker — what the loop does when it cannot self-correct.
//
// The refine loop is bounded on purpose and the bound is ONE pass: write, judge, correct,
// re-judge. There is no second correction round, and that is a decision rather than an
// omission. By the time an item has been rewritten by its critic and still fails, one of
// three things is true, and none of them is fixed by asking the writer again:
//
//   1. The DATA is wrong. `torn_foil_blanket` is flagged fragile in the catalogue and its
//      sprite is a cracked steel plate. The writer described the plate, correctly, and could
//      not honestly claim `fragile`. The check is right, the writing is right, the table is
//      wrong. Retrying can only make it lie.
//   2. The CRITIC is wrong — a non-passing verdict carrying no usable correction is a finding
//      about the judge, not the content.
//   3. The item is genuinely hard, and a third attempt at the same prompt with the same
//      passages is the definition of a loop that has stopped making progress.
//
// So the breaker does not retry. It stops, names every item it could not settle, says which
// of the three cases it looks like, and hands them to a human in one file. A pipeline that
// silently ships what it could not verify is worse than one that stops, because the failure
// arrives later wearing a reviewed line's clothes.
//
// Pure: takes the run's own artifacts, returns a plain object. Nothing here reads a file,
// writes one, or decides an exit code — run-content.js does all three, so this is testable
// without a run.

// A critic issue is an object — `{ type, quote, evidence, why, cites? }` per
// schemas/critique.schema.json — and joining a list of those produces `[object Object]`,
// which is a line that looks like a report and carries nothing. The type and the why are
// what a human needs to act; the full issue survives in critique/critique_log.json.
function issueText(issues) {
  return (issues || [])
    .map((i) => (typeof i === 'string' ? i : `${i.type}: ${i.why || i.evidence || i.quote || ''}`.trim()))
    .filter(Boolean)
    .join('; ');
}

// Deterministic check failed. Not retryable: the check compares the writer's DECLARATION
// against the catalogue's numbers, so a rewrite either fixes a careless claim (the critic
// already had its pass at that) or the numbers and the words disagree for a reason no
// amount of rewriting reaches.
function fromChecks(checks) {
  const out = [];
  for (const [type, list] of Object.entries(checks || {})) {
    for (const c of list) {
      if (c.result !== 'fail') continue;
      out.push({
        id: c.id,
        type,
        kind: 'check_failed',
        detail: `${c.check}: ${c.detail}`,
        // The reads_as checks are the ones that can be a data conflict rather than a writing
        // fault, and the check itself says so when the art audit disputed the piece.
        looks_like: /art audit disputes/.test(c.detail || '')
          ? 'the catalogue disagrees with its own artwork — reconcile the data, not the prose'
          : 'the declared reading does not match the catalogue numbers',
      });
    }
  }
  return out;
}

// The critic returned a non-passing verdict with nothing to apply. The loop cannot even
// begin, because there is no correction to make.
function fromUnresolved(applied) {
  const out = [];
  for (const [type, a] of Object.entries(applied || {})) {
    for (const u of a.unresolved || []) {
      out.push({
        id: u.id,
        type,
        kind: 'no_usable_correction',
        detail: `critic said ${u.verdict} but supplied no correction` +
          (issueText(u.issues) ? ` — ${issueText(u.issues)}` : ''),
        looks_like: 'a finding about the critic, not the content — read the issue and decide by hand',
      });
    }
  }
  return out;
}

// The refine pass ran and did not settle it. This is the breaker firing in its narrowest
// sense: the loop did its one bounded attempt and the item came back still flagged.
function fromRecheck(recheck) {
  const out = [];
  for (const [type, r] of Object.entries(recheck || {})) {
    for (const review of (r && r.reviews) || []) {
      if (review.verdict === 'pass') continue;
      out.push({
        id: review.id,
        type,
        kind: 'refine_exhausted',
        detail: `still ${review.verdict} after one correction` +
          (issueText(review.issues) ? ` — ${issueText(review.issues)}` : ''),
        looks_like: 'one correction did not settle it; a second pass at the same prompt is not progress',
      });
    }
  }
  return out;
}

// The art audit's own escalation channel. A mismatch between a piece's id and its sprite is
// a fact about the game's data that this pipeline can find and must not fix.
function fromArt(artVerdicts) {
  const out = [];
  for (const v of artVerdicts || []) {
    const flagged = v.flag_for_human && String(v.flag_for_human).trim();
    if (v.verdict !== 'mismatch' && !flagged) continue;
    out.push({
      id: v.id,
      type: 'debris',
      kind: 'data_conflict',
      detail: flagged || `the blind reader's description does not support the id (${v.verdict})` +
        (v.suggested_id ? ` — suggests ${v.suggested_id}` : ''),
      looks_like: 'the id and the drawing disagree — the picture is the game, the id is a label somebody typed',
    });
  }
  return out;
}

// One item can trip more than one wire — a piece whose art is disputed usually also fails
// reads_as. They are kept as separate entries because they are separate evidence, but the
// summary counts distinct items so the headline number is "how many things need a look",
// not "how many ways we noticed".
function collectEscalations({ checks, applied, recheck, artVerdicts } = {}) {
  const items = [
    ...fromChecks(checks),
    ...fromUnresolved(applied),
    ...fromRecheck(recheck),
    ...fromArt(artVerdicts),
  ];
  const byKind = {};
  for (const e of items) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    tripped: items.length > 0,
    total: items.length,
    distinct_items: new Set(items.map((e) => e.id)).size,
    by_kind: byKind,
    items,
  };
}

module.exports = { collectEscalations, fromChecks, fromUnresolved, fromRecheck, fromArt };
