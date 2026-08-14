'use strict';
// Deterministic checks on generated content — the ones a model should never be asked to do.
//
// The critic is an agent because judging voice and lore requires reading. These are not that.
// "Did it cite a chunk that exists", "did it cover every piece exactly once", "does a piece
// the catalog flags fragile actually read as fragile" — each is a fact about two files, and
// asking a model to check a fact about two files is how a pipeline acquires an opinion where
// it could have had an answer.
//
// This is the same split the tuning crew runs on: the schema gate is code, the audit is an
// agent, and neither does the other's job. What is new here is `reads_as`, which only works
// because the flavourist was made to DECLARE what it was going for. A free-text description
// cannot be checked against a mass in kilograms; a declaration can, and the declaration is
// only worth anything because the words have to earn it in front of the critic.

function ok(id, check, detail) {
  return { id, check, result: 'pass', detail };
}
function bad(id, check, detail) {
  return { id, check, result: 'fail', detail };
}

// Every cited chunk id must exist in the index, and must have been retrieved for that item
// (or pooled into the prompt at all). A citation to a passage the writer was never shown is
// not a small error: it is the pipeline claiming grounding it did not have.
function checkCitations(items, planEntries, poolIds) {
  const out = [];
  const byId = new Map(planEntries.map((p) => [p.id, new Set(p.hits.map((h) => h.id))]));
  for (const item of items) {
    const cited = item.grounded_in || [];
    const own = byId.get(item.id) || new Set();
    const unknown = cited.filter((c) => !poolIds.has(c));
    const offPlan = cited.filter((c) => poolIds.has(c) && !own.has(c));
    if (unknown.length) {
      out.push(bad(item.id, 'citations_exist',
        `cites ${unknown.join(', ')}, which ${unknown.length > 1 ? 'were' : 'was'} never in the prompt`));
    } else if (offPlan.length) {
      // Not a failure. The pool is shared, so a bark may legitimately rest on a passage
      // another state retrieved — but it is worth recording which, because a citation that
      // never comes from the item's own retrieval means the query for that item is missing
      // something the writer needed.
      out.push(ok(item.id, 'citations_exist',
        `${cited.join(', ')} — ${offPlan.join(', ')} came from the shared pool, not this item's own retrieval`));
    } else {
      out.push(ok(item.id, 'citations_exist', cited.join(', ')));
    }
  }
  return out;
}

// Exactly the ids that were asked for, each exactly once.
function checkCoverage(items, expectedIds, label) {
  const got = items.map((i) => i.id);
  const seen = new Set();
  const dupes = got.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  const missing = expectedIds.filter((id) => !seen.has(id));
  const extra = got.filter((id) => !expectedIds.includes(id));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (extra.length) problems.push(`invented ${extra.join(', ')}`);
  if (dupes.length) problems.push(`duplicated ${[...new Set(dupes)].join(', ')}`);
  return problems.length
    ? [bad(label, 'coverage', problems.join('; '))]
    : [ok(label, 'coverage', `${got.length} of ${expectedIds.length}, no duplicates, no inventions`)];
}

