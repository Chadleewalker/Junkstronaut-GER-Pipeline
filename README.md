# Junkstronaut — GER Pipeline

**Assignment #6.** A Generate → Evaluate → Refine loop with a circuit breaker, writing real
content for **Junkstronaut**: a 2D pixel-art game about salvaging space junk out of a Kessler
cascade and selling it to the junkyard owner who fronted your launch.

The pipeline reads the game's design document, retrieves the passages that answer each individual
question, writes from **those passages and nothing else about the game**, checks the result against
the game's own data, hands it to a critic that reads it back against the same passages, applies the
corrections, re-reads them — and then **stops**, handing a human everything it could not settle
rather than looping until something passes.

---

## Run it — one command, no install, no API key

```bash
git clone <this repo>
cd Junkstronaut-GER-Pipeline/content
node run-content.js --stub
```

About a second. `--stub` replays a recorded run through the identical code path, so you see the
real output without spending tokens or signing in. Drop `--stub` to run the agents live
(10–20 minutes, needs Claude Code signed in). Zero dependencies — no `npm install`. Node 22 or 24.

Then look at:

| open this | what it is |
|---|---|
| **`content/out/checks/needs_human.json`** | **The circuit breaker's output.** Everything the loop could not settle, each with the reason it was not retried. |
| **`content/out/report/content.html`** | Every item as **query → retrieved passage → generated output**, plus every correction the critic made with the draft it replaced. |
| `content/out/content/debris_flavour.json` | display name and flavour for all 30 junk types — the content this assignment is about |
| `content/out/checks/deterministic_checks.json` | all 92 code checks, each with the numbers it compared |
| `content/out/critique/critique_log.json` | every rejected draft, the passage that condemned it, and the fix |

Tests: `node --test "test/*.test.js"` from `content/` — **63 tests, about a second, no credentials.**

---

## Pre-Build Declaration

Full text in [`PRE-BUILD-DECLARATION.txt`](PRE-BUILD-DECLARATION.txt). In short:

**1 · What content type does the game generate manually, inconsistently, or not at all?**
Debris flavour text. The game spawns 30 junk types from a catalogue holding mass, altitude, size
class and a fragile flag — and nothing a player ever reads.

**2 · What rule from the GDD must every piece satisfy?**
**The fiction must match the mechanics.** Cargo value and survivability are the same variable in
Junkstronaut, so a piece's words must agree with its numbers: fragile in the catalogue reads
fragile, the top of the altitude band never reads low, the heaviest piece never reads light.

**3 · What does a failure look like, concretely?**
The player tethers the 3,600 kg Apollo service module at 277,000 m — the piece the whole game is
built around — and the hold reads *"a light scrap of hull plating, easy haul."* Fluent, and it
teaches the opposite of the decision the finale is about.

---

## The four parts

```
  GDD --> chunk --> retrieve --+
                               |
                               v
                          GENERATOR          3 writers, each given only its
                               |             own retrieved passages
                               v
                          EVALUATOR          code checks the numbers,
                               |             the critic reads the prose
                               v
                          REFINER            critic writes the fix,
                               |             code decides what is applied
                               v
                          RE-CHECK           a fresh critic, no memory
                               |
                               v
                       CIRCUIT BREAKER  -->  settled  -->  content/*.json, content.gd
                               |                            (what the game loads)
                               v
                       needs_human.json
                       (what it could not settle, and why it was not retried)
```

### Generator — three writers, each grounded in retrieved passages

The design document is chunked section-aware (48 chunks over 15 sections, never split
mid-sentence), indexed with BM25, and queried once per game state. Each item is written from
about **2,900 characters — 7% of the document** — and must cite the chunk ids it used.

Three content types, all of them gaps the document names about itself: 18 radio barks, 30 debris
descriptions, 9 post-mortem screens. **57 items.**

### Evaluator — two gates, and they do different jobs

**Code checks the facts about two files** (`content/lib/verify.js`). This is where the GDD rule
lives, and it is enforced by arithmetic rather than by opinion:

```js
if (c.fragile && !claim.has('fragile'))  → fail   // catalogue says fragile, the words do not
if (claim.has('low')  && f >= 1/3)       → fail   // "low" at the top of the altitude band
if (claim.has('high') && f <  2/3)       → fail   // "high" near the floor
// and the heaviest piece in the catalogue must read heavy, the lightest light
```

That only works because the writer is made to **declare** what it was going for in a `reads_as`
field. A free-text description cannot be checked against a mass in kilograms; a declaration can.
The declaration is only worth anything because the words then have to earn it in front of the
critic — so the two gates hold each other up.

**The critic reads the things that need reading.** It is given the generated items and *the same
passages the writer had*, and deliberately **not** the writer's reasoning — `run-content.js` strips
it. A critic that reads the justification is a critic being argued with.

### Refiner — corrections applied by code, re-read by a critic with no memory

The critic writes the fix; **the orchestrator decides what gets applied** — a non-passing verdict
with a usable correction, restricted to the text fields that content type owns. The original is
kept as `before`. Then a **fresh** critic call re-reads only the corrected items against the same
passages, with no memory that it wrote them, so a pass there is the correction holding rather than
the critic agreeing with itself.

