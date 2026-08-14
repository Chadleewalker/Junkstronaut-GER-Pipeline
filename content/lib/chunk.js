'use strict';
// Section-aware chunking of the design document.
//
// The rule that shapes this file: a chunk is a unit somebody could cite. §2.2 is a thing
// the document refers to by name — "the commit floor (§2.2)" — so a retrieval hit has to
// come back labelled with the section it came from, and it must never be a fragment that
// starts mid-sentence. Everything else here is in service of that.
//
// Sections are found structurally, not by a list of known headings: a line that is a
// number, or a number-dot-number, followed by a title. The document's tables are indented
// with tabs and its prose paragraphs start with letters, so neither can be mistaken for a
// heading. That matters because the GDD is a living file — Revision 3 renumbered things —
// and a hardcoded table of contents would silently stop matching.
//
// Long sections are split, because §2.2 alone is 6,000 characters and handing a generator
// the whole thing is barely narrower than handing it the document. The split is at sentence
// boundaries inside paragraphs, so a sub-chunk is always whole sentences, and the sub-chunks
// keep the parent's section number with a letter suffix: 2.2a, 2.2b. The section is still
// the addressable unit; the letter only says which part of it answered.

// Top-level headings are written "1. Executive Summary" and sub-headings "2.2 Heat, ...",
// so the trailing dot is optional. Missing it is not a small bug: without it §1 and §3 stop
// being headings, and their bodies get swallowed by whichever numbered sub-section came
// before them — §3's AI architecture filed under "Terminal States & Loss", which is exactly
// the kind of mislabelled citation this whole file exists to prevent.
const HEADING = /^(\d+(?:\.\d+)?)\.?\s+(\S.*?)\s*$/;

// Sentence end followed by the start of another sentence. Conservative on purpose: it
// requires whitespace and a capital-ish opener, so "3,600 kg" and "§2.2" and "~5 s" do not
// split, and a false negative merely produces a slightly longer chunk rather than a
// fragment. Decimal numbers are the real hazard here — "144.7 against 235" must not break.
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z(“"'§*—])/;

const DEFAULTS = {
  maxChars: 1600,   // a section longer than this is split
  targetChars: 1100, // sub-chunks aim for about this
};

// Paragraph units first. The GDD's tables are tab-indented lines and its bullets start with
// "*", and both are meaningful as whole lines — splitting a table row into sentences would
// hand a retriever "empty ship 144.7" with nothing saying what 144.7 is.
function paragraphs(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
}

function sentences(paragraph) {
  // A tab-indented table row or a bullet is one unit, whole. Prose is split.
  if (/^[\t ]/.test(paragraph) || /^\*/.test(paragraph)) return [paragraph];
  return paragraph.split(SENTENCE_END).filter((s) => s.trim().length > 0);
}

// Greedy accumulation to targetChars, never breaking a sentence. Returns array of strings.
function splitBody(body, opts) {
  const units = [];
  for (const p of paragraphs(body)) units.push(...sentences(p));

  const parts = [];
  let buf = [];
  let len = 0;
  for (const u of units) {
    if (len > 0 && len + u.length > opts.targetChars) {
      parts.push(buf.join(' '));
      buf = [];
      len = 0;
    }
    buf.push(u);
    len += u.length + 1;
  }
  if (buf.length) parts.push(buf.join(' '));
  return parts;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// -> [{ id, section, title, part, text, chars }]
//
// `id` is the citation key used everywhere downstream — in the retrieval log, in the
// generator's prompt, in the critic's evidence and on the report page. It is derived from
// the section number rather than from position, so adding a paragraph to §1 does not
// renumber every chunk after it and invalidate a recorded run's citations.
function chunkDocument(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  // The GDD is a CRLF file. Normalising here rather than at every use keeps a stray \r out
  // of chunk text, out of the prompts built from it, and out of the recorded fixtures.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  // -- pass one: cut the document into sections at its headings.
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(HEADING);
    if (m) {
      // The document repeats "4.5 Open, and deliberately not written down as settled" on two
      // consecutive lines. A repeated heading continues the section it repeats rather than
      // opening an empty one, so the duplicate does not become a chunk with no body.
      if (current && current.section === m[1] && current.title === m[2]) continue;
      current = { section: m[1], title: m[2], body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    // Lines before the first heading are the document's own title block. They carry no
    // design content and would score on every query that mentions the game's name.
  }

  // -- pass two: split the long ones.
  const chunks = [];
  for (const s of sections) {
    const body = s.body.join('\n').trim();
    if (!body) continue;
    const parts = body.length > opts.maxChars ? splitBody(body, opts) : [body];
    parts.forEach((part, i) => {
      const suffix = parts.length > 1 ? LETTERS[i] || `p${i + 1}` : '';
      chunks.push({
        id: `${s.section}${suffix}`,
        section: s.section,
        title: s.title,
        part: parts.length > 1 ? i + 1 : null,
        of: parts.length > 1 ? parts.length : null,
        text: part,
        chars: part.length,
      });
    });
  }
  return chunks;
}

module.exports = { chunkDocument, HEADING };
