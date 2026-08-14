'use strict';
// What the pipeline is asked to write, and what it retrieves in order to write each thing.
//
// This file is data, not logic, and it is separate from the orchestrator on purpose: the
// queries ARE the retrieval half of the pipeline, so a grader should be able to read them
// without reading any control flow. Change a query here and the report page's
// query -> chunk -> output columns change with it.
//
// Rules the queries follow:
//
//   * A query is written from the GAME STATE, never from the answer. "hold mass readout
//     amber zone stow soft hard destructive" is a description of the moment the line fires.
//     If a query named the passage it wanted, retrieval would be a lookup table with extra
//     steps and the report's middle column would prove nothing.
//   * Numbers belong in queries. The retriever indexes "8,000" and "3,600", and a query that
//     carries the number the state is about pulls back the sentence that states it — which
//     is what gives the critic something to check a generated number against.
//   * The three lines the design document already contains are listed here as canon, not
//     generated. They are the voice target, they are passed to the generator as examples,
//     and the generator is forbidden to re-write them.

// The lines that already exist in the GDD. §1 quotes two and §2.5 quotes a third — the brief
// for this assignment names only the first two, and the third is easy to miss because it is
// parenthetical inside a sentence about the economy rather than presented as a bark.
const CANON_BARKS = [
  {
    id: 'plasma_chute_warning',
    state: 'Plasma is up and the player reaches for the parachute',
    line: "Chute stays packed while she's glowing, kid",
    source: '§1',
  },
  {
    id: 'module_first_sighted',
    state: "First time the player crosses half-envelope and the module's glint renders overhead",
    line: "See her glinting up there? That's the one. Not yet, kid.",
    source: '§1, §2.6',
  },
  {
    id: 'free_turnaround',
    state: 'One of the first three turnarounds, which Armstrong does not charge for',
    line: "Teaching's part of the debt, kid",
    source: '§2.5',
  },
];

// One standing query, run once per content type and pooled with the per-item retrievals.
//
// It exists because voice is not a state. Every per-item query above describes a mechanical
// moment, so every per-item query retrieves a mechanical passage — and a generator handed
// nothing but rules writes like a manual. This query asks the document how it talks about
// itself, and §1 is where it answers. It is logged like any other query, with its own row
// on the report, because a passage nobody can see in the log is a passage that did not
// really come from retrieval.
const VOICE_QUERY =
  'Armstrong narrates over the radio a dozen state-triggered one-liners carrying the tutorial ' +
  'hints and the characterization the graded endings pay off blue-collar scrapyard spaceflight ' +
  'handmade spacecraft junkyard owner fronts your launches against your next haul you are in his debt';

