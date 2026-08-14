# `content/` — the Junkstronaut content pipeline

**Assignment #4**, extended for **#6**. Retrieval-grounded content generation with a critic on
the gate and a circuit breaker behind it. The repository README is the #6 submission document;
this file is the pipeline's own reference.

The design document promises three kinds of written content that the game does not have. This
pipeline chunks that document by section, retrieves the passages that answer each individual
game state, writes from **those passages and nothing else about the game**, and then hands
every line to a critic that reads it back against the same passages — and never sees the
writer's reasoning.

---

## Quick start

Nothing to install. No dependencies, no `npm install`, no API key needed for the replay.
Tested on Node 24.

**1 · Get it**

```bash
git clone <this repo>
cd Junkstronaut-GER-Pipeline/content
```

**2 · Run it**

```bash
node run-content.js --stub
```

About a second. It replays a recorded run through the identical code path, so you see the real
output without spending tokens or signing in. Drop `--stub` to run the agents live
(10–20 minutes, needs Claude Code signed in).

The `out/` committed here is that replay's output, so running the command above overwrites it
with the same bytes and only the timestamp moves. It is byte-identical to the live opus run
that produced the fixtures — `run.json` says `"mode": "stub"` because that is how the files on
disk were last written, and `"models": ["claude-opus-5"]` because the model that wrote the
content is read back out of the recorded envelope rather than asserted.

**3 · Look at what it made**

| open this | what it is |
|---|---|
| **`out/report/content.html`** | **Start here.** Every item as **query → retrieved passage → generated output**, side by side, plus every correction the critic made with the draft it replaced. |
| `out/content/armstrong_barks.json` | 18 generated radio barks + the 3 already in the GDD, keyed by game state |
| `out/content/debris_flavour.json` | display name and flavour for all 30 junk types |
| `out/content/postmortem_screens.json` | the 5 terminal states and the 4 stranded sub-cases |
| `out/content/content.gd` | the Godot autoload that loads all three |
| **`out/checks/needs_human.json`** | **the circuit breaker** — what the loop could not settle, and why each one was not retried |
| `out/critique/critique_log.json` | every rejected draft, the passage that condemned it, and the fix |
| `out/retrieval/retrieval_log.json` | every query, every chunk it returned, every score |
| `out/art/art_reading.json` | what each sprite shows, from an agent that was never told the piece's name |
| `out/art/art_match.json` | whether each name and its picture describe the same object, with the reading quoted |
| `out/report/art.html` | every sprite beside the words written for it — **written only where the art is present, because it embeds the pack** |

Tests: `node --test "test/*.test.js"` from this folder — 63 tests, about a second, no
credentials.

---

## What it generates, and what gap each one fills

Each of these is a gap the design document names about itself.

**1 · Armstrong's radio barks.** §1 promises "a dozen state-triggered one-liners ... carrying
both the tutorial hints and, later, the characterization the graded endings pay off". The
document contains three of them. §4.2 budgets a whole Coder session for "the dozen barks and
the three ending screens" and then does not write them.

> The brief for this assignment says two lines exist. There are three — §2.5 has
> `("Teaching's part of the debt, kid")` buried parenthetically inside a sentence about the
> economy, where it does not look like a bark. All three are in `lib/items.js` as canon, are
> passed to the writer as the voice target, and are shipped in the output file flagged
> `source: "gdd"` so nobody mistakes them for generated.

18 new lines, each tied to a state with a detector: first launch, the heat bar first moving on
the *climb*, staging, the commit floor refusing an entry, a completed braking pass, first
plasma, the CHUTE lamp going green, the shield running out, the hold-mass dial into amber and
then red, the RETURN lamp, the tow fee, a hard landing, the module tethered, the module
degrading, burn-up, and the two endings the canon lines do not already cover.

**2 · Debris flavour.** `config/debris_catalog.json` holds 30 real junk types with mass, altitude,
size class and a fragile flag. It reads like a spreadsheet. The pipeline writes a `display_name`
and one line of flavour for each — from **the real pieces**, never invented ones, which is checked
by code rather than promised.

