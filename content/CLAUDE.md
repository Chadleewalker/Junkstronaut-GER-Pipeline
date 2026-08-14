# Junkstronaut Content Pipeline — instructions for Claude Code

This folder is a retrieval-grounded content pipeline for **Junkstronaut**, a 2D game about
salvaging space junk. It reads the game's design document, retrieves the passages that answer
each question, writes content from those passages alone, and runs a critic that reads every
line back against the same passages. Read `README.md` for what it produces.

## If the user asks to run it

They will say something like "run the content pipeline", "generate the barks", or "write the
flavour text". From this folder:

```bash
node run-content.js
```

It takes 10–20 minutes on opus and prints its own progress. Do not wrap it, summarise it
while it runs, or re-implement any part of it — the script is the pipeline.

If they want it quick, are not signed in, or do not want to spend tokens:

```bash
node run-content.js --stub
```

That replays a recorded run through the identical code path in about a second. Say plainly
that it is a replay.

`--reuse bark-writer,lore-critic.barks` replays named agents and runs the rest live, which is
how you iterate on one charter without paying for the other eleven calls.

## The art stage

Two extra agents run before the writers, where art is present:

- **`art-reader`** is shown contact sheets the pipeline renders itself and is **not told any
  names**. It says what is drawn.
- **`art-matcher`** is shown the names and the reader's words and **never an image**. It returns
  `match` / `loose` / `mismatch` per piece, with the reading quoted as evidence.

The debris flavourist then **opens the same sheets itself** and writes from the picture as well as
the passages and the numbers. It is the one agent given both the art and the names, and that is
not an inconsistency with the rule below: it is the writer, not a judge. It writes the words a
player reads while looking at the sprite, so it looks at the sprite. The reader's description is
still passed along as a second opinion, and it is the only art input when a run has no sprites.

`--art <dir>` points it at any folder of sprites; `--no-art` skips it. With no art it finds
none, says so, and every other stage runs — which is the normal state of a published copy,
because the pack cannot be redistributed.

**Do not merge those two agents, and do not show either one the other's input.** A reader told
the name confirms the name; a matcher shown the picture re-decides what it depicts and then
agrees with whichever record it preferred. Two tests in `test/art.test.js` assert the seam and
they are the point of the stage, not paperwork.

## After it finishes

Open `out/report/content.html` and tell them:

1. What the critic caught, and whether the correction held on the re-check. This is the most
   interesting part of any run — it is the pipeline catching itself.
2. **What the art audit disagreed with**, if it ran. `out/art/art_match.json` has the verdicts
   and `out/report/art.html` shows each sprite beside its text. A `mismatch` means the game
   calls a piece something its picture is not, and that is a finding about the game, not about
   the writing.
3. Any **failing deterministic check**. Those are facts about two files, not judgements, so a
   failure there is unambiguous.
4. Where the game-ready files are: `out/content/*.json` plus the `content.gd` autoload.
5. The retrieval numbers, if they ask: precision@1 is measured against the `expect` labels in
   `lib/items.js`, which were written by reading the document and not by looking at what the
   retriever returned.

## Tests

```bash
node --test "test/*.test.js"
```

About two seconds, no credentials. Run after touching anything in `lib/` or `run-content.js`.

Use that exact form. A bare `node --test` picks up `test/fixtures/fake-writer.js` — a
stand-in for the CLI, not a test — and blocks forever waiting for a prompt on stdin.

The suite exists because `--stub` is not a test: a replay only walks the path one recorded
run happened to take, so it never exercises the schema gate rejecting output, the
retry-with-feedback loop, or a critic verdict that has nothing to apply. All three are
covered here against `test/fixtures/fake-writer.js`.

## Do not

- **Do not write anything into `crew/`.** Only `crew/lib/` travels with this repository — the
  shared agent runner — and this pipeline reads it and nothing else from there.
- Do not edit the design document. It is the document of record and the knowledge base.
- Do not hand-edit files in `out/`. If the content is wrong, that is a finding about the
  pipeline; the pipeline is what changes it.
- Do not give the critic the writer's reasoning. It is given the artifact and the passages,
  deliberately — a critic that reads the justification can be argued into agreeing with it.
  `run-content.js` strips `why` before the critic call, and that line is load-bearing.
- Do not delete `lib/retrieve.js`'s `overlap` scorer. It is the retired retriever, kept
  runnable so the improvement in the ReadMe stays a measurement rather than a claim.
- Do not add dependencies. Zero-dependency on purpose, and it shares `../crew/lib/` rather
  than copying it.
- Do not make the circuit breaker retry. `lib/escalate.js` collects what the one refine pass
  could not settle and hands it to a human; looping again is the failure mode it exists to
  prevent, because the commonest cause is a catalogue that disagrees with its own artwork and
  a rewrite there can only make the writer lie.
