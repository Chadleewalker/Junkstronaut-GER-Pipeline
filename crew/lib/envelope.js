'use strict';
// Reads the Claude CLI's `--output-format json` envelope out of a raw agent log.
//
// The CLI prints chatter around its own output — untrusted-workspace warnings today,
// whatever a future version invents tomorrow — so a whole-file JSON.parse silently fails
// and a raw tail leaks noise into an artifact. The rule is structural on purpose: scan
// lines BOTTOM-UP and take the first that parses to an object with a string `result`.
// No regex over prose, no list of known warning strings to maintain.
//
// Agents are also told to return "one JSON object and nothing else", which they mostly
// honour and occasionally wrap in a markdown fence. `extractObject` handles both without
// caring which happened.

// -> { result, model } | null
function parseEnvelope(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue; // cheap reject; JSON.parse decides the rest
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    if (typeof j.result !== 'string') continue;
    return { result: j.result, model: chooseModel(j.modelUsage) };
  }
  return null;
}

// modelUsage lists EVERY model the CLI billed and puts the cheap internal helper first,
// so key[0] names the wrong model. Pick the one that did the most output tokens.
function chooseModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const keys = Object.keys(modelUsage);
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  const out = (k) => {
    const n = modelUsage[k] && modelUsage[k].outputTokens;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  return keys.slice().sort((a, b) => (out(b) - out(a)) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

// Pull a single JSON object out of an agent's reply text.
// Tries the whole string, then a fenced block, then the outermost brace span — in that
// order, so a well-behaved reply takes the cheapest path.
function extractObject(text) {
  const s = String(text).trim();
  const attempt = (candidate) => {
    try {
      const v = JSON.parse(candidate);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };

  let v = attempt(s);
  if (v) return v;

  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fence) {
    v = attempt(fence[1].trim());
    if (v) return v;
  }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    v = attempt(s.slice(first, last + 1));
    if (v) return v;
  }

  return null;
}

module.exports = { parseEnvelope, extractObject, chooseModel };