// The states to write. `trigger` is the detector in the game's own terms — it is what makes
// each of these a state-triggered bark rather than a mood piece — and `job` says what the
// line has to accomplish, because §1 asks these lines to carry the tutorial and the
// characterisation at the same time.
const BARK_STATES = [
  {
    id: 'first_launch',
    expect: ['2.5', '2.6', '1'],
    state: 'The first launch of the campaign, engine lit, still on the pad',
    trigger: 'run_index == 0 && thrust first applied',
    job: 'tutorial: this first flight is a ballistic arc, not an orbit',
    query: 'first launch ballistic arc never pays for circularisation short working window base ship reaches floor of the band 29.5% tank left 97 second EVA window',
  },
  {
    id: 'climb_heat_first',
    expect: ['2.2'],
    state: 'The heat bar first moves on the way up, during the ascent',
    trigger: 'ascent && heat > 0 && first time this run',
    job: 'tutorial: the bar fills on the climb too, and this one is survivable',
    query: 'heat bar fills on the way up as well as down climb crosses threshold 583 m/s peaks 47.5 bar units ascent exempt survivable first lesson',
  },
  {
    id: 'staged',
    expect: ['2.2'],
    state: 'The player stages, jettisoning thruster and tank and exposing the shield',
    trigger: 'stage() fires',
    job: 'tutorial: staging is one-way and there is no thrust after it',
    query: 'staging one-way jettisons thruster and tank no thrust after heat shield sits behind exposed only by staging shape your descent while you still have an engine',
  },
  {
    id: 'commit_floor_blocked',
    expect: ['2.2'],
    state: 'The player tries to aim a committed entry shallower than the commit floor',
    trigger: 'entry aim clamped at reentry.commit_floor_m',
    job: 'tutorial: the aim indicator stopped for a reason, and the reason is the ship',
    query: 'commit floor 8,000 m may not commit to an entry shallower minimum commit angle salvaged RCS can hold scrap ship aim entry from orbit hard stop aim indicator',
  },
  {
    id: 'skim_complete',
    expect: ['2.2'],
    state: 'A braking pass ends and the ship comes back out of the atmosphere',
    trigger: 'braking pass exits the interface',
    job: 'tutorial: passes shed speed, and each one costs more plate than the last',
    query: 'braking pass skim dips into upper atmosphere sheds speed comes back out escalating thermal toll grows per cycle feathering costs 847% of plate first pass does most of the work',
  },
  {
    id: 'first_plasma',
    expect: ['2.2'],
    state: 'Plasma appears for the first time in the campaign',
    trigger: 'speed > plasma threshold in atmosphere && first time',
    job: 'tutorial: this is the state the CHUTE lamp is about',
    query: 'plasma appears above a velocity threshold parachute deployed during plasma shreds hull glow and audio telegraphed CHUTE lamp red',
  },
  {
    id: 'chute_green',
    expect: ['2.2'],
    state: 'Plasma clears and the salvaged CHUTE lamp flips from red to green',
    trigger: 'chute_lamp transitions red -> green',
    job: 'tutorial: the deploy sequence is chute, then gear',
    query: 'plasma clears salvaged CHUTE lamp flipping red to green deploy chute then gear one-boolean caution light',
  },
  {
    id: 'shield_spent',
    expect: ['2.2'],
    state: 'The shield plate runs out and the hold starts burning',
    trigger: 'shield_hp <= 0 && heat pinned at capacity',
    job: 'tutorial: cargo burns before the hull, nearest the shield first',
    query: 'shield spent cargo burns one slot per 3 seconds bar pinned at capacity nearest the shield propagating up the hold slag value zero mass retained hull damage begins after all cargo',
  },
  {
    id: 'hold_mass_amber',
    expect: ['2.4'],
    state: "The suit's hold-mass dial crosses from green into amber at a stow",
    trigger: 'hold_mass crosses scale.amber_kg on stow',
    job: 'tutorial: at this mass a competent chute deploy lands hard, not soft',
    query: 'suit carries a salvaged scale hold-mass readout updated at each stow dial painted into three zones green amber red competent chute deploy lands soft hard or destructive',
  },
  {
    id: 'hold_mass_red',
    expect: ['2.4'],
    state: 'The hold-mass dial crosses into red at a stow',
    trigger: 'hold_mass crosses scale.red_kg on stow',
    job: 'tutorial: the ride down is now destructive, and release is the remedy',
    query: 'hold mass red zone destructive landing every stowed piece is permanent mass for the ride down greed decision informed but never reversible in flight release is instant and clean',
  },
  {
    id: 'return_lamp_red',
    expect: ['2.4'],
    state: 'The RETURN lamp goes red while the astronaut is towing a piece',
    trigger: 'return_lamp transitions green -> red',
    job: 'tutorial: drop the piece; the lamp is about fuel and distance, not heat',
    query: 'RETURN lamp red when a bare suit tethered piece dropped at current fuel and drift could no longer reach tether range of the ship towing narrows the margin fast release RMB is always the first remedy',
  },
  {
    id: 'tow_fee_charged',
    expect: ['2.5'],
    state: 'The run ends away from the pad and the haul sells minus a tow fee',
    trigger: 'landed && distance_from_pad > tow.free_radius_m',
    job: 'characterisation: the drone net is a service and it is billed',
    query: 'landing away from the junkyard costs a tow fee free inside a short radius 1,200 m rising linearly clamped at 50% of the haul value a bad landing site is a bill never a wiped run drone recovery net',
  },
  {
    id: 'hard_landing',
    expect: ['2.3'],
    state: 'Touchdown above the soft-landing threshold, ship intact',
    trigger: 'landed && vertical_speed > landing.soft_ms',
    job: 'tutorial: the chute had to come out earlier than that',
    query: 'landings graded by vertical speed soft under 5 m/s damage scales past that capped per touchdown no gear doubles it soft landings require deploying the chute early enough to shed speed',
  },
  {
    id: 'module_tethered',
    expect: ['2.6'],
    state: 'The module is tethered for the first time; delivery terms are stated',
    trigger: 'module tethered && first time',
    job: 'characterisation and terms: pristine wins, damaged pays less, scrap is refused',
    query: 'Armstrong states these delivery terms over the radio the first time the module is tethered pristine damaged scrap condition at touchdown selects the outcome triumph disappointment refused',
  },
  {
    id: 'module_degraded',
    expect: ['2.6'],
    state: 'The module drops one condition state, pristine to damaged or damaged to scrap',
    trigger: 'module.state decrements',
    job: 'characterisation: he can see it, and the grade is not held back for touchdown',
    query: 'module cannot be destroyed only degraded pristine damaged scrap dropping one state per sustained heat exposure and one per hard touchdown sprite visibly scorches Armstrong barks at each state change never a surprise held for touchdown',
  },
  {
    id: 'burned_up',
    expect: ['2.4', '2.7', '1'],
    state: 'The astronaut is caught outside in atmosphere above the heat-speed threshold',
    trigger: 'terminal state Burned up',
    job: 'the loss is cheap and repeatable; the suit was never rated for it',
    query: 'burned up astronaut on EVA in atmosphere above the heat-speed threshold suit has no heat protection fuel is no defense F is inert once heat builds loss',
  },
  {
    id: 'ending_pristine',
    expect: ['1', '2.6'],
    state: "Pristine module delivered — Armstrong's triumph, the campaign's win",
    trigger: 'Landed && module.state == pristine',
    job: 'the ending: this is personal, and it is a first-attempt-only triumph',
    query: 'Apollo-era service module Armstrong flew that program as a young man worth more than its mass because it is worth more to him pristine wins Armstrong triumph first-attempt-only',
  },
  {
    id: 'ending_refused',
    expect: ['2.6', '2.7'],
    state: "Scrap-state module delivered — Armstrong's fury, a loss",
    trigger: 'terminal state Refused',
    job: 'the ending that is a loss: he will not take it, and the drones re-park it',
    query: 'scrap is refused Armstrong fury a loss the run resets and the drones return the module to orbit for a re-fly reset to damaged the scar persists',
  },
];