// The constraint the debris content type exists to satisfy: fiction must match mechanics.
//
// Checked against the catalog rather than against the text, so this cannot be satisfied by
// writing more confidently. A piece the catalog flags fragile must have claimed `fragile`;
// a piece in the top third of the band must not have claimed `low`; and so on.
// `artVerdicts` is optional and never changes an outcome — a failing check still fails. It only
// attributes one, and that distinction is the whole reason it is here.
//
// The `fragile` flag belongs to a piece's id, and the art audit exists because some of those ids
// are wrong. `torn_foil_blanket` is flagged fragile, which is right for foil; its sprite is a
// cracked steel plate, which is not fragile at all. The writer described the plate — correctly —
// and could not honestly claim `fragile`. So the check fails on a piece where the writing is right,
// the check is right, and the DATA is wrong. Retrying the writer cannot fix that; it can only make
// it lie. The failure stands, says which conflict it came from, and a human reconciles the table.
function checkReadsAs(pieces, catalogById, band, artVerdicts = null) {
  const out = [];
  const disputed = new Map((artVerdicts || [])
    .filter((v) => v.verdict !== 'match')
    .map((v) => [v.id, v]));
  // The size vocabulary comes from the catalog, never from a list written here. The catalog
  // calls its top class `oversized`, and a hardcoded `small|medium|large` failed three pieces
  // for describing an oversized dish as large — a finding about this file, not about the
  // writing. Reading the vocabulary from the data means a catalog that renames a class
  // renames it here too.
  const sizeWords = new Set([...catalogById.values()].map((c) => c.size_class).filter(Boolean));
  for (const p of pieces) {
    const c = catalogById.get(p.id);
    if (!c) continue; // coverage check already reported this
    const claim = new Set(p.reads_as || []);
    const f = (c.altitude_m - band.min) / (band.max - band.min);
    const problems = [];

    if (c.fragile && !claim.has('fragile')) {
      problems.push('catalog says fragile, reads_as does not claim it');
    }
    if (!c.fragile && claim.has('fragile')) {
      problems.push('reads_as claims fragile, catalog says it is not');
    }
    // Thirds, not halves — because thirds is the vocabulary the writer's own prompt uses. When
    // this checked halves and the prompt said thirds, three pieces in the middle third were
    // tagged `low` by a writer that had been told they were in the middle, and the check passed
    // them. Two scales for one quantity is how a gate agrees with the wrong thing.
    if (claim.has('low') && f >= 1 / 3) {
      problems.push(`claims low at ${c.altitude_m.toLocaleString()} m, which is not the bottom third of the band`);
    }
    if (claim.has('high') && f < 2 / 3) {
      problems.push(`claims high at ${c.altitude_m.toLocaleString()} m, which is not the top third of the band`);
    }
    if (claim.has('light') && claim.has('heavy')) problems.push('claims both light and heavy');
    if (claim.has('low') && claim.has('high')) problems.push('claims both low and high');
    // Size is optional to claim, because plenty of good flavour never mentions it. Only a
    // wrong size claim is a problem.
    const wrongSize = [...sizeWords].filter((s) => claim.has(s) && s !== c.size_class);
    if (wrongSize.length) problems.push(`claims ${wrongSize.join('/')}, catalog says ${c.size_class}`);

    // Where the art audit disputes this piece's id, say so on the failure. A reader seeing
    // "catalog says fragile, reads_as does not claim it" has no way to tell a careless writer
    // from a table that disagrees with its own artwork, and those need opposite responses.
    const d = disputed.get(p.id);
    if (problems.length && d) {
      problems.push(
        `the art audit disputes this piece's id (${d.verdict}${d.suggested_id ? ` — suggests ${d.suggested_id}` : ''}), ` +
        'so the flag may belong to a name the sprite does not support — reconcile the catalogue rather than the writing');
    }

    out.push(problems.length
      ? bad(p.id, 'reads_as_matches_mechanics', problems.join('; '))
      : ok(p.id, 'reads_as_matches_mechanics',
        `${[...claim].join(', ') || 'no claim'} against ${Math.round(c.mass_kg)} kg at ` +
        `${c.altitude_m.toLocaleString()} m, ${c.size_class}${c.fragile ? ', fragile' : ''}`));
  }
  return out;
}

// A named heaviest/highest piece must not be describable as light, and vice versa — the
// brief's own example. Reported separately because it is the check a reader will look for.
function checkExtremes(pieces, catalog, band) {
  const byMass = catalog.slice().sort((a, b) => b.mass_kg - a.mass_kg);
  const heaviest = byMass[0];
  const lightest = byMass[byMass.length - 1];
  const out = [];
  for (const [c, want, other] of [[heaviest, 'heavy', 'light'], [lightest, 'light', 'heavy']]) {
    const p = pieces.find((x) => x.id === c.id);
    if (!p) continue;
    const claim = new Set(p.reads_as || []);
    out.push(claim.has(want) && !claim.has(other)
      ? ok(c.id, 'extreme_reads_right',
        `${Math.round(c.mass_kg)} kg is the ${want === 'heavy' ? 'heaviest' : 'lightest'} piece and reads ${want}`)
      : bad(c.id, 'extreme_reads_right',
        `${Math.round(c.mass_kg)} kg is the ${want === 'heavy' ? 'heaviest' : 'lightest'} piece; reads_as is ` +
        `${[...claim].join(', ') || 'empty'}`));
  }
  return out;
}

// Retrieval accuracy against the hand-written `expect` labels in lib/items.js. Precision@1 is
// "did the top passage come from the section a human says answers this", and it is the number
// the retrieval tweak moved.
function scoreRetrieval(planEntries) {
  const labelled = planEntries.filter((p) => p.expect && p.expect.length);
  let top1 = 0;
  let top3 = 0;
  const misses = [];
  for (const p of labelled) {
    const secs = p.hits.map((h) => h.section);
    if (p.expect.includes(secs[0])) top1++;
    else misses.push({ id: p.id, expected: p.expect, got: p.hits.map((h) => h.id) });
    if (secs.some((s) => p.expect.includes(s))) top3++;
  }
  return {
    labelled: labelled.length,
    precision_at_1: labelled.length ? Number((top1 / labelled.length).toFixed(3)) : null,
    recall_at_k: labelled.length ? Number((top3 / labelled.length).toFixed(3)) : null,
    misses,
  };
}

module.exports = {
  checkCitations,
  checkCoverage,
  checkReadsAs,
  checkExtremes,
  scoreRetrieval,
};