Two constraints, and the second one is the reason this type is worth generating at all.

*The fiction has to match the mechanics.* A 3,600 kg piece at 277,000 m has to read as heavy and
high; a fragile piece has to read as fragile. Enforced two ways: the writer must *declare* what it
was going for in a `reads_as` field, which `lib/verify.js` compares against the catalog's own
numbers, and the critic then judges whether the words earn the declaration.

*The fiction has to match the picture.* This one was added late, after an uncomfortable discovery.
The writer used to be handed the piece's `id` — `torn_foil_blanket` — and never the sprite, so it
described **the name**. The name was a label somebody typed, and the mapping from names to sprites
was made by eye and never checked; `debris_sprites.json` says so in its own header. Where a name
was wrong the pipeline produced fluent, confident prose about an object the player will never see,
and nothing could catch it: an art mismatch contradicts no passage, and there was no image in any
prompt. See [the art stage](#the-art-stage) below.

**3 · Post-mortem screens.** §1: "the first run still teaches reentry through one cheap, legible
failure — a post-mortem screen names the cause of death and the rule broken." §2.7 defines the
five terminal states and gives each a detector, plus four stranded sub-cases. Nine screens, each
with a `title`, a `cause`, the `rule_broken` — the teaching line, and the reason the screen
exists — and one line from Armstrong.

---

## How it works

```
GDD --> chunk --> index
                    |
     per-item query |--> retrieved passages --> writer --> code checks
                                   |                          |
                                   +------> lore critic <-----+
                                                  |
                                       corrections applied, drafts kept
                                                  |
                                     critic re-reads only what changed
                                                  |
                                still failing? --> CIRCUIT BREAKER --> needs_human.json
```

Full picture, including which boxes contain a model and which do not: [`DIAGRAM.md`](DIAGRAM.md).

**Chunking is section-aware.** §2.2 is a thing the document refers to by name, so a retrieval
hit comes back labelled `2.2d` and a reader can go and check it. Sections are found
structurally — a line that is a number followed by a title — not from a hardcoded table of
contents, because the GDD is a living file. Long sections are split at **sentence boundaries**;
no chunk ever starts or ends mid-sentence, and a test asserts every chunk is verbatim document
text. 44,573 characters become 48 chunks over 15 sections, averaging 911 characters.

**Retrieval is BM25 over those chunks.** No embedding service: none is available offline, and an
online one would break the one-command promise this repo makes. It is also
the more defensible choice — every score on the report page can be recomputed by hand from the
chunk text and the query, so "retrieval is accurate" is checkable rather than asserted.

One query per game state, written from the state and never from the answer, in
[`lib/items.js`](lib/items.js). Numbers go in the queries — the index tokenises `8,000` and
`3,600` — because a query carrying the number its state is about pulls back the sentence that
states it, which is what later gives the critic something to check a generated number against.

**Generation sees the retrieved passages and nothing else about the game.** Each item gets its
own retrieval; the passages are printed once and each item cites the ids it retrieved. Each item
is written from about **2,900 characters — 7% of the document**.

> The honest second number: because the passages are pooled and printed once, and because 18
> bark states span §1 to §2.7, the union in that one prompt is 65% of the document. The per-item
> figure is what grounding means; the pooled figure is what the model saw in one call. Both are
> in `run.json` and both are printed by the run. An earlier version repeated each item's
> passages under that item, which printed §2.2 nine times and ran the prompt to 40,000
> characters — at which point "grounded in retrieved passages" is not meaningfully different
> from pasting in the document, and the whole claim quietly stops being true.

**Two gates, and they do different jobs.**

*Code* checks the things that are facts about two files: did every piece get exactly one
description, did the writer cite a chunk it was actually shown, does a piece the catalog flags
fragile get described as fragile, is the heaviest piece described as heavy. Asking a model to
check a fact about two files trades an answer for an opinion.

*The critic* checks the things that need reading: does this contradict the document, is the
voice wrong, did it invent a mechanic, does a number disagree. It is given the generated items
and **the same passages the writer had**, and deliberately not the writer's `why` field.
`run-content.js` strips it. A critic that reads the justification is a critic being argued with
— the same discipline the tuning crew's Spec Auditor runs on, copied here on purpose.

**Corrections are applied by the orchestrator, not by the critic.** The critic writes the fix;
code decides that a non-passing verdict with a usable `corrected` block is what gets applied,
keeps the original as `before`, and reports any verdict it could not act on rather than
silently treating it as a pass. Then a **fresh critic call re-reads only the corrected items**
against the same passages, with no memory that it wrote them.

**And then it stops.** The refine loop is one pass, and what it could not settle is escalated
rather than retried: `lib/escalate.js` collects the failed code checks, the verdicts with no
usable correction, the items still flagged after the re-read, and the sprites whose id the art
audit disputes, and writes them to `out/checks/needs_human.json` with the reason each was not
retried. It changes no content — the flagged lines still ship so a reviewer can read them in
place — and `--strict` turns a tripped breaker into exit 3, for a build step that must not wire
unread content into the game. The recorded run trips it: 11 findings across 9 items.

Why one pass and not five: by the time an item has been rewritten by its own critic and still
fails, either the data is wrong (see the art stage below — the check is right, the writing is
right, and the *catalogue* is wrong, so retrying can only make the writer lie), or the critic is
wrong, or the item is hard and the same prompt over the same passages a third time is a loop
that has stopped making progress. None of the three is fixed by asking again.

---

## The art stage

**The bug that caused it.** For most of this pipeline's life the debris writer was given a piece's
`id` and its numbers, and never the sprite. So it wrote a very good sentence about torn foil for
`torn_foil_blanket`, and the sprite is a cracked steel plate. Thirty pieces, one hand-made mapping
from names to pictures, no verification anywhere in the chain.

The lore critic could not have caught it. It reads generated writing against retrieved passages,
and "this describes foil, the picture is a plate" contradicts no passage. It passed those lines
because, judged against everything it was given, they were correct. **A consistency checker can
only catch contradictions between things it can see** — and this one had an eye closed without
ever reporting low confidence.

**An audit made of two blind halves, and a writer that can see.**

*The reader* is shown contact sheets the pipeline renders itself — every sprite at 7× on a flat
grey ground, cells numbered, a white corner mark on each — and is **never told a name**. It returns
what is drawn, how damaged it looks, its silhouette, its colours, and how confidently it could name
the thing at all.

*The matcher* is shown the names and the reader's words, and **never an image**. It returns
`match` / `loose` / `mismatch` per piece with the reading quoted as evidence, and a suggested id
where it disagrees.

One agent given both would read the picture through the name and confirm whatever it was told —
which is the exact failure this stage exists to catch. It is the same discipline the lore critic
runs on, applied to a second kind of source, and two tests hold the seam open: one asserts the
reader's prompt contains no piece name, the other that the matcher's prompt contains no image path.

*The writer* gets the sheets too, and the names, and the numbers, and the passages. It is the one
agent allowed everything, because it is not judging anything — it writes the words a player reads
*while looking at the sprite*, so it had better be looking at the sprite.

> That was not the first design, and the first design was worse in a way worth recording. The
> writer originally worked from the reader's *paraphrase* rather than the picture, which is a game
> of telephone. The reader, looking at the art, wrote: *"An irregular hexagonal grey slab with dark
> fracture lines running across its face and a chipped notch out of the upper right edge."* The
> writer, one hop downstream, produced: *"flat as a lid and cracked end to end."* Not wrong — but
> the notch and the fracture line are exactly what make that piece recognisable in a field of grey
> wreckage, and a paraphrase is where that kind of detail goes to die. The fix was to stop
> describing the description.
>
> Fixing it broke something else, which is the more useful half of the story. With the writer
> describing plates and the critic still holding only the ids, the critic "corrected" a cracked
> grey **plate** back into a crumpled foil **sheet** — enforcing the very id the audit had just
> proved wrong, and stamping it reviewed on the way past. Adding a source for the writer and not
> for its judge is what caused that. The critic now gets the readings and the verdicts as text,
> never the images, and its charter says the picture is the game and the id is a label somebody
> typed.

**Why the reader is allowed to say "I can't tell".** Twelve of the thirty came back `partial` or
`ambiguous` — these are 29-pixel sprites. The matcher's charter caps an ambiguous reading at
`loose`, so it can never call a confident mismatch on weak evidence. That is why its tally
(**11 match, 12 loose, 7 disagree**) is more conservative than a human's eyeball pass over the same
sheets, and it is the right trade: a false mismatch would send someone renaming art that was fine.

**What it found.** Seven pieces where the game calls something by a name its picture does not
support:

| id | what the reader saw, blind | suggested |
|---|---|---|
| `torn_foil_blanket` | a rigid grey slab that fractures rather than creases | `cracked_hull_plate` |
| `shattered_cryo_dewar` | a tank with **`H2O` stencilled on it**, intact | `potable_water_tank` |
| `cracked_command_module_hatch` | a plain six-sided fastener | `hex_nut_fastener` |
| `torn_reactor_shield_plate` | a green board fragment with components and a wire | *(withheld — reading only partial)* |
| `severed_boom_mast` | a braided flexible strand | *(withheld)* |
| `ruptured_helium_tank` | quilted material strapped into a roll | *(withheld)* |
| `burst_pressurant_sphere` | no manufactured surfaces, nothing vessel-like | *(withheld)* |

The stencilled `H2O` is the one I would point at. The artist drew lettering on that sprite, and the
matcher's charter says drawn text outranks the id — so it read the label and called the piece a
water tank. Four of the seven withhold a suggested name because the reading was only partial, which
is the charter working: an invented name for a smudge is worse than no name.

**What it changed in the output.** The writer now gets the reading, plus an explicit note where the
id and the drawing disagree, and it describes the picture:

> `torn_foil_blanket` → **Cracked Hull Plate** — *"A thin grey offcut off the floor of the band,
> flat as a lid and cracked end to end."*
>
> `shattered_cryo_dewar` → **Stencilled Water Tank** — *"A cyan tank lying on its side, H2O
> stencilled across the belly and stub fittings at either end."*

**The findings ship; the pixels do not.** The sprite pack is licensed for use and not for
redistribution, so `out/report/art.html` — which embeds every sprite — is excluded from any
published copy. `art_reading.json` and `art_match.json` carry the same evidence as text. The stage
is optional throughout: with no art it says so and every other stage runs, which is how the
public copy of this project works.

---

## Does it sound like the game?

Mostly yes, and I can say where it does not.

**What works.** The register is right. Armstrong is terse, transactional and fond in the way the
document describes — a creditor who teaches because teaching is part of the debt. Nothing in the
output says "commander", nothing is heroic, and failure is consistently written as a bill rather
than a tragedy: *"Suit was never rated for that, kid. She's back on the pad — you're out the
haul and the cost of turning her around, and nothing past that."*

The debris flavour is the strongest of the three, and it got stronger once the writer could see
the sprite. Grounding each description in the piece's own mass and altitude produced lines that do
the mechanical job by saying something physical rather than restating the number the HUD already
shows — *"It is the whole tank and then some, all in one piece"* for Armstrong's module at
3,600 kg, against *"it barely bends the tether, and rough handling gives you two halves"* for a
15 kg offcut at the floor. Neither line states a number and both are unmistakable about which end
of the table they came from.

Adding the picture changed what those lines are *about*. Before, `shattered_cryo_dewar` got a
sentence about a cryogenic tank coming apart, because that is what the id says. Now it reads
*"A cyan tank lying on its side, H2O stencilled across the belly and stub fittings at either
end"* — the writer describing lettering the artist actually drew. That is the difference between
prose grounded in a label and prose grounded in the thing.

The post-mortem screens do the thing §1 actually asked for, which is name the rule without
blaming the player. *"Landed needs the pilot aboard"* is the whole lesson of the stranded (c)
case in five words.

**Where it is thinner.** Four honest limitations:

- **The barks are more informative than a bark should be.** Because every state's job includes a
  tutorial hint, several lines carry two clauses where the canon lines carry one. The three
  lines already in the GDD average 44 characters; my eighteen average 99, and the worst is 154.
  Some of that is the states genuinely being more complex — "the hold-mass dial went red" is a
  harder thing to say than "don't deploy yet" — and some of it is a writer that was told to
  teach and did. In a production pass I would cut every line to one clause and make the second
  clause a second bark.
- **Voice sameness across 18 lines.** Read one at a time each is fine; read as a list, the
  cadence repeats — short declarative, comma, "kid". Armstrong has one move here and a human
  writer would give him three.
- **The post-mortem `rule_broken` lines read like the design document**, because they are
  paraphrases of it. That is correct for a teaching line and it is the register the screen
  wants — instrument-like, not conversational — but it does mean those fields are the least
  *authored* text in the output.
- **The critic is not perfectly repeatable, and things get through.** Across live runs it flagged
  4, 4 and 3 of the 18 barks. `first_launch`, `hold_mass_red` and `burned_up` came up every
  time — those are the hard factual contradictions, two of which are below. The marginal ones
  move. It flagged the phrase "the low band" on three pieces and let it stand on a fourth in the
  same reply; the three it caught are in *The three that did not hold* below, and the fourth
  shipped clean. Same phrase, same rule, same run.

  That is the honest shape of this gate: a filter with real variance, not a proof — which is why
  the report page prints per-item verdicts rather than a pass/fail badge, and why the critic's own
  findings are kept in `critique_log.json` whether or not they were acted on.
- **The art reader cannot see well enough to be certain, and says so.** Twelve of thirty sprites
  came back `partial` or `ambiguous`. These are 29-pixel images; there is a real ceiling on what
  any reader gets from them. The matcher caps an ambiguous reading at `loose` rather than calling a
  mismatch, so the audit under-reports rather than over-reports — a false mismatch would send
  someone renaming art that was fine. Four of the seven disagreements withhold a suggested name for
  the same reason.

**What the pipeline cannot tell you.** Nothing here measures whether the content is *good*. It
measures whether it is grounded, whether it covers what it was asked to cover, and whether it
contradicts the source. Those are all answerable. Whether a line is worth reading is not, and no
number on the report page should be mistaken for that.

---

## What the critic caught

The critic ran on all 57 items, raised **15 issues** and produced **13 corrections**; a fresh
critic call then re-read every corrected item against the same passages, and **10 of the 13
held**. None of these are stylistic quibbles. Each is the writer filling a gap in the retrieved
passages with what a game like this usually does — the exact failure mode of writing from
fragments, and the reason this stage exists.

Full record, including every passage cited and the two corrections that did not hold:
`out/critique/critique_log.json`. Three of them:

### 1 · A contradiction that inverted the document's reasoning

**State:** `first_launch` — the first launch of the campaign.

| | |
|---|---|
| **Draft** | "Arc it, kid. Circularising is the rest of your tank and you don't have the rest of your tank." |
| **Critic** | `contradicts_gdd`, citing §2.5d |
| **Evidence** | *"The base ship reaches the floor of the band on a ballistic arc with 29.5% of its tank left ... It can technically circularise at the floor, but arrives with 0% left and nothing to deorbit on — so the arc is the first launch's route"* |
| **Why** | The ship **does** have the fuel to circularise. What it does not have is anything left to deorbit on afterwards. The draft gave the right advice for the wrong reason — and the wrong reason is the one the shop label for the first tank upgrade later depends on. |
| **After** | "Arc it, kid. Circularising is the rest of your tank — you'd get up there with nothing left to bring her back down." |
| **Re-check** | pass |

This is the correction I would point at first. It is not a tone note; it is a factual inversion
that would have shipped a tutorial line teaching the player the wrong model of their own fuel
budget, and it survived a fluent, confident draft.

### 2 · A mechanic that does not exist

**State:** `hold_mass_red` — the hold-mass dial crosses into the red zone at a stow.

| | |
|---|---|
| **Draft** | "Red on the scale. That ride down is destructive — let something go, right hand button, and it drifts off clean." |
| **Critic** | `contradicts_gdd`, citing §2.4a and §2.4b |
| **Evidence** | *"every stowed piece is permanent mass for the ride down"* and *"The greed decision is informed but never reversible in flight."* |
| **Why** | The dial goes red **at a stow**, so the mass that tripped it is already banked. RMB releases the piece on the tether, not something out of the hold. The line offers an undo the ship does not have. |
| **After** | "Red on the scale, kid. What's banked is banked, and that ride down is destructive — the next piece you get on the tether, right hand button, let it drift." |
| **Re-check** | pass |

The draft was grounded in a real control (RMB) and applied it to the wrong object. That is the
subtle version of an invented mechanic, and it is the one a reader skims past.

### 3 · A screen that put one game state in two outcomes

**State:** `stranded_d` — ship staged, chute shredded, on a descent that cannot be survived.

| | |
|---|---|
| **Draft** | title: **STRANDED** |
| **Critic** | `contradicts_gdd`, citing §2.7b |
| **Evidence** | *"(d) ship staged, chute shredded, on a descent whose minimum achievable touchdown speed exceeds the destruction cap ... **resolved immediately as 0 HP** rather than flown out in real time."* |
| **Why** | Clause (d) is a branch of the unwinnability check, but the document resolves it as 0 HP, not as stranded. §2.7 opens by saying every reachable end state resolves to **exactly one** outcome, so a screen headed STRANDED breaks the partition — and the screen contradicted itself too, because its own `rule_broken` already said the check resolves it as 0 HP. |
| **After** | title: **SHIP DESTROYED**, and the cause gained *"The check called it there rather than making you fly the fall out."* |
| **Re-check** | pass |

This is the one I did not expect an automated stage to find. It is not a wording problem: it is
a formal property of §2.7 — one state, one outcome — being violated by a screen title, and the
critic found it by reading the detector's own sentence.

### The three that did not hold — and the correction that introduced the break

`collapsed_dish_frame`, `shredded_antenna_mesh` and `burst_pressurant_sphere` were corrected and
then flagged again by the re-check. They **shipped that way**, flagged, and all three are the same
mistake — one the *correction* put there:

| | |
|---|---|
| **Shipped** | "eighty-odd kilos, and it pays what **the low band** pays" |
| **Re-check** | `contradicts_gdd`, citing §5b and §4.3 |
| **Why** | *"'the low band' is the discrete-band scheme by name — the exact thing §5b says was replaced and §4.3 lists as cut. Value interpolates continuously on altitude from 1.0 at the floor to 5.5 at the ceiling; there is no low band to pay a low-band rate."* |

This is the most instructive failure in the run. The first critic pass told the writer to stop
restating raw altitudes, the writer reached for the natural phrase — "the low band" — and that
phrase names a system the design document explicitly removed. **A correction is a draft too**, and
the only reason this was caught is that the re-check is a fresh call with no memory of having
written the fix. A pipeline that trusted its own corrections would have shipped a tutorial-adjacent
line describing a mechanic that does not exist, in three places.

It is not fixed here, deliberately. A second correction round produces a third opinion, not a
better line, and the report prints the standing verdict beside each correction so a fix that did
not hold shows up as one instead of being quietly counted.

**One of the three is a referral, not a verdict.** On `shredded_antenna_mesh` the critic wrote:

> "The record the game loads calls this a shredded mesh; the display name and the flavour ('A long
> shaft strung with short crossbars') describe a boom, with no mesh anywhere in the line. That is a
> different object, not a rewording. **I have left the name and the description alone because I
> cannot see the sprite** — if the picture is a boom, this is a finding about what the game calls
> the piece, and the art audit is the stage that settles it."

The critic worked out the limit of its own evidence and named the stage that has the missing half.
The art reader, which does see it, called that sprite *"a crossed array of rods"* — so the writing
is right and the catalogue's name is wrong. Two stages, neither able to reach that conclusion
alone, and no human in the loop to join them up.

### One finding that is about the repository, not the writing

The critic raised a `contradicts_gdd` it could not fix, and it is the most useful thing it said:

> §4.3 lists "Size classes, fragile flag, compactor, crane magnet, oversized junk" as **cut from
> scope** — "Every piece is one slot" — and `crew/out/data/debris_catalog.json`, the file the
> game will actually load, still ships `size_class` on all 30 rows — three of them `oversized`
> — and `fragile` on 12. The tuning crew's Spec Auditor still checks rules about both.

That is a collision between the design document and the artifact, not inside the writing. The
critic's charter tells it to raise that once and then leave the fiction alone, because the table
is what the game will spawn — and to keep failing anything that goes *past* the flag into a
system nobody defined, which is what it did to the bulkhead. Reconciling the two files is a
decision for a human, and it is now written down instead of being absorbed silently by whichever
agent noticed it last.

---

## The tweak I made, with before and after

**A retrieval change, measured — not a claim.** The retired retriever is still in
`lib/retrieve.js` as the `overlap` scorer and still runs on every invocation, so this table is
recomputed by the pipeline rather than remembered. It also has its own test.

The pipeline started with the obvious first implementation: **each section is one chunk, scored
by how many query terms appear in it.** Both halves of that are wrong in the same direction.
§2.2 is 6,400 characters, so it out-scores shorter and more relevant passages on length alone —
and §3, the section about how the game gets *built* (agent architecture, token budgets, sweep
scheduling), kept winning questions about what the player sees, because its QA-invariant list
mentions every rule in the game once.

**After: split sections at sentence boundaries to about 1,100 characters, and score with BM25**
— which adds inverse document frequency, so a term in every chunk stops counting, and length
normalisation, so a long chunk stops winning for being long.

Scored against the section a human labelled as the answer for each of the 27 states, in
`lib/items.js`, written by reading the document and **before either retriever was run**.

| | before | after |
|---|---|---|
| chunks in the index | 15 | 48 |
| mean chunk size | 2,918 chars | 911 chars |
| **precision@1** | **74%** | **100%** |
| recall@3 | 100% | 100% |
| characters retrieved per query | 14,875 | 3,028 |
| §3/§4 **winning** a player-facing query | 4 of 27 | **0** |
| §3/§4 anywhere in the top 3 | 29 | 14 |

The four queries §3 won outright under the old retriever were `chute_green`, `hard_landing`,
`refused` and `stranded_d` — four of the states whose whole job is to teach the player a rule.
Each would have been written from a passage about sweep scheduling.

The characters-per-query row is the one that matters most for grounding: five times less
document per item, at higher precision. That is what makes the claim "written from the retrieved
passages" mean something.

**Four smaller changes, every one of them found by a live run rather than by reading the code:**

- **The re-check was not given the loot table.** The first critic call received the catalog's
  mechanical fields; the re-check call was built inline and did not. So the re-check failed
  three pieces for stating masses — "half a tonne", "a tonne of ground glass" — that the table
  it had not been shown states as 510 kg and 930 kg. The per-type inputs are now defined once
  and used by both calls. This is the change I would most want a reviewer to notice, because
  the symptom looked like a critic being pedantic and the cause was a missing argument.
- **The critic's number rule said "the passages", and the table is a source too.** Even with the
  table in front of it, the charter told it to check numbers against the passages. It now says
  to check against everything in the prompt, and that the table settles superlatives among its
  own rows.
- **A schema gate that bounces a valid finding costs you the finding.** The critic tried to
  rewrite `grounded_in` alongside the text; the schema rejected the whole object; the retry came
  back having re-derived its judgement and quietly dropped three of its four findings — 4
  revisions became 1. Citations are the writer's record of what it was shown, not the critic's
  to edit, so the fix is on both sides: the charter says so explicitly, the schema now tolerates
  the field rather than bouncing the object, and `applyCorrections` drops any non-text field and
  reports the verdict as unresolved instead of silently applying it.
- **The `reads_as` vocabulary was hardcoded as `small | medium | large`.** The catalog's top
  class is `oversized`, so three pieces failed a check for describing an oversized dish as
  "large" — correct writing, out-of-date enum. The vocabulary is now read from the catalog's own
  `size_classes`. The same mismatch existed on altitude: the check used halves of the band while
  the writer's own prompt said thirds, so three pieces in the middle third were tagged `low` by
  a writer that had been told they were in the middle, and the check passed them. Both now read
  thirds.

---

## Files

```
content/
  run-content.js              the orchestrator — deterministic, contains no model
  agents/
    bark-writer.md            18 state-triggered radio lines
    debris-flavourist.md      30 display names and flavour lines
    postmortem-writer.md      9 end-of-run screens
    lore-critic.md            the gate — reads content against its sources
    art-reader.md             says what a sprite shows; never told its name
    art-matcher.md            name vs. drawing; never shown a picture
  schemas/                    the output contract for each agent
  lib/
    chunk.js                  section-aware, sentence-bounded chunking
    retrieve.js               BM25 and the retired overlap scorer it replaced
    items.js                  every query, and the hand-written retrieval labels
    prompt.js                 passages printed once, cited per item
    verify.js                 the checks that are code rather than judgement
    escalate.js               the circuit breaker — collects what the loop could not settle
    render.js                 the report page, computed from the run's own data
    sheet.js                  a PNG codec and the contact-sheet tiler, zlib only
    art.js                    the art stage: sheet planning and the two prompts
    artsheet.js               the art review page — embeds the pack, never published
  test/                       63 tests against a fake CLI — see CLAUDE.md
  data/                       the catalog and sprite-map snapshots a replay reads
  stubs/                      recorded agent output; what `--stub` replays
  out/                        everything a run produces
```

## Flags

```
node run-content.js                 live
node run-content.js --stub          replay, no model calls, no credentials
node run-content.js --record        live, then save the logs as replay fixtures
node run-content.js --reuse a,b     replay these agents, run the rest live
node run-content.js --gdd <file>    a different design document
node run-content.js --catalog <f>   a different debris catalog
node run-content.js --art <dir>     read and audit the sprites in this folder
node run-content.js --no-art        skip the art stage even where art is present
node run-content.js --out <dir>     write artifacts somewhere else
```

`--reuse` takes agent labels — `bark-writer`, `lore-critic.debris`, `lore-critic.barks.rev1`,
`art-reader.sheet1`, `art-matcher` — which is how you iterate on one charter without paying for
the other eleven calls.

`--art` accepts any folder of PNGs. Sprites are matched to pieces through
`config/debris_sprites.json` if it exists, and otherwise by filename: a folder holding
`cracked_solar_array.png` needs no mapping file at all. A catalogue piece with no sprite is a hard
error rather than a warning — an unmapped piece would shift every later cell number, and the point
of the stage is that the mapping gets audited rather than trusted.

## Relationship to the rest of the game

Zero dependencies. It shares `../crew/lib/` — the agent runner, the schema validator and the
envelope parser — with the game's two sibling agent crews rather than copying them, in one
direction only, so each still runs standalone. Those two crews are deliberately not in this
repository: a nine-agent board that reviews the design document, and a five-agent tuning crew
whose flight simulator produces the debris catalog and the game's balance parameters.

It **reads** `config/debris_catalog.json` and never writes to it. In the game repository that file
is owned by the tuning crew and a live crew run rewrites it, so `--record` snapshots the catalog
and the sprite map into `data/` alongside the fixtures, and `--stub` reads the snapshots.
Otherwise a replay would be describing pieces whose masses had since changed, or attaching a
recorded reading of one sprite to a piece that has since been re-mapped to another.