// The five §2.7 terminal states plus the four stranded sub-cases. `landed` is in the list
// because §2.7 puts it in the partition; its screen is the one that is not a post-mortem,
// and having it there is what makes the set a partition rather than a list of deaths.
const POSTMORTEM_STATES = [
  {
    id: 'landed',
    expect: ['2.7'],
    state: 'Landed',
    detector: 'ship grounded, staged, and crewed',
    query: 'Landed ship grounded staged and crewed run ends haul auto-sells net of any tow fee a module aboard in pristine or damaged state commits its ending success',
  },
  {
    id: 'refused',
    expect: ['2.7', '2.6'],
    state: 'Refused',
    detector: 'a module delivered in scrap state',
    query: 'Refused a module delivered in scrap state loss the run resets and the drones return the module to orbit for a re-fly Armstrong fury',
  },
  {
    id: 'zero_hp',
    expect: ['2.7', '2.2'],
    state: '0 HP',
    detector: 'ship destroyed on a hard landing, or by reentering too hot',
    query: '0 HP ship destroyed on a hard landing or by reentering too hot bar pinned at capacity long enough to burn through plate then cargo then hull feathering an endless string of braking passes escalating toll',
  },
  {
    id: 'burned_up',
    expect: ['2.4', '2.7', '1'],
    state: 'Burned up',
    detector: 'astronaut on EVA in atmosphere above the heat-speed threshold',
    query: 'Burned up astronaut on EVA in atmosphere above the heat-speed threshold loss suit has no heat protection crossing the interface is only fatal above the heat-speed threshold',
  },
  {
    id: 'stranded',
    expect: ['2.7'],
    state: 'Stranded',
    detector: 'the run can no longer reach a landing and no recovery input remains',
    query: 'Stranded a single unwinnability check fires when the run can no longer reach a landing and no recovery input remains warp is disabled the instant this check arms loss',
  },
  {
    id: 'stranded_a',
    expect: ['2.7'],
    state: 'Stranded (a)',
    detector: 'ship undeorbitable — out of fuel, or staged so the tank is gone — on an arc whose periapsis never enters the atmosphere',
    query: 'ship undeorbitable out of fuel or staged so the tank is gone on an arc whose periapsis never enters the atmosphere staging is one-way no thrust after a staged ship on a braking pass is not stranded',
  },
  {
    id: 'stranded_b',
    expect: ['2.7', '2.4'],
    state: 'Stranded (b)',
    detector: 'astronaut jetpack-dry beyond tether reach of the ship',
    query: 'astronaut jetpack-dry beyond tether reach of the ship magnet also grips the hull fire it at the hull from anywhere in tether range and winch yourself home a dry jetpack within reach is an inconvenience RETURN lamp',
  },
  {
    id: 'stranded_c',
    expect: ['2.7'],
    state: 'Stranded (c)',
    detector: 'astronaut touching terrain while not aboard the ship',
    query: 'astronaut touching terrain while not aboard the ship an uncrewed ship grounding is a non-event the ship parks inert board the parked ship Landed touch terrain not aboard stranded slow descent to the ground is survivable',
  },
  {
    id: 'stranded_d',
    expect: ['2.7', '2.3'],
    state: 'Stranded (d)',
    detector: 'ship staged, chute shredded, on a descent whose minimum achievable touchdown speed exceeds the destruction cap',
    query: 'ship staged chute shredded on a descent whose minimum achievable touchdown speed exceeds the destruction cap a conservative closed-form check resolved immediately as 0 HP rather than flown out in real time parachute deployed during plasma shreds',
  },
];

