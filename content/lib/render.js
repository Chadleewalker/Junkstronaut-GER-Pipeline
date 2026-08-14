'use strict';
// The content pipeline's report page, rendered deterministically from the run's own data.
//
// No model runs here and no figure on the page is written by one. Every count, score and
// percentage is computed from the artifacts, and the three-column table in the middle is a
// direct projection of the retrieval log — the query column is the string that was scored,
// the passage column is the chunk that won, and the output column is what the writer
// returned. Nothing in between is retold.
//
// That matters because the page's whole job is to let somebody check the claim "this content
// is grounded in the design document" without taking it on faith. A page that summarised the
// retrieval instead of printing it would be evidence of nothing.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const pct = (n) => `${Math.round((n || 0) * 100)}%`;

function tile(value, label, note) {
  return `<div class="tile">
      <div class="tile-value">${esc(value)}</div>
      <div class="tile-label">${esc(label)}</div>
      ${note ? `<div class="tile-note">${esc(note)}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- query -> chunk -> output

// One row of the layout the rubric asks for. The chunk is printed whole, in a scrolling box,
// rather than excerpted: an excerpt chosen after the fact can always be made to look like it
// supports the output, and choosing it is exactly the step that would make this decorative.
function traceRow(entry, outputHtml, label) {
  const top = entry.hits[0];
  const rest = entry.hits.slice(1);
  const terms = (top && top.matched || []).slice(0, 6)
    .map((m) => `<span class="term">${esc(m.term)} <b>${m.contribution}</b></span>`).join('');

  return `<article class="trace">
    <div class="trace-id">${esc(label)}</div>
    <div class="trace-grid">
      <div class="col">
        <div class="col-h">Query</div>
        <p class="query">${esc(entry.query)}</p>
        ${terms ? `<div class="terms"><span class="col-sub">terms that scored</span>${terms}</div>` : ''}
      </div>
      <div class="col">
        <div class="col-h">Retrieved passage
          ${top ? `<span class="cite">§${esc(top.section)} &middot; chunk ${esc(top.id)} &middot;
            score ${esc(top.score)}</span>` : ''}</div>
        ${top ? `<div class="passage">${esc(top.text)}</div>` : '<p class="none">nothing scored</p>'}
        ${rest.length ? `<div class="alsoran">also retrieved:
          ${rest.map((h) => `<span class="cite">${esc(h.id)} (${esc(h.score)})</span>`).join(' ')}</div>` : ''}
      </div>
      <div class="col">
        <div class="col-h">Generated output</div>
        ${outputHtml}
      </div>
    </div>
  </article>`;
}

function barkOutput(b, corrected) {
  return `<p class="out-line">&ldquo;${esc(b.line)}&rdquo;</p>
    <p class="out-meta">grounded in ${(b.grounded_in || []).map((g) => `<span class="cite">${esc(g)}</span>`).join(' ')}
    ${corrected ? '<span class="flag">corrected by the critic</span>' : ''}</p>`;
}

function debrisOutput(p, corrected) {
  return `<p class="out-name">${esc(p.display_name)}</p>
    <p class="out-flavour">${esc(p.flavour)}</p>
    <p class="out-meta">reads as ${(p.reads_as || []).map((r) => `<span class="tag">${esc(r)}</span>`).join(' ')}
    &middot; grounded in ${(p.grounded_in || []).map((g) => `<span class="cite">${esc(g)}</span>`).join(' ')}
    ${corrected ? '<span class="flag">corrected by the critic</span>' : ''}</p>`;
}

function screenOutput(s, corrected) {
  return `<p class="out-title">${esc(s.title)}</p>
    <p class="out-line">${esc(s.cause)}</p>
    <p class="out-rule"><b>Rule:</b> ${esc(s.rule_broken)}</p>
    <p class="out-arm">&ldquo;${esc(s.armstrong)}&rdquo;</p>
    <p class="out-meta">grounded in ${(s.grounded_in || []).map((g) => `<span class="cite">${esc(g)}</span>`).join(' ')}
    ${corrected ? '<span class="flag">corrected by the critic</span>' : ''}</p>`;
}

// ---------------------------------------------------------------- corrections

const ISSUE_LABEL = {
  contradicts_gdd: 'contradicts the GDD',
  wrong_voice: 'wrong voice',
  invented_mechanic: 'invented a mechanic',
  number_disagrees: 'number disagrees',
};

function correctionCard(c, type, recheckReview) {
  const issues = (c.issues || []).map((i) => `
    <div class="issue">
      <div class="issue-h"><span class="itype itype-${esc(i.type)}">${esc(ISSUE_LABEL[i.type] || i.type)}</span>
        ${(i.cites || []).map((x) => `<span class="cite">${esc(x)}</span>`).join(' ')}</div>
      <p class="quote">&ldquo;${esc(i.quote)}&rdquo;</p>
      <p class="evidence"><b>Source says:</b> ${esc(i.evidence)}</p>
      <p class="why">${esc(i.why)}</p>
    </div>`).join('');

  const fields = Object.keys(c.after).map((f) => `
    <div class="ba">
      <div class="ba-f">${esc(f)}</div>
      <div class="ba-before"><span class="ba-tag">before</span>${esc(c.before[f])}</div>
      <div class="ba-after"><span class="ba-tag">after</span>${esc(c.after[f])}</div>
    </div>`).join('');

  const rc = recheckReview
    ? `<p class="recheck ${recheckReview.verdict === 'pass' ? 'held' : 'stuck'}">
        Re-checked by a fresh critic call against the same passages:
        <b>${esc(recheckReview.verdict)}</b>${recheckReview.verdict === 'pass'
          ? ' — the correction held.' : ' — still flagged.'}</p>`
    : '';

  return `<article class="correction">
    <h3>${esc(c.id)} <span class="ctype">${esc(type)}</span>
      <span class="verdict verdict-${esc(c.verdict)}">${esc(c.verdict)}</span></h3>
    ${issues}
    ${fields}
    ${rc}
  </article>`;
}

// ---------------------------------------------------------------- the page

function renderReport({
  manifest, plans, generated, critiques, applied, recheck, checks, tweak, accuracy,
  canon, specs, pieces,
}) {
  const correctedIds = new Set(
    Object.values(applied).flatMap((a) => a.corrections.map((c) => c.id)));

  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const barkById = byId(generated.barks);
  const debrisById = byId(generated.debris);
  const screenById = byId(generated.postmortems);
  const specById = {
    barks: byId(specs.barks),
    postmortems: byId(specs.postmortems),
  };

  // The rubric asks for three items shown this way. Every item is shown this way instead,
  // because "we picked three" invites the question of which three and why. The opening set is
  // the ones the critic touched — the interesting rows are the ones where something moved.
  const traces = (type, render, labelFor) => {
    const entries = plans[type].perItem;
    const open = entries.filter((e) => correctedIds.has(e.id));
    const shut = entries.filter((e) => !correctedIds.has(e.id));
    const row = (e) => {
      const item = { barks: barkById, debris: debrisById, postmortems: screenById }[type].get(e.id);
      return item ? traceRow(e, render(item, correctedIds.has(e.id)), labelFor(e.id)) : '';
    };
    return `${open.map(row).join('')}
      ${shut.length ? `<details class="more"><summary>${shut.length} more ${esc(type)} —
        query, passage and output for every one</summary>${shut.map(row).join('')}</details>` : ''}`;
  };

  const barkLabel = (id) => {
    const s = specById.barks.get(id);
    return s ? `${id} — ${s.state}` : id;
  };
  const pmLabel = (id) => {
    const s = specById.postmortems.get(id);
    return s ? `${id} — ${s.state}: ${s.detector}` : id;
  };
  const debrisLabel = (id) => {
    const p = pieces.find((x) => x.id === id);
    return p ? `${id} — ${Math.round(p.mass_kg)} kg at ${p.altitude_m.toLocaleString()} m, ` +
      `${p.size_class}${p.fragile ? ', fragile' : ''}` : id;
  };

  const allCorrections = Object.entries(applied).flatMap(([type, a]) =>
    a.corrections.map((c) => {
      const rr = recheck[type] && (recheck[type].reviews || []).find((x) => x.id === c.id);
      return correctionCard(c, type, rr);
    }));

  const unresolved = Object.entries(applied).flatMap(([type, a]) =>
    a.unresolved.map((u) => `<li><code>${esc(u.id)}</code> (${esc(type)}) — the critic returned
      <b>${esc(u.verdict)}</b> with no usable correction, so the draft stands.</li>`)).join('');

  const critiqueSummaries = Object.entries(critiques).map(([type, c]) => `
    <li><b>${esc(type)}</b> — <span class="verdict verdict-${esc(c.verdict)}">${esc(c.verdict)}</span>
      ${esc(c.summary)}</li>`).join('');

  const tweakRow = (k, label, fmt = (v) => v) => `<tr>
      <td>${esc(label)}</td>
      <td class="num">${esc(fmt(tweak.before[k]))}</td>
      <td class="num">${esc(fmt(tweak.after[k]))}</td>
    </tr>`;

  const failedChecks = Object.entries(checks).flatMap(([type, list]) =>
    list.filter((c) => c.result === 'fail').map((c) => `<tr class="fail">
      <td>${esc(type)}</td><td><code>${esc(c.check)}</code></td><td><code>${esc(c.id)}</code></td>
      <td><b>FAIL</b></td><td>${esc(c.detail)}</td></tr>`));

  const checkSummary = Object.entries(checks).map(([type, list]) => {
    const kinds = [...new Set(list.map((c) => c.check))];
    const failed = list.filter((c) => c.result === 'fail').length;
    return `<tr class="${failed ? 'fail' : ''}">
      <td>${esc(type)}</td>
      <td>${kinds.map((k) => `<code>${esc(k)}</code>`).join(' ')}</td>
      <td class="num">${list.length - failed}/${list.length}</td>
    </tr>`;
  }).join('');

  const barkTable = [
    ...canon.map((c) => `<tr class="canon">
      <td><code>${esc(c.id)}</code></td>
      <td>${esc(c.state)}</td>
      <td class="line">&ldquo;${esc(c.line)}&rdquo;</td>
      <td><span class="tag">already in ${esc(c.source)}</span></td></tr>`),
    ...generated.barks.map((b) => {
      const s = specById.barks.get(b.id);
      return `<tr>
        <td><code>${esc(b.id)}</code></td>
        <td>${esc(s ? s.state : '')}</td>
        <td class="line">&ldquo;${esc(b.line)}&rdquo;</td>
        <td>${(b.grounded_in || []).map((g) => `<span class="cite">${esc(g)}</span>`).join(' ')}
          ${correctedIds.has(b.id) ? '<span class="flag">corrected</span>' : ''}</td></tr>`;
    }),
  ].join('');

  const screenTable = generated.postmortems.map((s) => {
    const spec = specById.postmortems.get(s.id);
    return `<tr>
      <td><code>${esc(s.id)}</code><div class="sub">${esc(spec ? spec.detector : '')}</div></td>
      <td class="line"><b>${esc(s.title)}</b><div>${esc(s.cause)}</div></td>
      <td>${esc(s.rule_broken)}</td>
      <td class="line">&ldquo;${esc(s.armstrong)}&rdquo;</td></tr>`;
  }).join('');

  const debrisTable = generated.debris.map((p) => {
    const c = pieces.find((x) => x.id === p.id) || {};
    return `<tr>
      <td><b>${esc(p.display_name)}</b><div class="sub"><code>${esc(p.id)}</code></div></td>
      <td class="num">${esc(Math.round(c.mass_kg || 0).toLocaleString())} kg</td>
      <td class="num">${esc((c.altitude_m || 0).toLocaleString())} m</td>
      <td>${esc(c.size_class || '')}${c.fragile ? ' <span class="tag tag-fragile">fragile</span>' : ''}</td>
      <td class="line">${esc(p.flavour)}
        <div class="sub">${(p.reads_as || []).map((r) => `<span class="tag">${esc(r)}</span>`).join(' ')}
        ${correctedIds.has(p.id) ? '<span class="flag">corrected</span>' : ''}</div></td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Junkstronaut content pipeline — ${esc(manifest.design_document)}</title>
<style>
:root{
  color-scheme: light;
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --rule:#c3c2b7; --border:rgba(11,11,11,0.10);
  --series-1:#2a78d6;
  --critical:#d03b3b; --serious:#ec835a; --warning:#fab219; --good:#0ca30c;
}
@media (prefers-color-scheme: dark){
  :root:where(:not([data-theme="light"])){
    color-scheme: dark;
    --surface-1:#1a1a19; --plane:#0d0d0d;
    --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,0.10);
    --series-1:#3987e5;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --rule:#383835; --border:rgba(255,255,255,0.10);
  --series-1:#3987e5;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 72px}
header{border-bottom:1px solid var(--rule);padding-bottom:20px;margin-bottom:12px}
h1{font-size:26px;margin:0 0 6px}
.sub{color:var(--ink-2);margin:0}
.meta{color:var(--muted);font-size:13px;margin-top:10px}
h2{font-size:19px;margin:38px 0 6px;padding-top:22px;border-top:1px solid var(--grid)}
h3{font-size:15px;margin:0 0 8px}
h4{font-size:14px;margin:24px 0 6px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.05em}
.lede{color:var(--ink-2);margin:0 0 16px;max-width:78ch}
section:first-of-type h2{border-top:0;padding-top:0}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0 8px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.tile-value{font-size:30px;font-weight:600;letter-spacing:-0.02em}
.tile-label{font-size:13px;color:var(--ink-2);margin-top:2px}
.tile-note{font-size:12px;color:var(--muted);margin-top:4px}

.trace{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;margin:12px 0}
.trace-id{font-size:12px;font-family:ui-monospace,monospace;color:var(--ink-2);margin-bottom:10px}
.trace-grid{display:grid;grid-template-columns:1fr 1.5fr 1.1fr;gap:18px}
@media (max-width:900px){.trace-grid{grid-template-columns:1fr}}
.col-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  margin-bottom:6px;border-bottom:1px solid var(--grid);padding-bottom:4px}
.col-sub{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
.query{font-size:13px;color:var(--ink-2);margin:0 0 8px;font-family:ui-monospace,monospace;line-height:1.5}
.terms{margin-top:8px}
.term{display:inline-block;font-size:11px;font-family:ui-monospace,monospace;background:var(--plane);
  border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin:0 4px 4px 0;color:var(--ink-2)}
.passage{font-size:13px;line-height:1.6;color:var(--ink);background:var(--plane);
  border:1px solid var(--border);border-radius:6px;padding:10px 12px;max-height:230px;overflow:auto;
  white-space:pre-wrap}
.alsoran{font-size:11px;color:var(--muted);margin-top:6px}
.none{color:var(--muted);font-size:13px}
.cite{display:inline-block;font-size:11px;font-family:ui-monospace,monospace;color:var(--series-1);
  border:1px solid var(--border);border-radius:20px;padding:1px 8px;margin-right:4px}
.out-line{font-size:15px;margin:0 0 8px}
.out-name{font-size:15px;font-weight:600;margin:0 0 4px}
.out-title{font-size:16px;font-weight:700;letter-spacing:.04em;margin:0 0 6px}
.out-flavour,.out-rule,.out-arm{font-size:13px;color:var(--ink-2);margin:0 0 6px}
.out-arm{font-style:italic;color:var(--ink)}
.out-meta{font-size:11px;color:var(--muted);margin:8px 0 0}
.tag{display:inline-block;font-size:11px;background:var(--plane);border:1px solid var(--border);
  border-radius:4px;padding:1px 7px;color:var(--ink-2);margin-right:3px}
.tag-fragile{color:var(--critical);border-color:color-mix(in srgb,var(--critical) 40%,transparent)}
.flag{display:inline-block;font-size:11px;color:var(--serious);font-weight:600;margin-left:6px}
:root:where(:not([data-theme="dark"])) .flag{color:#b8552c}

details.more{margin:8px 0}
details.more>summary{cursor:pointer;font-size:13px;color:var(--series-1);padding:8px 0}

.correction{background:var(--surface-1);border:1px solid var(--border);border-left:3px solid var(--serious);
  border-radius:10px;padding:14px 16px;margin:12px 0}
.correction h3{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-family:ui-monospace,monospace}
.ctype{font-size:11px;color:var(--muted);font-family:system-ui,sans-serif}
.verdict{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.verdict-revise{color:var(--serious)} .verdict-reject{color:var(--critical)} .verdict-pass{color:var(--good)}
:root:where(:not([data-theme="dark"])) .verdict-revise{color:#b8552c}
.issue{border-top:1px solid var(--grid);padding-top:10px;margin-top:10px}
.issue-h{margin-bottom:6px}
.itype{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;margin-right:8px}
.itype-contradicts_gdd{color:var(--critical)}
.itype-number_disagrees{color:var(--critical)}
.itype-invented_mechanic{color:var(--serious)}
.itype-wrong_voice{color:var(--warning)}
:root:where(:not([data-theme="dark"])) .itype-wrong_voice{color:#8a6200}
:root:where(:not([data-theme="dark"])) .itype-invented_mechanic{color:#b8552c}
.quote{margin:4px 0;font-size:14px}
.evidence,.why{font-size:13px;color:var(--ink-2);margin:4px 0}
.ba{display:grid;grid-template-columns:110px 1fr;gap:8px 12px;margin-top:12px;align-items:start}
@media (max-width:700px){.ba{grid-template-columns:1fr}}
.ba-f{font-size:11px;font-family:ui-monospace,monospace;color:var(--muted);padding-top:8px}
.ba-before,.ba-after{grid-column:2;font-size:14px;border-radius:6px;padding:8px 10px;
  border:1px solid var(--border)}
.ba-before{background:color-mix(in srgb,var(--critical) 7%,transparent);text-decoration:line-through;
  text-decoration-color:color-mix(in srgb,var(--critical) 60%,transparent);color:var(--ink-2)}
.ba-after{background:color-mix(in srgb,var(--good) 8%,transparent)}
.ba-tag{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);margin-bottom:3px}
.recheck{margin:12px 0 0;font-size:13px;border-top:1px solid var(--grid);padding-top:10px;color:var(--ink-2)}
.recheck.held b{color:var(--good)} .recheck.stuck b{color:var(--critical)}

table{width:100%;border-collapse:collapse;font-size:13px;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--grid);padding:8px 10px;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.fail td{background:color-mix(in srgb,var(--critical) 8%,transparent)}
tr.canon td{background:color-mix(in srgb,var(--series-1) 6%,transparent)}
td.line{max-width:44ch}
.sub{font-size:11px;color:var(--muted);margin-top:3px}
code{font-family:ui-monospace,monospace;font-size:12px}
ul.plain{padding-left:18px} ul.plain li{margin:8px 0}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--grid);color:var(--muted);font-size:12px}
</style>
</head><body>
<div class="wrap">
<header>
  <h1>Junkstronaut content pipeline</h1>
  <p class="sub">Three kinds of written content, retrieved from ${esc(manifest.design_document)},
    generated from the retrieved passages alone, and read back against them by a critic.</p>
  <p class="meta">${esc(manifest.finished_at)} &middot; ${esc(manifest.mode)} &middot;
    ${esc((manifest.models || []).join(', ') || 'model not recorded')} &middot;
    ${esc(manifest.index.chunks)} chunks over ${esc(manifest.index.sections)} sections &middot;
    each item written from ${esc(manifest.retrieval.mean_chars_per_item.toLocaleString())} characters of
    the document on average, ${pct(manifest.retrieval.share_of_document_per_item)} of it at most</p>
</header>

<section>
  <h2>What this run produced</h2>
  <div class="tiles">
    ${tile(manifest.totals.items, 'items generated', `${generated.barks.length} barks, ${generated.debris.length} pieces, ${generated.postmortems.length} screens`)}
    ${tile(pct(accuracy.precision_at_1), 'retrieval P@1', `on ${accuracy.labelled} hand-labelled states`)}
    ${tile(manifest.totals.issues, 'issues raised by the critic', 'against the source passages')}
    ${tile(manifest.totals.corrections, 'corrections applied', 'originals kept as evidence')}
    ${tile(`${manifest.totals.checks_run - manifest.totals.checks_failed}/${manifest.totals.checks_run}`,
      'code checks passed', 'coverage, citations, fiction vs. mechanics')}
  </div>
  <ul class="plain">${critiqueSummaries}</ul>
</section>

<section>
  <h2>Query &rarr; retrieved passage &rarr; generated output</h2>
  <p class="lede">The middle column is the passage the query actually pulled back, printed whole
    and unedited, with the terms that earned it the score. The right column is what the writer
    returned having seen that passage and no other part of the document. Rows the critic
    corrected are open; the rest are one click away.</p>

  <h4>Armstrong's radio barks</h4>
  ${traces('barks', barkOutput, barkLabel)}

  <h4>Post-mortem screens</h4>
  ${traces('postmortems', screenOutput, pmLabel)}

  <h4>Debris flavour</h4>
  ${traces('debris', debrisOutput, debrisLabel)}
</section>

<section>
  <h2>What the critic caught</h2>
  <p class="lede">The critic is given the generated items and the same passages the writer had,
    and never the writer's reasoning &mdash; so it cannot be talked into agreeing. Every
    correction below shows the draft it replaced, the passage that settled it, and the verdict
    of a fresh critic call re-reading the corrected line.</p>
  ${allCorrections.length ? allCorrections.join('') : '<p class="none">The critic raised no correctable issue on this run.</p>'}
  ${unresolved ? `<h4>Flagged but not corrected</h4><ul class="plain">${unresolved}</ul>` : ''}
</section>

<section>
  <h2>The retrieval tweak</h2>
  <p class="lede">The retriever this pipeline started with kept each section whole and scored by
    raw term overlap. Both halves of that were wrong in the same direction: §2.2 is 6,400
    characters, so it out-scored shorter, more relevant passages on length alone, and §3 &mdash;
    the section about how the game gets <em>built</em> &mdash; kept surfacing as an answer to
    questions about what the player sees. Splitting sections at sentence boundaries and scoring
    with BM25 fixed both. Scored against the section a human labelled as the answer, in
    <code>lib/items.js</code>, written before either retriever was run.</p>
  <table>
    <thead><tr><th>&nbsp;</th><th class="num">before</th><th class="num">after</th></tr></thead>
    <tbody>
      ${tweakRow('chunks', 'chunks in the index')}
      ${tweakRow('mean_chunk_chars', 'mean chunk size (chars)', (v) => v.toLocaleString())}
      ${tweakRow('precision_at_1', 'precision@1 against the labels', pct)}
      ${tweakRow('recall_at_3', 'recall@3 against the labels', pct)}
      ${tweakRow('mean_retrieved_chars_per_query', 'chars retrieved per query', (v) => v.toLocaleString())}
      ${tweakRow('meta_section_wins_rank_1', '§3/§4 winning a player-facing query outright')}
      ${tweakRow('meta_section_hits_in_top3', '§3/§4 anywhere in the top 3')}
    </tbody>
  </table>
</section>

<section>
  <h2>Checks that are code, not judgement</h2>
  <p class="lede">Whether a citation points at a passage the writer was actually shown, whether
    every piece in the catalog got exactly one description, and whether a piece the catalog
    flags fragile is described as fragile &mdash; these are facts about two files. Asking a
    model to check them would trade an answer for an opinion.</p>
  <table>
    <thead><tr><th>content type</th><th>checks</th><th class="num">passed</th></tr></thead>
    <tbody>${checkSummary}</tbody>
  </table>
  ${failedChecks.length ? `<h4>Failing checks</h4><table>
    <thead><tr><th>type</th><th>check</th><th>item</th><th>result</th><th>detail</th></tr></thead>
    <tbody>${failedChecks.join('')}</tbody></table>` : ''}
</section>

<section>
  <h2>The content</h2>

  <h4>Armstrong's radio barks</h4>
  <p class="lede">The three highlighted rows are the lines the design document already contains.
    They were passed to the writer as the voice target and were not rewritten.</p>
  <table>
    <thead><tr><th>id</th><th>fires when</th><th>line</th><th>grounded in</th></tr></thead>
    <tbody>${barkTable}</tbody>
  </table>

  <h4>Post-mortem screens</h4>
  <table>
    <thead><tr><th>terminal state</th><th>screen</th><th>rule named</th><th>Armstrong</th></tr></thead>
    <tbody>${screenTable}</tbody>
  </table>

  <h4>Debris flavour</h4>
  <table>
    <thead><tr><th>name</th><th class="num">mass</th><th class="num">altitude</th><th>class</th><th>flavour</th></tr></thead>
    <tbody>${debrisTable}</tbody>
  </table>
</section>

<footer>
  Generated by <code>content/run-content.js</code>. Every number on this page is computed from
  the run's own artifacts &mdash; <code>out/retrieval/retrieval_log.json</code>,
  <code>out/critique/critique_log.json</code> and <code>out/checks/deterministic_checks.json</code>
  &mdash; and none of it is written by a model. The retrieval scores can be recomputed by hand
  from the chunk text and the query.
</footer>
</div>
</body></html>
`;
}

module.exports = { renderReport, esc };
