'use strict';
// Turning a retrieval into a prompt.
//
// The shape here is the load-bearing decision of the whole pipeline, so it is worth stating
// plainly. Every item gets its OWN retrieval, but the passages are printed ONCE, in a shared
// block, and each item lists the chunk ids it retrieved.
//
//   --- SOURCE PASSAGES ---
//   [2.2d] §2.2 Heat, Staging, Braking Passes ...
//   [2.4a] §2.4 The Hand Magnet & Towing ...
//
//   --- STATES TO WRITE ---
//   3. hold_mass_amber
//      retrieved: 2.4a (57.1), 2.4b (12.3)
//
// The alternative — repeating each item's passages under that item — was tried first and is
// the reason this file exists. Eighteen bark states retrieving three passages each printed
// §2.2 nine times and ran the prompt to 40,000 characters, which is most of the design
// document. At that size "grounded in retrieved passages" stops being different from "given
// the whole GDD", and the assignment's central claim quietly stops being true.
//
// Printing once and citing by id keeps the prompt at a fraction of the document AND keeps
// per-item traceability exact: the report's query -> chunk -> output columns read straight
// off the same structure the model was given, not a reconstruction of it.

const { retrieve } = require('./retrieve');

// -> { perItem: [{ id, query, hits }], voice, pool: [chunk], chars }
//
// `pool` is the deduplicated union in document order, which is also the order they are
// printed — so a passage's neighbours in the prompt are its neighbours in the document, and
// the generator is not silently handed a shuffled deck.
function plan(index, items, { k = 3, voiceQuery = null, voiceK = 2 } = {}) {
  const perItem = items.map((it) => {
    const r = retrieve(index, it.query, { k });
    return { id: it.id, query: it.query, expect: it.expect || null, hits: r.hits, terms: r.terms };
  });

  const voice = voiceQuery
    ? { id: '__voice__', query: voiceQuery, expect: null, ...retrieve(index, voiceQuery, { k: voiceK }) }
    : null;

  const wanted = new Set();
  for (const p of perItem) for (const h of p.hits) wanted.add(h.id);
  if (voice) for (const h of voice.hits) wanted.add(h.id);

  const pool = index.chunks.filter((c) => wanted.has(c.id));
  return { perItem, voice, pool, chars: pool.reduce((a, c) => a + c.chars, 0) };
}

function sourceBlock(pool) {
  return pool
    .map((c) => `[${c.id}] §${c.section} ${c.title}${c.of ? ` (part ${c.part} of ${c.of})` : ''}\n${c.text}`)
    .join('\n\n');
}

// `describe` turns one item into its human-readable lines; this function adds the retrieval
// trace. Scores are printed because a low top score is information the generator can act on:
// it means the document is thin here, and the right response is to write less rather than to
// invent more.
function itemBlock(perItem, describe) {
  return perItem
    .map((p, i) => {
      const cites = p.hits.map((h) => `${h.id} (${h.score})`).join(', ') || 'nothing scored';
      return `${i + 1}. ${describe(p.id)}\n   retrieved for this item: ${cites}`;
    })
    .join('\n\n');
}

module.exports = { plan, sourceBlock, itemBlock };