// Debris queries are built from the piece's own mechanical fields, because the constraint
// this content type has to satisfy is that the fiction match the mechanics. A 1,600 kg piece
// at 276,000 m has to retrieve the passage about mass and altitude rising together, or the
// generator has nothing to make it read heavy from.
function debrisQuery(piece, band) {
  const third = altitudeThird(piece.altitude_m, band);
  const parts = [
    `junk value and altitude one continuous orbital band ${band.min} to ${band.max} m value multiplier interpolates on altitude 1.0 at the floor to 5.5 at the ceiling`,
    `piece at ${piece.altitude_m} m mass ${Math.round(piece.mass_kg)} kg ${piece.size_class} ${third} of the band`,
    'value scales with mass on top of the altitude gradient the good stuff fights you on the tether and on the way down cheap scrap panels low denser and more valuable wreckage the higher you go',
  ];
  if (piece.fragile) {
    parts.push('fragile piece will not survive a hot pass or a hard flare crushing and fragility slag retains mass with zero value');
  }
  return parts.join(' ');
}

function altitudeThird(alt, band) {
  const f = (alt - band.min) / (band.max - band.min);
  return f < 1 / 3 ? 'bottom third' : f < 2 / 3 ? 'middle third' : 'top third';
}

module.exports = {
  VOICE_QUERY,
  CANON_BARKS,
  BARK_STATES,
  POSTMORTEM_STATES,
  debrisQuery,
  altitudeThird,
};
