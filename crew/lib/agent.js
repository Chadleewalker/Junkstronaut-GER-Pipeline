'use strict';
// One agent call: build the prompt, run it, get a validated JSON object back.
//
// The agent command is a seam. `JUNK_AGENT_CMD` replaces it wholesale, which is how the
// crew's stub mode and its tests exercise the real orchestrator without a model call. The
// contract is narrow on purpose: a shell command that reads a prompt on stdin and writes
// the Claude CLI's `--output-format json` envelope on stdout.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseEnvelope, extractObject } = require('./envelope');
const { validate } = require('./schema');

const DEFAULT_MODEL = process.env.JUNK_MODEL || 'opus';
const DEFAULT_CMD = `claude -p --output-format json --dangerously-skip-permissions --model ${DEFAULT_MODEL}`;
// Generous on purpose. The Researcher derives a planet from scratch and the Balancer
// solves every §2.3 constraint at once; both have run past eight minutes on opus, and a
// timeout here throws away the whole attempt rather than degrading it.
const TIMEOUT_MS = Number(process.env.JUNK_AGENT_TIMEOUT_MS || 1500000);

// The prompt is assembled the same way every time: who you are, what you were given, and
// the charter last so its output contract is the freshest thing in context.
function buildPrompt({ charter, inputs }) {
  const parts = [];
  for (const [label, body] of Object.entries(inputs)) {
    parts.push(`--- ${label} ---\n${body}\n`);
  }
  parts.push(`--- YOUR CHARTER ---\n${charter}\n`);
  parts.push(
    'Follow your charter exactly. Return one JSON object and nothing else — no prose ' +
    'before it, no markdown fence around it, no commentary after it.'
  );
  return parts.join('\n');
}

// Live mode. Returns the raw stdout text, or throws with something a human can act on.
function invoke(prompt, logPath) {
  const cmd = process.env.JUNK_AGENT_CMD || DEFAULT_CMD;
  const res = spawnSync(cmd, {
    input: prompt,
    shell: true,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  fs.writeFileSync(logPath, stdout);
  if (stderr.trim()) fs.writeFileSync(logPath.replace(/\.log$/, '.err.log'), stderr);

  if (res.error) throw new Error(`agent command failed to start: ${res.error.message}`);
  if (res.signal) throw new Error(`agent command killed by ${res.signal} (timeout is ${TIMEOUT_MS}ms)`);
  if (res.status !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join('\n') || '(no stderr)';
    throw new Error(`agent command exited ${res.status}\n${tail}`);
  }
  return stdout;
}

// Stub mode. Reads a recorded envelope instead of calling a model, and then walks the
// identical parse -> extract -> validate path, so the only thing that differs between the
// two modes is where the bytes came from.
function replay(stubDir, name, attempt, logPath) {
  const candidates = [
    path.join(stubDir, `${name}.attempt${attempt}.log`),
    path.join(stubDir, `${name}.log`),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`no recorded output for "${name}" — looked for ${candidates.join(' and ')}`);
  }
  const text = fs.readFileSync(found, 'utf8');
  fs.writeFileSync(logPath, text);
  return text;
}

// -> { object, model, attempts }
// Retries on anything that leaves us without a schema-valid object: a failed command, a
// log with no envelope, a reply that is not JSON, or a reply that is JSON but wrong. The
// validation errors are fed back into the next attempt, because an agent told exactly
// which field it broke fixes it far more often than one told to try again.
function runAgent({ name, charter, inputs, schema, logDir, mode, stubDir, maxAttempts = 3, log }) {
  let feedback = null;
  const problems = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const logPath = path.join(logDir, `${name}.attempt${attempt}.log`);
    const promptInputs = feedback
      ? { ...inputs, 'YOUR PREVIOUS ATTEMPT WAS REJECTED': feedback }
      : inputs;
    const prompt = buildPrompt({ charter, inputs: promptInputs });
    fs.writeFileSync(path.join(logDir, `${name}.attempt${attempt}.prompt.md`), prompt);

    try {
      const raw = mode === 'stub'
        ? replay(stubDir, name, attempt, logPath)
        : invoke(prompt, logPath);

      // A log with no envelope is not an error in stub mode — a hand-written stub may be
      // the bare object — so fall through to extractObject either way.
      const env = parseEnvelope(raw);
      const replyText = env ? env.result : raw;
      const object = extractObject(replyText);
      if (!object) throw new Error('reply contained no JSON object');

      const errors = validate(object, schema);
      if (errors.length) {
        throw new Error(`output failed its schema:\n  - ${errors.slice(0, 12).join('\n  - ')}`);
      }

      return { object, model: env ? env.model : null, attempts: attempt };
    } catch (err) {
      problems.push(`attempt ${attempt}: ${err.message}`);
      if (log) log(`  ${name} attempt ${attempt} rejected — ${err.message.split('\n')[0]}`);
      feedback =
        `Your previous reply was rejected for this reason:\n\n${err.message}\n\n` +
        'Return the corrected JSON object. Fix only what is named above; do not restructure ' +
        'the parts that were accepted, and do not apologise or explain — return the object alone.';
    }
  }

  throw new Error(`${name} failed after ${maxAttempts} attempts:\n  ${problems.join('\n  ')}`);
}

module.exports = { runAgent, buildPrompt, DEFAULT_CMD };