Recorded run: **12 issues raised, 12 corrections applied, 3 items still flagged after the re-read.**

### Circuit Breaker — one pass, then stop

Those 3 are where the breaker fires. It does **not** retry, and that is the design (see
[`content/lib/escalate.js`](content/lib/escalate.js)). Once an item has been rewritten by its own
critic and still fails, one of three things is true and a second pass fixes none of them:

- **the data is wrong** — `torn_foil_blanket` is flagged fragile in the catalogue and its sprite is
  a cracked steel plate. The writer described the plate, correctly, and could not honestly claim
  fragile. The check is right, the writing is right, the *table* is wrong. Retrying can only make
  it lie.
- **the critic is wrong** — a non-passing verdict carrying no usable correction is a finding about
  the judge, not the content.
- **the item is genuinely hard** — and the same prompt over the same passages a third time is the
  definition of a loop that has stopped making progress.

So it collects, names, and hands over. `out/checks/needs_human.json` on the recorded run:
**11 findings across 9 items — 3 `refine_exhausted`, 8 `data_conflict`**, each with a `looks_like`
line saying which of the three cases it is. It changes no content: the flagged lines still ship,
because somebody reviewing a flagged line needs to read it in place. `--strict` turns a tripped
breaker into exit 3, for a build step that must not wire unread content into the game.

The file is written on **every** run, including a clean one. A file that only appears when
something is wrong is a file nobody learns to look for; `"tripped": false` is a result, not an
absence.

---

## Did it catch something I would have missed?

Yes, and not the thing I built it to catch.

The debris writer used to be handed a piece's `id` — `torn_foil_blanket` — and never the sprite. So
it described **the name**. The name was a label somebody typed, and the mapping from names to
sprites was made by eye and never checked. Where a name was wrong the pipeline produced fluent,
confident prose about an object the player will never see, and **nothing in the loop could catch
it**: an art mismatch contradicts no passage, and there was no image in any prompt.

The fix is an audit made of two blind halves. The **reader** is shown contact sheets the pipeline
renders itself and is never told a name; the **matcher** is shown the names and the reader's words
and is never shown an image. One agent given both would read the picture through the name and
confirm whatever it was told.

Result: **30 sprites read blind — 11 match their id, 12 loose, 7 disagree.** `torn_foil_blanket` is
a cracked hull plate. That is a data defect in the game, found by a content pipeline, and it is
exactly the class of thing the circuit breaker exists to route to a human instead of papering over:
all 7 land in `needs_human.json` as `data_conflict`, and the fix is to rename the catalogue entry —
not to rewrite the sentence.

---

## What the recorded run says

| | |
|---|---|
| items generated | 57 (18 barks + 30 debris + 9 post-mortems) |
| retrieval | P@1 **100%** on 27 hand-labelled states; each item written from ≤7.0% of the document |
| deterministic checks | **92 run, 92 passed** |
| critic | 12 issues raised, 12 corrections applied, 3 unsettled after the re-read |
| art audit | 30 sprites, 11 match / 12 loose / 7 disagree |
| **circuit breaker** | **TRIPPED — 11 findings on 9 items, escalated not retried** |
| tests | 63, no credentials, about a second |

---

## Layout

```
PRE-BUILD-DECLARATION.txt     the three answers
Junkstronaut GDD Short.txt    the design document the pipeline reads
config/debris_catalog.json    30 junk types — mass, altitude, size class, fragile
content/
  run-content.js              the orchestrator — contains no model
  lib/verify.js               the GDD rule, enforced by arithmetic
  lib/escalate.js             the circuit breaker
  lib/{chunk,retrieve,prompt}.js   chunking, BM25, prompt assembly — all deterministic
  lib/art.js, lib/artsheet.js the blind art audit and its report
  agents/*.md                 the six charters
  schemas/*.json              every agent reply is schema-validated before it is used
  stubs/                      the recorded run, so --stub replays without credentials
  out/                        that run's artifacts, committed
  test/                       63 tests
crew/lib/                     shared agent runner: prompt → invoke → validate → retry
```

**The orchestrator contains no model.** Chunking, retrieval, scoring, the coverage and citation
checks, the fiction-versus-mechanics check, the decision to apply a correction, and the circuit
breaker are all deterministic code. Agents write and agents judge; scaffolding decides what happens
next. That division is why a recorded run replays byte-for-byte.

There is a second, smaller GER loop underneath this one: every agent call in `crew/lib/agent.js`
validates the reply against its JSON schema, feeds the **validation errors** back into the next
attempt, and gives up after 3 — an agent told exactly which field it broke fixes it far more often
than one told to try again.

---

## Notes

- **The sprite pack is licensed for use, not redistribution**, so no art ships here. The pipeline
  runs without it: sheet layout is computed from the catalogue rather than from files on disk, and
  the readings replay out of the recorded envelopes. The findings live in `out/art/*.json` — same
  evidence, no pixels.
- **Assignment #4** built the generator, the retrieval and the critic. **#6 adds the circuit
  breaker** (`content/lib/escalate.js`, `content/test/escalate.test.js`, `out/checks/needs_human.json`,
  `--strict`), which is what turns a pipeline that always ships into a loop that knows when to stop.
