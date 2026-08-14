'use strict';
// The art review page: every piece's sprite beside the words written for it, and the verdict on
// whether the two are describing the same object.
//
// Sprites are embedded as data URIs and scaled with `image-rendering: pixelated`, so the page is
// self-contained and the pixel art stays crisp. That also means THIS FILE PRODUCES A PAGE THAT
// CONTAINS THE ART: a base64 sprite is the same bytes as the PNG, so wherever the pack's licence
// forbids redistribution, the output of this renderer is covered by that too. The orchestrator
// only calls it when an art directory was actually supplied.

const fs = require('fs');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LABEL = { match: 'art matches', loose: 'loose fit', mismatch: 'art disagrees' };

/**
 * @param {object[]} items  { id, display_name, flavour, spriteFile, mass_kg, altitude_m,
 *                            size_class, fragile, verdict, why, evidence, suggested_id,
 *                            flag_for_human, depicts, detail, legible }
 */
function renderArtReview(items, { generatedAt, catalogPath, artDir, embedSprites = true } = {}) {
  const band = {
    min: Math.min(...items.map((p) => p.altitude_m)),
    max: Math.max(...items.map((p) => p.altitude_m)),
  };
  const counts = { match: 0, loose: 0, mismatch: 0 };
  for (const p of items) counts[p.verdict] = (counts[p.verdict] || 0) + 1;

  const rows = items.map((p) => {
    // With sprites omitted the cell still has to carry something, and the honest something is the
    // blind reader's own words — which is what the verdict was decided on anyway. A reader without
    // the pictures can still follow every finding; they just cannot second-guess the reading.
    const chip = embedSprites
      ? `<img src="data:image/png;base64,${fs.readFileSync(p.spriteFile).toString('base64')}" alt="${esc(p.display_name || p.id)}">`
      : `<span class="stand-in">${esc(p.depicts || 'sprite')}</span>`;
    const pos = band.max === band.min ? 50 : ((p.altitude_m - band.min) / (band.max - band.min)) * 100;
    return `
  <article class="piece" data-verdict="${p.verdict}">
    <div class="rail"></div>
    <div class="chip${embedSprites ? '' : ' chip-empty'}">${chip}</div>
    <div class="text">
      <h2>${esc(p.display_name || p.id)}</h2>
      <p class="ids"><code>${esc(p.id)}</code></p>
      <p class="flavour">${esc(p.flavour || '—')}</p>
      <p class="read"><span class="k">Read blind as</span> ${esc(p.depicts || '—')}${p.legible && p.legible !== 'clear' ? ` <em>(${esc(p.legible)})</em>` : ''}${p.detail ? ` &mdash; ${esc(p.detail)}` : ''}</p>
      <p class="drawn"><span class="tag tag-${p.verdict}">${LABEL[p.verdict]}</span>${p.why ? ' ' + esc(p.why) : ''}</p>
      ${p.suggested_id ? `<p class="sug"><span class="k">Suggested id</span> <code>${esc(p.suggested_id)}</code></p>` : ''}
      ${p.flag_for_human ? `<p class="flag"><span class="k">For a human</span> ${esc(p.flag_for_human)}</p>` : ''}
    </div>
    <dl class="mech">
      <div><dt>Mass</dt><dd>${p.mass_kg.toLocaleString()}<span class="u">kg</span></dd></div>
      <div><dt>Altitude</dt><dd>${Math.round(p.altitude_m / 1000)}<span class="u">km</span></dd></div>
      <div><dt>Class</dt><dd class="w">${esc(p.size_class)}</dd></div>
      <div><dt>Fragile</dt><dd class="w ${p.fragile ? 'yes' : 'no'}">${p.fragile ? 'yes' : 'no'}</dd></div>
      <div class="bandwrap"><dt>Band</dt><dd class="band"><span style="left:${pos.toFixed(1)}%"></span></dd></div>
    </dl>
  </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Junkstronaut — debris sprites against their text</title>
<style>
:root {
  --bg:#15171b; --panel:#1b1e24; --panel-2:#202430; --line:#2c313a;
  --ink:#dde0e5; --ink-dim:#949aa4; --ink-faint:#6d737d;
  --green:#7c9e63; --amber:#d8992c; --red:#c6503a; --void:#3a3d45;
  --mono: ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#eae8e3; --panel:#f7f6f3; --panel-2:#efede8; --line:#d5d2cb;
    --ink:#24272c; --ink-dim:#61666e; --ink-faint:#878c94;
    --green:#55763f; --amber:#a8701a; --red:#a83a24; }
}
:root[data-theme="dark"] { --bg:#15171b; --panel:#1b1e24; --panel-2:#202430; --line:#2c313a;
  --ink:#dde0e5; --ink-dim:#949aa4; --ink-faint:#6d737d;
  --green:#7c9e63; --amber:#d8992c; --red:#c6503a; }
:root[data-theme="light"] { --bg:#eae8e3; --panel:#f7f6f3; --panel-2:#efede8; --line:#d5d2cb;
  --ink:#24272c; --ink-dim:#61666e; --ink-faint:#878c94;
  --green:#55763f; --amber:#a8701a; --red:#a83a24; }
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px 80px}
header{padding:56px 0 28px;border-bottom:1px solid var(--line)}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 14px}
h1{margin:0 0 14px;font-size:clamp(28px,4.2vw,40px);line-height:1.12;font-weight:620;letter-spacing:-.02em;text-wrap:balance}
header p.lede{margin:0;max-width:64ch;color:var(--ink-dim);font-size:16px}
.bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:14px 0;margin-bottom:22px;background:var(--bg);border-bottom:1px solid var(--line)}
.bar button{font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);background:transparent;border:1px solid var(--line);padding:7px 13px;cursor:pointer;border-radius:2px;transition:color .12s,border-color .12s,background .12s}
.bar button:hover{color:var(--ink);border-color:var(--ink-faint)}
.bar button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.bar button[aria-pressed="true"]{color:var(--bg);background:var(--ink);border-color:var(--ink)}
.bar .n{font-variant-numeric:tabular-nums;opacity:.7;margin-left:6px}
.piece{display:grid;grid-template-columns:4px 132px 1fr 168px;gap:0 22px;align-items:start;padding:22px 22px 22px 0;background:var(--panel);border:1px solid var(--line);border-left:0;margin-bottom:10px;border-radius:0 3px 3px 0}
.piece[hidden]{display:none}
.rail{align-self:stretch;background:var(--line);border-radius:3px 0 0 3px}
.piece[data-verdict="match"] .rail{background:var(--green)}
.piece[data-verdict="loose"] .rail{background:var(--amber)}
.piece[data-verdict="mismatch"] .rail{background:var(--red)}
.chip{background:var(--void);border-radius:2px;aspect-ratio:1;display:grid;place-items:center;padding:10px;margin-left:22px}
.chip img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;image-rendering:crisp-edges}
.chip-empty{border:1px dashed var(--line);background:transparent}
.stand-in{font-family:var(--mono);font-size:11px;line-height:1.35;color:var(--ink-dim);text-align:center;padding:6px;text-wrap:balance}
.note{margin:0 0 22px;padding:14px 16px;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:0 3px 3px 0;background:var(--panel);color:var(--ink-dim);font-size:14px}
.note strong{color:var(--ink)}
.note a{color:inherit}
.text h2{margin:0 0 4px;font-size:19px;font-weight:600;letter-spacing:-.01em}
.ids{margin:0 0 12px;font-family:var(--mono);font-size:12px;color:var(--ink-faint)}
.ids code{font:inherit}
.flavour{margin:0 0 10px;max-width:62ch}
.read,.drawn,.sug,.flag{margin:0 0 8px;font-size:13.5px;color:var(--ink-dim);max-width:68ch}
.drawn{margin-bottom:0}
.k{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin-right:6px}
.sug code,.flag code{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
.tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;padding:2px 7px;border-radius:2px;margin-right:8px;white-space:nowrap;border:1px solid currentColor}
.tag-match{color:var(--green)} .tag-loose{color:var(--amber)} .tag-mismatch{color:var(--red)}
.mech{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.mech>div{min-width:0}
.mech dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:2px}
.mech dd{margin:0;font-family:var(--mono);font-size:15px;font-variant-numeric:tabular-nums;color:var(--ink)}
.mech dd.w{font-size:13px}
.mech .u{font-size:10.5px;color:var(--ink-faint);margin-left:2px}
.mech dd.yes{color:var(--amber)} .mech dd.no{color:var(--ink-faint)}
.bandwrap{grid-column:1/-1}
.band{position:relative;height:5px;background:var(--panel-2);border:1px solid var(--line);border-radius:3px;margin-top:5px}
.band span{position:absolute;top:-2px;width:5px;height:7px;background:var(--ink);border-radius:1px;transform:translateX(-50%)}
footer{margin-top:40px;padding-top:22px;border-top:1px solid var(--line);color:var(--ink-faint);font-size:13px;max-width:70ch}
footer code{font-family:var(--mono);font-size:12px}
@media (max-width:820px){.piece{grid-template-columns:4px 96px 1fr;padding-right:18px}.mech{grid-column:2/-1;margin-top:16px;grid-template-columns:repeat(4,1fr)}.chip{margin-left:18px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<div class="wrap">
<header>
  <p class="eyebrow">Junkstronaut &middot; content pipeline &middot; art check</p>
  <h1>${items.length} pieces of debris, each shown against the words written for it</h1>
  <p class="lede">One agent described every sprite without being told its name. A second compared that blind reading to the name the catalogue assigns. The coloured rail is that comparison &mdash; not a human's, and not the writer's opinion of its own work.</p>
</header>
${embedSprites ? '' : `<p class="note"><strong>The sprites are not shown here.</strong> The pack is licensed for use in the game and explicitly not for redistribution, so this copy carries every finding and none of the pixels &mdash; each tile holds the blind reader's own description instead, which is what the verdict was decided on. The pack, including a free demo archive, is at <a href="https://rehandev.itch.io/300-asteroid-and-space-junk-pixel">rehandev.itch.io/300-asteroid-and-space-junk-pixel</a>; drop it in and run <code>node run-content.js --art &lt;dir&gt;</code> to regenerate this page with the art in place.</p>`}
<nav class="bar" aria-label="Filter by verdict">
  <button data-f="all" aria-pressed="true">All<span class="n">${items.length}</span></button>
  <button data-f="mismatch" aria-pressed="false">Art disagrees<span class="n">${counts.mismatch || 0}</span></button>
  <button data-f="loose" aria-pressed="false">Loose fit<span class="n">${counts.loose || 0}</span></button>
  <button data-f="match" aria-pressed="false">Art matches<span class="n">${counts.match || 0}</span></button>
</nav>
<main>
${rows}
</main>
<footer>
  <p>Ordered by altitude, floor of the band to the top &mdash; the order the player meets them. The <strong>Band</strong> tick shows where each piece sits between ${Math.round(band.min / 1000)}&nbsp;km and ${Math.round(band.max / 1000)}&nbsp;km.</p>
  <p>Generated ${esc(generatedAt || '')} from <code>${esc(catalogPath || '')}</code>${artDir ? ` and <code>${esc(artDir)}</code>` : ''}. The blind readings are in <code>out/art/art_reading.json</code>; the verdicts and their evidence are in <code>out/art/art_match.json</code>.</p>
  ${embedSprites
    ? '<p><strong>This page embeds the sprite pack.</strong> The art is licensed for use in the game and not for redistribution, so this file is deliberately excluded from any public copy of the project. <code>art-findings.html</code> beside it is the same page without the pixels, and that is the one that ships.</p>'
    : '<p>The version of this page with the sprites in it is written only where the pack is present, and never published.</p>'}
</footer>
</div>
<script>
(function(){
  var b=document.querySelectorAll('.bar button'),p=document.querySelectorAll('.piece');
  b.forEach(function(x){x.addEventListener('click',function(){
    var f=x.dataset.f;
    b.forEach(function(o){o.setAttribute('aria-pressed',String(o===x))});
    p.forEach(function(e){e.hidden=!(f==='all'||e.dataset.verdict===f)});
  })});
})();
</script>
</body></html>
`;
}

module.exports = { renderArtReview };
