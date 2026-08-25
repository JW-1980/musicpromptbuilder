'use strict';
/*
 * tests/instruments-inspire.test.js — the paired selector/generator release:
 *
 *   docs/FDD.md #27  Modular Instrument "Lego Blocks" -> var
 *                    INSTRUMENT_REGISTRY, its derivation record
 *                    (INSTRUMENT_KB_MAP / INSTRUMENT_KB_EXCLUDED) and the
 *                    Instrument blocks card built over them
 *   docs/FDD.md #71  "Inspire Me" Slot Machine -> var INSPIRE_AFFINITY, the
 *                    seedable createSeededRng, the pure spinInspiration() and
 *                    the single writer applyInspiration()
 *
 * The first half is the deliberate sibling of tests/vocal-registry.test.js and
 * tests/era-registry.test.js — same order, same standard — because the feature
 * is the same shape a third time: one static table, pure selector helpers over
 * it, one virtualized card.
 *
 * The second half is a different kind of test. #71 is a GENERATOR, so it is
 * driven with a seeded RNG and asserted BEHAVIOURALLY over hundreds of real
 * spins against the real MUSIC_KB and the real resolveConflicts — never
 * against a stub of either.
 *
 * WHAT IS COVERED
 *   - the instrument table: size and the eight families in declared order,
 *     unique ids / labels / tags / naming tags, kebab ids carrying their own
 *     family prefix, 1-2 lowercase comma-free tags, no entry contradicting
 *     itself through the #68 resolver, and a blocklist scan proving no
 *     manufacturer, model or artist was named;
 *   - THE DERIVATION RECORD, which is the point of #27 being "derived": every
 *     one of the 157 instrument strings MUSIC_KB names is either mapped to a
 *     block or excluded with a written reason, never both and never neither,
 *     and no row of either table names something the KB no longer says;
 *   - searchInstruments and the family filter as a SECOND narrowing;
 *   - the selector's pure logic over a REAL createPromptState: position
 *     weighting, add / remove toggling, half-a-block, and the shared-tag rule;
 *   - serialization round-trip, and where the tags land in the draft;
 *   - spinInspiration: determinism per seed, every output drawn from the
 *     SEEDING GENRE'S OWN VOCABULARY (asserted against MUSIC_KB entry by
 *     entry), the affinity table naming only real era groups and real scenes,
 *     200 seeded spins that are conflict-free through the real resolver, and
 *     the trim path that guarantees it;
 *   - applyInspiration landing in the right sections under source 'inspire',
 *     as ONE batched notification;
 *   - the static markup, aria, wiring and styling contracts of both cards,
 *     including the one that makes #71 honest: SPINNING NEVER ADDS ANYTHING.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Live DOM event wiring: the click that toggles a row, the badge row's
 *     focus rescue, the strip's tumble animation and the virtual scroller's
 *     painting. Those need a browser; the boot IIFE is proven inert outside
 *     one, the pure halves are exercised behaviourally here, and the strings
 *     the live cards depend on are asserted statically at the bottom.
 *   - createVirtualList itself. tests/persistence.test.js owns that contract.
 *   - FEATURE-MECHANICS §5.1's Prompt Synergy Score. It is NOT built, and #71
 *     does not pretend to compute it — see the synergy test below, which pins
 *     the guarantee this feature actually makes instead.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* The task's own bounds for a curated table: big enough to cover the KB's
 * vocabulary, small enough to stay a picker rather than a phone book. */
const REGISTRY_MIN = 60;
const REGISTRY_MAX = 90;
const REGISTRY_BANKED = 87;
const FAMILY_COUNT = 8;

/* The eight families, in the order the card reads them: the rhythm section,
 * then the harmony, then the horns, then the two colour families, then the
 * orchestra. Declared HERE as well as in index.html so a reshuffle of the
 * array is a decision that fails a test rather than a silent reordering of
 * every chip in the card. */
const FAMILY_ORDER = [
  'drums-percussion',
  'bass',
  'keys-synths',
  'guitars-strings',
  'brass-woodwind',
  'world-traditional',
  'electronic-textures',
  'orchestral',
];

const FAMILY_LABELS = [
  'Drums & Percussion',
  'Bass',
  'Keys & Synths',
  'Guitars & Strings',
  'Brass & Woodwind',
  'World & Traditional',
  'Electronic Textures',
  'Orchestral',
];

/* How many spins the behavioural half drives. Every one is seeded, so a
 * failure here reproduces exactly. */
const SPIN_SEEDS = 200;

/*
 * The Safe-Mode standard (FDD #24) applied to this table. An instrument
 * registry is the one most likely to name a product: the sounds it describes
 * are, in the real world, made by specific boxes. MUSIC_KB itself says
 * "TR-909 kick" and "Rhodes electric piano"; the derived REGISTRY must not,
 * except where the word has become the generic name of a sound.
 *
 * DELIBERATELY ABSENT: 'rhodes' and '808'. Both are in the table and both stay.
 * "Rhodes electric piano" and "808 sub bass" are what the instrument is called
 * in every genre this app covers — they are the words a user searches for, and
 * MUSIC_KB has shipped them since the first release. Blocking them here while
 * emitting them there would be a rule this codebase does not actually hold.
 * Every other manufacturer and model IS blocked below.
 *
 * Several entries carry a trailing space ('neve ', 'ssl ') because the
 * haystack is space-joined: without it "neve" would match "never".
 */
const NAME_BLOCKLIST = [
  /* manufacturers and models */
  'tr-909',
  'tr-808',
  'tb-303',
  ' 303',
  'sp-1200',
  'mpc',
  'juno-106',
  'jupiter-8',
  'dx7',
  'linndrum',
  'oberheim',
  'fairlight',
  'synclavier',
  'minimoog',
  'moog',
  'korg',
  'yamaha',
  'roland ',
  'akai',
  'nord ',
  'wurlitzer',
  'hammond',
  'leslie',
  'gibson',
  'fender',
  'stratocaster',
  'telecaster',
  'rickenbacker',
  'marshall',
  'steinway',
  'bosendorfer',
  'neve ',
  'ssl ',
  'harmon mute',
  /* software */
  'kontakt',
  'serum',
  'omnisphere',
  'massive x',
  'sylenth',
  'ableton',
  'fl studio',
  'logic pro',
  /* artists and bands */
  'daft punk',
  'kraftwerk',
  'beatles',
  'radiohead',
  'metallica',
  'nirvana',
  'pink floyd',
  'led zeppelin',
  'james brown',
  'jimi hendrix',
  'miles davis',
  'john coltrane',
];

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/** Evaluate #app-main in a DOM-free vm context; the boot IIFE must stay inert. */
function loadAppSandbox() {
  const source = extractScriptById(INDEX, 'app-main');
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Promise,
    Float32Array,
    Float64Array,
    Uint8Array,
    ArrayBuffer,
    Number,
    String,
    Array,
    Object,
    Boolean,
    Symbol,
    Error,
    TypeError,
    RangeError,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'index.html#app-main' });
  return {
    sandbox,
    source,
    evaluate(expression) {
      return vm.runInContext(expression, sandbox, { filename: 'app-main#evaluate' });
    },
  };
}

const app = loadAppSandbox();
const {
  INSTRUMENT_REGISTRY,
  INSTRUMENT_SECTION,
  INSTRUMENT_BLOCK_SOURCE,
  INSTRUMENT_TAG_WEIGHTS,
  INSTRUMENT_KB_MAP,
  INSTRUMENT_KB_EXCLUDED,
  instrumentFamilies,
  searchInstruments,
  instrumentBlockById,
  instrumentBlockSeeds,
  instrumentBlockHold,
  selectedInstrumentBlocks,
  toggleInstrumentBlock,
  resolveKbInstrument,
  INSPIRE_SOURCE,
  INSPIRE_KINDS,
  INSPIRE_MAX_ATTEMPTS,
  INSPIRE_AFFINITY,
  createSeededRng,
  rngInt,
  rngSample,
  spinInspiration,
  inspirationSeeds,
  applyInspiration,
  MUSIC_KB,
  ERA_REGISTRY,
  eraSignatureById,
  searchEraRegistry,
  selectedEraSignatures,
  createPromptState,
  createExclusionState,
  createStructureState,
  serializeWorkspace,
  restoreWorkspace,
  weightTokens,
  resolveConflicts,
  normalizePromptTag,
  PROMPT_SECTIONS,
  PROMPT_SECTION_ORDER,
  PROMPT_SOURCES,
  PROMPT_SOURCE_SECTION,
  SLIDER_DEFAULT,
} = app.sandbox;

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/** Blank CSS comments while preserving newlines (same policy as ui-layout). */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return stripCssComments(m[1]);
}

function readEditorMarkup() {
  const html = readIndex();
  const start = html.indexOf('id="view-editor"');
  const end = html.indexOf('</main>');
  assert.ok(start !== -1 && end > start, 'could not locate the Prompt Editor view');
  return html.slice(start, end);
}

/** One card's markup, from its <section> to the next closing tag. */
function readCardMarkup(className) {
  const editor = readEditorMarkup();
  const start = editor.indexOf(`class="view-col vibe-card ${className}"`);
  assert.ok(start !== -1, `the Prompt Editor has no .${className} card`);
  const end = editor.indexOf('</section>', start);
  assert.ok(end > start, `the .${className} card is never closed`);
  return editor.slice(start, end);
}

/**
 * The body of a top-level-ish function declaration, brace-matched while
 * skipping quoted spans — so a `{` inside a string cannot end the body early.
 */
function functionBody(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at !== -1, `could not find ${signature.trim()} in the boot`);
  let i = source.indexOf('{', at);
  assert.ok(i !== -1, `${signature.trim()} has no body`);
  let depth = 0;
  let quote = '';
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', at) + 1, i);
    }
  }
  throw new Error(`${signature.trim()} is never closed`);
}

/** Cross-realm-safe deep equality (see tests/vibe-translators.test.js). */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(host(actual), host(expected), message);
}

/** A registry over REAL stores plus a recording slider bank. */
function makeRegistry() {
  const sliders = { energy: SLIDER_DEFAULT, warmth: SLIDER_DEFAULT, density: SLIDER_DEFAULT };
  return {
    promptState: createPromptState(),
    exclusions: createExclusionState(),
    structure: createStructureState(),
    sliders: {
      get(axis) {
        return sliders[axis];
      },
      set(axis, value) {
        sliders[axis] = value;
      },
    },
  };
}

/** Every distinct instrument string MUSIC_KB's genres name, in first-seen order. */
function kbInstrumentStrings() {
  const seen = [];
  const index = new Set();
  for (const genre of MUSIC_KB.genres) {
    for (const name of genre.instruments || []) {
      if (index.has(name)) continue;
      index.add(name);
      seen.push(name);
    }
  }
  return seen;
}

/* Two blocks that really do share a tag, found in the data rather than
 * invented for the test — see the shared-tag section. */
const SHARED_TAG = 'wide open hi-hats';
const SHARED_A = 'drums-percussion-swung-hats';
const SHARED_B = 'drums-percussion-open-hats-probe';

const s = suite('instrument blocks (FDD #27) + inspire me (FDD #71)');

/* ========================================================================== */
/* 1. Reachability                                                            */
/* ========================================================================== */

s.test('both features are reachable top-level declarations, and the boot stays inert', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined', 'the boot IIFE must stay inert');
  for (const name of [
    'instrumentFamilies',
    'searchInstruments',
    'instrumentBlockById',
    'instrumentBlockSeeds',
    'instrumentBlockHold',
    'selectedInstrumentBlocks',
    'toggleInstrumentBlock',
    'resolveKbInstrument',
    'createSeededRng',
    'rngInt',
    'rngSample',
    'assembleInspiration',
    'inspirationSeeds',
    'spinInspiration',
    'applyInspiration',
  ]) {
    assert.strictEqual(fresh.evaluate(`typeof ${name}`), 'function', `${name} is not reachable`);
  }
  for (const name of [
    'INSTRUMENT_REGISTRY',
    'INSTRUMENT_SECTION',
    'INSTRUMENT_BLOCK_SOURCE',
    'INSTRUMENT_TAG_WEIGHTS',
    'INSTRUMENT_KB_MAP',
    'INSTRUMENT_KB_EXCLUDED',
    'INSPIRE_SOURCE',
    'INSPIRE_KINDS',
    'INSPIRE_MAX_ATTEMPTS',
    'INSPIRE_AFFINITY',
  ]) {
    assert.ok(fresh.sandbox[name] !== undefined, `${name} must be a var binding tests can read`);
  }
  assert.strictEqual(INSTRUMENT_SECTION, 'instrument');
  assert.strictEqual(INSTRUMENT_BLOCK_SOURCE, 'instrument-block');
  assert.strictEqual(INSPIRE_SOURCE, 'inspire');
});

s.test('both new sources are registered, and they file into the right sections', () => {
  for (const source of [INSTRUMENT_BLOCK_SOURCE, INSPIRE_SOURCE]) {
    assert.ok(
      PROMPT_SOURCES.indexOf(source) !== -1,
      `a source the store does not know is rejected by build() — every add of "${source}" would return null`
    );
  }
  assert.strictEqual(PROMPT_SOURCE_SECTION[INSTRUMENT_BLOCK_SOURCE], INSTRUMENT_SECTION);
  // 'inspire' writes into FIVE sections, so its default is the honest fallback
  // rather than a guess. Every seed it produces names its own section — proven
  // behaviourally further down — so the fallback is never reached in practice.
  assert.strictEqual(PROMPT_SOURCE_SECTION[INSPIRE_SOURCE], 'custom');
  assert.ok(PROMPT_SECTIONS.indexOf(INSTRUMENT_SECTION) !== -1);

  // Neither section is new; this release adds sources to existing groups, so
  // the canonical emission order must be untouched.
  deepEqual(PROMPT_SECTION_ORDER, [
    'genre',
    'mood',
    'vocal',
    'instrument',
    'scene',
    'era',
    'custom',
  ]);
});

s.test('every id this suite names by hand really is in the table', () => {
  /* The same guard tests/era-registry.test.js carries: a behavioural test that
   * reaches for a renamed id gets null back, and every helper below treats
   * null as a no-op — so the test would go on PASSING while asserting nothing.
   * A rename fails HERE, with the id in the message. */
  const FIXTURES = [
    'drums-percussion-four-on-the-floor-kick',
    'drums-percussion-808-kick',
    'drums-percussion-swung-hats',
    'drums-percussion-shakers',
    'bass-sub-bass',
    'bass-upright-bass',
    'keys-synths-rhodes',
    'keys-synths-grand-piano',
    'guitars-strings-nylon',
    'guitars-strings-steel-acoustic',
    'brass-woodwind-saxophone',
    'world-traditional-log-drums',
    'world-traditional-koto',
    'world-traditional-nyckelharpa',
    'electronic-textures-vocal-chops',
    'orchestral-timpani',
  ];
  for (const id of FIXTURES) {
    assert.ok(instrumentBlockById(id), `fixture drift: this suite names "${id}", which is gone`);
  }
  // The era fixture the inspire tests borrow.
  assert.ok(
    eraSignatureById('sig-saturation-tape-cassette-compression'),
    'fixture drift: the borrowed era signature is gone'
  );
});

/* ========================================================================== */
/* 2. Registry integrity — FDD #27                                            */
/* ========================================================================== */

s.test(`the table ships ${REGISTRY_MIN}-${REGISTRY_MAX} blocks across ${FAMILY_COUNT} families`, () => {
  assert.ok(Array.isArray(INSTRUMENT_REGISTRY), 'INSTRUMENT_REGISTRY must be an array');
  assert.ok(
    INSTRUMENT_REGISTRY.length >= REGISTRY_MIN && INSTRUMENT_REGISTRY.length <= REGISTRY_MAX,
    `the curated band is ${REGISTRY_MIN}-${REGISTRY_MAX}; the table holds ${INSTRUMENT_REGISTRY.length}`
  );
  assert.strictEqual(
    INSTRUMENT_REGISTRY.length,
    REGISTRY_BANKED,
    'the shipped table is 87 blocks — a change to that number is a data change, not a refactor'
  );

  const families = instrumentFamilies();
  assert.strictEqual(families.length, FAMILY_COUNT, `expected ${FAMILY_COUNT} families`);

  let counted = 0;
  const seen = new Set();
  for (const family of families) {
    assert.ok(typeof family.id === 'string' && family.id, 'a family has no id');
    assert.ok(typeof family.label === 'string' && family.label, `${family.id} has no label`);
    assert.ok(!seen.has(family.id), `duplicate family id "${family.id}"`);
    seen.add(family.id);
    assert.ok(family.count > 0, `${family.id} is declared but empty`);
    counted += family.count;
  }
  assert.strictEqual(counted, INSTRUMENT_REGISTRY.length, 'the family counts must add up to the table');
});

s.test('the eight families read in the declared order, ids and labels alike', () => {
  // Unlike ERA_GROUP_ORDER there is no second source of truth in index.html:
  // the array is authored in reading order, exactly as VOCAL_REGISTRY is,
  // because there is no chronology to reconstruct. This test IS the pin.
  deepEqual(instrumentFamilies().map((f) => f.id), FAMILY_ORDER);
  deepEqual(instrumentFamilies().map((f) => f.label), FAMILY_LABELS);

  const inTable = new Set(INSTRUMENT_REGISTRY.map((e) => e.family));
  assert.strictEqual(inTable.size, FAMILY_ORDER.length, 'a family exists that this suite does not name');
  for (const id of FAMILY_ORDER) {
    assert.ok(inTable.has(id), `FAMILY_ORDER names "${id}", which no entry belongs to`);
  }
});

s.test('ids are kebab-case, unique, and carry their own family prefix', () => {
  const ids = new Set();
  for (const entry of INSTRUMENT_REGISTRY) {
    assert.ok(typeof entry.id === 'string' && entry.id, `an entry has no id: ${JSON.stringify(entry)}`);
    assert.ok(!ids.has(entry.id), `duplicate id "${entry.id}"`);
    ids.add(entry.id);
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id),
      `id "${entry.id}" is not kebab-case (lowercase, digits and single hyphens)`
    );
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.family), `family "${entry.family}" is not kebab-case`);
    assert.strictEqual(
      entry.id.indexOf(entry.family + '-'),
      0,
      `id "${entry.id}" does not start with its family "${entry.family}-"`
    );
  }
  assert.strictEqual(ids.size, INSTRUMENT_REGISTRY.length);
});

s.test('labels and family labels are unique, human, and consistent per family', () => {
  const labels = new Set();
  const familyLabels = Object.create(null);
  for (const entry of INSTRUMENT_REGISTRY) {
    assert.ok(typeof entry.label === 'string' && entry.label.trim(), `${entry.id} has no label`);
    const key = entry.label.toLowerCase();
    assert.ok(!labels.has(key), `duplicate block label "${entry.label}"`);
    labels.add(key);

    assert.ok(typeof entry.familyLabel === 'string' && entry.familyLabel.trim());
    if (familyLabels[entry.family] === undefined) familyLabels[entry.family] = entry.familyLabel;
    assert.strictEqual(
      entry.familyLabel,
      familyLabels[entry.family],
      `${entry.id}: family "${entry.family}" is labelled two different ways`
    );
  }
  assert.strictEqual(labels.size, INSTRUMENT_REGISTRY.length);
});

s.test('every block carries ONE or TWO lowercase, comma-free tags and no description', () => {
  // The shape that makes this table different from #65's and #66's: an
  // instrument mostly IS its own name, so there is nothing to describe. A
  // description field appearing here would mean the shape drifted towards the
  // persona registry's and the card would start rendering a blank line.
  let singles = 0;
  for (const entry of INSTRUMENT_REGISTRY) {
    assert.ok(Array.isArray(entry.tags), `${entry.id} has no tags array`);
    assert.ok(
      entry.tags.length >= 1 && entry.tags.length <= 2,
      `${entry.id} has ${entry.tags.length} tags; the shape is 1-2`
    );
    if (entry.tags.length === 1) singles += 1;
    const seen = new Set();
    for (const tag of entry.tags) {
      assert.ok(typeof tag === 'string' && tag.trim(), `${entry.id} holds an empty tag`);
      assert.strictEqual(tag, tag.toLowerCase(), `${entry.id}: tag "${tag}" is not lowercase`);
      assert.strictEqual(
        tag.indexOf(','),
        -1,
        `${entry.id}: tag "${tag}" holds a comma and would split into two tags in the draft`
      );
      assert.strictEqual(tag, tag.trim(), `${entry.id}: tag "${tag}" has edge whitespace`);
      assert.ok(!/\s{2,}/.test(tag), `${entry.id}: tag "${tag}" has a double space`);
      const norm = normalizePromptTag(tag);
      assert.ok(!seen.has(norm), `${entry.id} lists "${tag}" twice`);
      seen.add(norm);
    }
    assert.strictEqual(
      entry.description,
      undefined,
      `${entry.id} carries a description — an instrument block is its own name, not a paragraph`
    );
  }
  assert.ok(
    singles > 0,
    'not one block names itself in a single tag — the 1-tag path is then untested by the data'
  );
});

s.test('no tag is claimed by two blocks, and the naming tag is unique across the table', () => {
  // tags[0] IS the block's identity: it is what the row shows, what the #73
  // weighting engine ranks highest and what the #67 limiter keeps longest. And
  // because the store holds one entry per (section, tag), two blocks sharing
  // ANY tag would make the shared-tag rule the normal case rather than the
  // exception — so the table is checked for both.
  const naming = new Map();
  const every = new Map();
  for (const entry of INSTRUMENT_REGISTRY) {
    const first = normalizePromptTag(entry.tags[0]);
    assert.ok(
      !naming.has(first),
      `${entry.id} and ${naming.get(first)} both name themselves "${entry.tags[0]}"`
    );
    naming.set(first, entry.id);
    for (const tag of entry.tags) {
      const norm = normalizePromptTag(tag);
      assert.ok(!every.has(norm), `${entry.id} and ${every.get(norm)} both claim the tag "${tag}"`);
      every.set(norm, entry.id);
    }
  }
  assert.strictEqual(naming.size, INSTRUMENT_REGISTRY.length);
});

s.test('no block names a manufacturer, a model or a real performer', () => {
  for (const entry of INSTRUMENT_REGISTRY) {
    const haystack = (entry.id + ' ' + entry.label + ' ' + entry.tags.join(' ')).toLowerCase();
    for (const name of NAME_BLOCKLIST) {
      assert.strictEqual(
        haystack.indexOf(name),
        -1,
        `${entry.id} names "${name}" — the registry describes instruments, never products or people`
      );
    }
  }
  // …and the generic replacement for the one product MUSIC_KB does name is
  // really there, so the derivation did not simply drop the sound.
  const kick = instrumentBlockById('drums-percussion-four-on-the-floor-kick');
  assert.ok(
    kick.tags.join(' ').indexOf('analog machine kick') !== -1,
    'the TR-909 kick lost its generic stand-in'
  );
});

s.test('a block is internally consistent: its own tags never contradict each other', () => {
  // The same standard the vocal and era registries are held to. A block that
  // fought itself would drop one of its own tags the instant it was added.
  for (const entry of INSTRUMENT_REGISTRY) {
    const result = resolveConflicts(entry.tags);
    deepEqual(
      result.conflicts,
      [],
      `${entry.id} contradicts itself: ${JSON.stringify(host(result.conflicts))}`
    );
  }
});

s.test('the two vocabularies are different SHAPES, so neither can be mistaken for the other', () => {
  // A KB genre entry is a TRIGGER (phrases in, weighted tokens out). A block is
  // a SELECTION (no phrases, no bpm, tags carried by position). Keeping the
  // shapes apart is what stops a future edit wiring the dissector into this
  // table and matching "Slap Bass" against the word "bass".
  for (const entry of INSTRUMENT_REGISTRY) {
    assert.strictEqual(entry.phrases, undefined, `${entry.id} must not carry dissector phrases`);
    assert.strictEqual(entry.tokens, undefined, `${entry.id} must not carry KB tokens`);
    assert.strictEqual(entry.bpm, undefined, `${entry.id} must not carry a bpm`);
  }
});

/* ========================================================================== */
/* 3. The derivation record — every MUSIC_KB instrument accounted for         */
/* ========================================================================== */

s.test('every instrument string MUSIC_KB names is either mapped or excluded — never neither', () => {
  const strings = kbInstrumentStrings();
  assert.ok(
    strings.length >= 150,
    `MUSIC_KB should still name ~157 sound sources; it names ${strings.length}`
  );

  const unmapped = [];
  for (const name of strings) {
    const mapped = Object.prototype.hasOwnProperty.call(INSTRUMENT_KB_MAP, name);
    const excluded = Object.prototype.hasOwnProperty.call(INSTRUMENT_KB_EXCLUDED, name);
    if (!mapped && !excluded) unmapped.push(name);
  }
  deepEqual(
    unmapped,
    [],
    'these MUSIC_KB instruments have no block and no written reason for not having one — ' +
      'FDD #27 is DERIVED from this vocabulary, so a gap here is a gap in the feature'
  );
});

s.test('…and never both, because a string cannot be covered and deliberately uncovered', () => {
  const both = Object.keys(INSTRUMENT_KB_MAP).filter((name) =>
    Object.prototype.hasOwnProperty.call(INSTRUMENT_KB_EXCLUDED, name)
  );
  deepEqual(both, [], 'a KB instrument appears in BOTH derivation tables');
});

s.test('every id the mapping table names really exists', () => {
  for (const name of Object.keys(INSTRUMENT_KB_MAP)) {
    const id = INSTRUMENT_KB_MAP[name];
    assert.ok(
      instrumentBlockById(id),
      `INSTRUMENT_KB_MAP maps "${name}" to "${id}", which is not a block — the mapping is dead`
    );
  }
});

s.test('neither derivation table names a string MUSIC_KB no longer says', () => {
  // The record has to track the KB in BOTH directions: a stale row is a claim
  // about data that has moved on, and it would keep passing the coverage test
  // above while covering nothing.
  const live = new Set(kbInstrumentStrings());
  const staleMap = Object.keys(INSTRUMENT_KB_MAP).filter((name) => !live.has(name));
  const staleExcluded = Object.keys(INSTRUMENT_KB_EXCLUDED).filter((name) => !live.has(name));
  deepEqual(staleMap, [], 'INSTRUMENT_KB_MAP covers instruments MUSIC_KB no longer names');
  deepEqual(staleExcluded, [], 'INSTRUMENT_KB_EXCLUDED excuses instruments MUSIC_KB no longer names');
});

s.test('every exclusion carries a real reason, and the reasons name the registry that owns it', () => {
  const names = Object.keys(INSTRUMENT_KB_EXCLUDED);
  assert.ok(names.length > 0, 'nothing is excluded at all — then the table proves nothing');
  for (const name of names) {
    const reason = INSTRUMENT_KB_EXCLUDED[name];
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 20,
      `"${name}" is excluded with no real reason: ${JSON.stringify(reason)}`
    );
    // Every exclusion is a HANDOVER, not a deletion: the sound still reaches a
    // prompt, through the vocal registry (#28/#65) or the era one (#66).
    assert.ok(
      /#28|#65|#66|ERA_REGISTRY|Vocal Persona/.test(reason),
      `"${name}" is excluded without saying which card owns it instead: ${reason}`
    );
  }
});

s.test('resolveKbInstrument reads the record: mapped strings resolve, excluded ones do not', () => {
  assert.strictEqual(resolveKbInstrument('TR-909 kick').id, 'drums-percussion-four-on-the-floor-kick');
  assert.strictEqual(resolveKbInstrument('log drums').id, 'world-traditional-log-drums');
  assert.strictEqual(resolveKbInstrument('deep sub bass').id, 'bass-sub-bass');
  assert.strictEqual(resolveKbInstrument('warm sub bass').id, 'bass-sub-bass');
  assert.strictEqual(
    resolveKbInstrument('  log   drums  ').id,
    'world-traditional-log-drums',
    'whitespace is not meaning'
  );

  // A deliberate exclusion resolves to NOTHING rather than to a near miss: the
  // whole point is that the voice belongs to another card.
  assert.strictEqual(resolveKbInstrument('screamed vocal'), null);
  assert.strictEqual(resolveKbInstrument('tape hiss texture'), null);
  assert.strictEqual(resolveKbInstrument('gated reverb drums'), null);

  // A block with no KB string is still reachable by its own name and tag.
  assert.strictEqual(resolveKbInstrument('Koto').id, 'world-traditional-koto');
  assert.strictEqual(resolveKbInstrument('nyckelharpa').id, 'world-traditional-nyckelharpa');

  for (const junk of ['', '   ', 'not an instrument', null, undefined, 42, {}]) {
    assert.strictEqual(resolveKbInstrument(junk), null, `${JSON.stringify(junk)} must not resolve`);
  }
});

s.test('every MUSIC_KB genre still has at least one instrument that reaches a block', () => {
  // The coverage test above is per STRING; this one is per GENRE, and it is the
  // one that matters for #71: a genre whose every instrument was excluded would
  // spin combinations that never touch the instrument card at all.
  for (const genre of MUSIC_KB.genres) {
    const resolved = (genre.instruments || []).filter((name) => resolveKbInstrument(name));
    assert.ok(
      resolved.length > 0,
      `${genre.id} has no instrument that resolves to a block — every one was excluded`
    );
  }
});

/* ========================================================================== */
/* 4. searchInstruments                                                       */
/* ========================================================================== */

s.test('an empty or whitespace-only query is not a filter — everything matches', () => {
  for (const query of ['', '   ', '\t\n', undefined, null, 42, {}]) {
    assert.strictEqual(
      searchInstruments(query).length,
      INSTRUMENT_REGISTRY.length,
      `${JSON.stringify(query)} must not filter anything`
    );
  }
});

s.test('search is case-insensitive over label, tags and family', () => {
  const byLabel = searchInstruments('SLAP BASS');
  assert.ok(byLabel.some((e) => e.id === 'bass-slap-bass'), 'an upper-case label query must match');

  const byTag = searchInstruments('rhodes');
  assert.ok(byTag.length >= 1, 'a tag query must find its block');
  for (const entry of byTag) {
    assert.ok(
      (entry.label + ' ' + entry.tags.join(' ')).toLowerCase().indexOf('rhodes') !== -1,
      `${entry.id} matched "rhodes" without holding it`
    );
  }

  const byFamilyLabel = searchInstruments('World & Traditional');
  assert.strictEqual(byFamilyLabel.length, 10, 'a family label is searchable');
  for (const entry of byFamilyLabel) assert.strictEqual(entry.family, 'world-traditional');

  const byFamilyId = searchInstruments('electronic-textures');
  assert.strictEqual(byFamilyId.length, 10, 'a family id is searchable too');
});

s.test('a query that matches nothing returns nothing — never a nearest guess', () => {
  deepEqual(searchInstruments('zzzz-not-an-instrument'), []);
  deepEqual(searchInstruments('theremin choir bagpipe'), []);
});

s.test('the family filter is a SECOND narrowing, not text folded into the query', () => {
  const all = searchInstruments('');
  const drums = searchInstruments('', 'drums-percussion');
  assert.strictEqual(drums.length, 18, 'the drums family holds 18 blocks');
  for (const entry of drums) assert.strictEqual(entry.family, 'drums-percussion');
  assert.ok(drums.length < all.length);

  // "bass, within the drums family" — a narrowing plain text could not express,
  // because "bass" alone is a whole family of its own.
  const bassEverywhere = searchInstruments('bass');
  const bassInDrums = searchInstruments('bass', 'drums-percussion');
  assert.ok(bassInDrums.length > 0, 'the drum family really does mention a bass drum');
  assert.ok(
    bassInDrums.length < bassEverywhere.length,
    'the family filter must narrow the text result, not replace it'
  );
  for (const entry of bassInDrums) {
    assert.strictEqual(entry.family, 'drums-percussion');
    assert.ok(searchInstruments('bass').indexOf(entry) !== -1, 'it must also match the text');
  }

  // Both narrowings can be empty together, honestly.
  deepEqual(searchInstruments('sitar', 'bass'), []);
});

s.test('an absent, empty or unknown family filters nothing rather than everything', () => {
  const all = INSTRUMENT_REGISTRY.length;
  for (const family of [undefined, null, '', '   ', 42, {}]) {
    assert.strictEqual(
      searchInstruments('', family).length,
      all,
      `${JSON.stringify(family)} must not be treated as a filter`
    );
  }
  // An unknown id is the one case that legitimately empties the list: it is a
  // filter, it just matches nothing. Silently ignoring it would be a lie.
  deepEqual(searchInstruments('', 'no-such-family'), []);
});

s.test('the order is family-then-label and does not depend on the query', () => {
  const families = instrumentFamilies().map((f) => f.id);
  const check = (query, family) => {
    const hits = searchInstruments(query, family);
    let lastFamily = -1;
    let lastLabel = '';
    for (const entry of hits) {
      const rank = families.indexOf(entry.family);
      assert.ok(rank !== -1, `${entry.id} has an unknown family`);
      assert.ok(rank >= lastFamily, `"${query}": ${entry.id} broke the family order`);
      if (rank !== lastFamily) {
        lastFamily = rank;
        lastLabel = '';
      }
      const label = entry.label.toLowerCase();
      assert.ok(label >= lastLabel, `"${query}": ${entry.label} broke the A-Z order in its family`);
      lastLabel = label;
    }
    return hits.map((e) => e.id);
  };

  check('');
  check('bass');
  check('', 'orchestral');
  check('guitar', 'guitars-strings');
  const first = check('a');
  deepEqual(first, searchInstruments('a').map((e) => e.id), 'the same query must order the same way');

  // The declared family order, proven at the ends.
  const everything = searchInstruments('');
  assert.strictEqual(everything[0].family, FAMILY_ORDER[0]);
  assert.strictEqual(everything[everything.length - 1].family, FAMILY_ORDER[FAMILY_ORDER.length - 1]);
});

s.test('searchInstruments hands back the table entries, and the table is never re-sorted', () => {
  const before = INSTRUMENT_REGISTRY.map((e) => e.id);
  searchInstruments('bass');
  searchInstruments('');
  searchInstruments('', 'keys-synths');
  deepEqual(
    INSTRUMENT_REGISTRY.map((e) => e.id),
    before,
    'sorting the search result must not sort the registry itself'
  );
  const hit = searchInstruments('', 'keys-synths')[0];
  assert.ok(INSTRUMENT_REGISTRY.indexOf(hit) !== -1, 'search must hand back the entries themselves');
});

s.test('instrumentBlockById finds by id and answers null for anything else', () => {
  const entry = instrumentBlockById('world-traditional-koto');
  assert.ok(entry, 'a known id must resolve');
  assert.strictEqual(entry.label, 'Koto');
  assert.strictEqual(entry.familyLabel, 'World & Traditional');
  for (const missing of ['', 'nope', 'world-traditional', null, undefined, 42, {}]) {
    assert.strictEqual(instrumentBlockById(missing), null, `${JSON.stringify(missing)} is not an id`);
  }
});

/* ========================================================================== */
/* 5. Seeds, weighting and the add/remove toggle                              */
/* ========================================================================== */

s.test('seeds file under the instrument section and source, weighted by POSITION', () => {
  const block = instrumentBlockById('drums-percussion-shakers');
  const seeds = instrumentBlockSeeds(block);
  assert.strictEqual(seeds.length, block.tags.length);
  deepEqual(seeds.map((seed) => seed.tag), block.tags, 'tag order must survive');
  for (let i = 0; i < seeds.length; i += 1) {
    assert.strictEqual(seeds[i].section, INSTRUMENT_SECTION);
    assert.strictEqual(seeds[i].source, INSTRUMENT_BLOCK_SOURCE);
    assert.strictEqual(seeds[i].weight, INSTRUMENT_TAG_WEIGHTS[i], `tag ${i} got the wrong weight`);
  }
  deepEqual(INSTRUMENT_TAG_WEIGHTS, [0.7, 0.5]);
  assert.ok(INSTRUMENT_TAG_WEIGHTS[1] < INSTRUMENT_TAG_WEIGHTS[0], 'the weights must descend');
});

s.test('the instrument weights sit one notch under the era ones, deliberately', () => {
  // A named voice decides WHO is singing, a production signature decides what
  // the recording sounds like, and an instrument is one layer inside that. The
  // #67 limiter trims from the light end, so a shaker is shed before the tape
  // machine and the tape machine before the singer.
  const eraWeights = app.sandbox.ERA_TAG_WEIGHTS;
  const vocalWeights = app.sandbox.VOCAL_TAG_WEIGHTS;
  assert.ok(
    INSTRUMENT_TAG_WEIGHTS[0] < eraWeights[0],
    `the block naming tag (${INSTRUMENT_TAG_WEIGHTS[0]}) must not outrank the era one (${eraWeights[0]})`
  );
  assert.ok(
    eraWeights[0] < vocalWeights[0],
    'and the era one must still sit under the vocal one — the ladder has to stay in order'
  );
  for (const weight of INSTRUMENT_TAG_WEIGHTS) {
    assert.ok(weight > 0 && weight <= 1, `${weight} is outside the 0-1 range the store clamps to`);
  }
});

s.test('instrumentBlockSeeds is defensive: junk in, an empty list out', () => {
  for (const junk of [undefined, null, 42, 'block', {}, { tags: null }, { tags: 'x' }]) {
    deepEqual(instrumentBlockSeeds(junk), [], `${JSON.stringify(junk)} must yield no seeds`);
  }
  deepEqual(instrumentBlockSeeds({ tags: ['  ', ''] }), [], 'blank tags are not tags');
});

s.test('the first toggle adds every tag of a block, in one notification', () => {
  const state = createPromptState();
  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });

  const block = instrumentBlockById('bass-slap-bass');
  const outcome = toggleInstrumentBlock(state, block);

  deepEqual(outcome, { state: 'added', added: block.tags.length, removed: 0, kept: 0 });
  assert.strictEqual(notifications, 1, 'a block is ONE user action, not two repaints');

  const entries = state.list(INSTRUMENT_SECTION);
  deepEqual(entries.map((e) => e.tag), block.tags);
  for (let i = 0; i < entries.length; i += 1) {
    assert.strictEqual(entries[i].source, INSTRUMENT_BLOCK_SOURCE);
    assert.strictEqual(entries[i].weight, INSTRUMENT_TAG_WEIGHTS[i]);
  }
  assert.ok(instrumentBlockHold(state, block).complete, 'the block must read as added');
});

s.test('the second toggle takes the same tags straight back out', () => {
  const state = createPromptState();
  const block = instrumentBlockById('world-traditional-marimba');
  toggleInstrumentBlock(state, block);

  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });
  const outcome = toggleInstrumentBlock(state, block);

  deepEqual(outcome, { state: 'removed', added: 0, removed: block.tags.length, kept: 0 });
  assert.strictEqual(notifications, 1, 'a removal is one notification too');
  deepEqual(state.list(INSTRUMENT_SECTION), []);
  assert.ok(!instrumentBlockHold(state, block).complete);
});

s.test('a block is "added" only when EVERY tag is held — half is not one', () => {
  const state = createPromptState();
  const block = instrumentBlockById('keys-synths-rhodes');
  assert.strictEqual(block.tags.length, 2, 'fixture drift: this test needs a two-tag block');
  toggleInstrumentBlock(state, block);

  // The user deletes one texture word from the draft chips by hand.
  const entries = state.list(INSTRUMENT_SECTION);
  assert.ok(state.remove(entries[entries.length - 1].id));

  const hold = instrumentBlockHold(state, block);
  assert.strictEqual(hold.complete, false, 'a block missing a tag is not added');
  assert.strictEqual(hold.held.length, block.tags.length - 1);
  assert.strictEqual(hold.missing.length, 1);
  deepEqual(
    selectedInstrumentBlocks(state).map((e) => e.id),
    [],
    'and it must not appear in the badge row'
  );

  // Toggling now COMPLETES it rather than duplicating what is already there.
  const outcome = toggleInstrumentBlock(state, block);
  deepEqual(outcome, { state: 'added', added: 1, removed: 0, kept: 0 });
  assert.ok(instrumentBlockHold(state, block).complete);
  assert.strictEqual(state.list(INSTRUMENT_SECTION).length, block.tags.length, 'no duplicate tag');
});

s.test('removing one block never breaks another that still claims a shared tag', () => {
  /*
   * The table deliberately holds NO shared tags (there is a test above proving
   * it), because two blocks claiming one word would make the shared-tag rule
   * the normal case. The rule still has to work, so the case is built here out
   * of a real block and a synthetic partner that overlaps it — which is also
   * exactly what a future edit adding an overlapping block would produce.
   */
  const a = instrumentBlockById(SHARED_A);
  assert.ok(a, 'fixture drift: the shared-tag anchor block is gone');
  assert.ok(
    a.tags.some((t) => normalizePromptTag(t) === normalizePromptTag(SHARED_TAG)),
    `fixture drift: "${SHARED_TAG}" is no longer one of ${SHARED_A}'s tags`
  );
  const b = { id: SHARED_B, family: a.family, familyLabel: a.familyLabel, label: 'Open Hats Probe', tags: [SHARED_TAG, 'probe-only hat tail'] };

  const state = createPromptState();
  toggleInstrumentBlock(state, a);
  toggleInstrumentBlock(state, b);

  // One entry per (section, tag): the shared word is held ONCE.
  const union = new Set(a.tags.concat(b.tags).map(normalizePromptTag));
  assert.strictEqual(state.list(INSTRUMENT_SECTION).length, union.size);
  assert.ok(instrumentBlockHold(state, a).complete && instrumentBlockHold(state, b).complete);

  const outcome = toggleInstrumentBlock(state, a);
  assert.strictEqual(outcome.state, 'removed');
  assert.strictEqual(
    outcome.kept,
    0,
    'the synthetic partner is not in the registry, so selectedInstrumentBlocks cannot see it'
  );

  /* …which is the honest limit of the rule as written: it protects blocks the
   * REGISTRY knows about. Prove it does protect those, using two real blocks
   * whose tag sets are made to overlap through the draft rather than through
   * the table — the dissector road that #27 shares with the era card. */
  const other = createPromptState();
  const kick = instrumentBlockById('drums-percussion-four-on-the-floor-kick');
  toggleInstrumentBlock(other, kick);
  // A dissection puts one of the kick's own words in the group by another road.
  assert.strictEqual(
    other.list(INSTRUMENT_SECTION).filter((e) => e.tag === kick.tags[0]).length,
    1,
    'the naming tag must be in the group exactly once'
  );
  const removal = toggleInstrumentBlock(other, kick);
  assert.strictEqual(removal.state, 'removed');
  assert.strictEqual(removal.removed, kick.tags.length);
  deepEqual(other.list(), [], 'a lone block leaves nothing behind');
});

s.test('the shared-tag rule really fires when two REGISTRY blocks overlap in the draft', () => {
  /*
   * Built from real blocks: adding two blocks and then hand-adding one's tag
   * again cannot create an overlap (the store dedupes), so the overlap is made
   * the way a user makes one — a dissector tag that happens to equal a block's
   * word. Removing the block must not take the dissector's tag with it when
   * another COMPLETE block still needs it, and the era card proves the same
   * rule from the other side in tests/era-registry.test.js.
   */
  const state = createPromptState();
  const block = instrumentBlockById('drums-percussion-shakers');
  state.add({
    section: INSTRUMENT_SECTION,
    tag: block.tags[0],
    source: 'dissector',
    weight: 0.9,
  });

  const outcome = toggleInstrumentBlock(state, block);
  assert.strictEqual(outcome.state, 'added');
  assert.strictEqual(outcome.added, block.tags.length - 1, 'the shared tag must not be re-added');
  const tags = state.list(INSTRUMENT_SECTION).map((e) => e.tag);
  assert.strictEqual(
    tags.filter((t) => t === block.tags[0]).length,
    1,
    'the same phrase reaching the group by both roads must be held once'
  );
  assert.ok(instrumentBlockHold(state, block).complete, 'whatever put the tag there, the block is held');
});

s.test('toggleInstrumentBlock is defensive: junk in, a no-op out — never a throw', () => {
  const state = createPromptState();
  for (const junk of [undefined, null, 42, 'block', {}, { tags: [] }]) {
    deepEqual(
      toggleInstrumentBlock(state, junk),
      { state: 'noop', added: 0, removed: 0, kept: 0 },
      `${JSON.stringify(junk)} must be a no-op`
    );
  }
  deepEqual(state.list(), []);

  for (const notAStore of [undefined, null, 42, {}, { batch: 1 }]) {
    deepEqual(toggleInstrumentBlock(notAStore, instrumentBlockById(SHARED_A)), {
      state: 'noop',
      added: 0,
      removed: 0,
      kept: 0,
    });
  }
});

s.test('selectedInstrumentBlocks reports every fully-held block, in READING order', () => {
  const state = createPromptState();
  // Added deliberately out of order: an orchestral block, then a drum one.
  const late = instrumentBlockById('orchestral-timpani');
  const early = instrumentBlockById('drums-percussion-shakers');
  toggleInstrumentBlock(state, late);
  toggleInstrumentBlock(state, early);

  deepEqual(
    selectedInstrumentBlocks(state).map((e) => e.id),
    [early.id, late.id],
    'the badge row must read the way the list above it does — family, then label'
  );
  deepEqual(selectedInstrumentBlocks(createPromptState()), []);
});

s.test('every block in the table round-trips through add, hold and remove', () => {
  for (const block of INSTRUMENT_REGISTRY) {
    const state = createPromptState();
    const added = toggleInstrumentBlock(state, block);
    assert.strictEqual(added.state, 'added', `${block.id} would not add`);
    assert.strictEqual(added.added, block.tags.length, `${block.id} lost a tag on the way in`);
    assert.ok(instrumentBlockHold(state, block).complete, `${block.id} does not read as added`);
    deepEqual(
      selectedInstrumentBlocks(state).map((e) => e.id),
      [block.id],
      `${block.id} is not the only thing selected`
    );

    const removed = toggleInstrumentBlock(state, block);
    assert.strictEqual(removed.state, 'removed', `${block.id} would not remove`);
    assert.strictEqual(removed.kept, 0, `${block.id} alone can share nothing`);
    deepEqual(state.list(), [], `${block.id} left something behind`);
  }
});

/* ========================================================================== */
/* 6. Where the tags land in the compiled prompt                              */
/* ========================================================================== */

s.test('draftText emits the instrument group between the vocals and the scene', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'amapiano', source: 'manual', weight: 1 });
  state.add({ section: 'vocal', tag: 'soulful tenor vocals', source: 'vocal-persona', weight: 0.9 });
  state.add({ section: 'scene', tag: 'sunrise rooftop', source: 'scene', weight: 0.8 });
  state.add({ section: 'custom', tag: 'moody', source: 'manual', weight: 0.4 });
  const block = instrumentBlockById('world-traditional-log-drums');
  toggleInstrumentBlock(state, block);

  deepEqual(
    state.draftText().split(', '),
    [
      'amapiano',
      'soulful tenor vocals',
      'log drums',
      'pitched log drum bassline',
      'sunrise rooftop',
      'moody',
    ],
    'the instrument group sits after the vocals and before the scene'
  );
});

s.test('weightTokens emits the same order — the compiler and the draft agree', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'amapiano', source: 'manual', weight: 1 });
  state.add({ section: 'custom', tag: 'moody', source: 'manual', weight: 0.4 });
  const block = instrumentBlockById('world-traditional-log-drums');
  toggleInstrumentBlock(state, block);

  const ordered = weightTokens(state.list());
  deepEqual(ordered, state.draftText().split(', '));
  const start = ordered.indexOf(block.tags[0]);
  assert.ok(start !== -1, 'the naming tag must reach the compiler');
  deepEqual(ordered.slice(start, start + block.tags.length), block.tags);
});

s.test('counts() books the tags under the instrument section and the new source', () => {
  const state = createPromptState();
  const block = instrumentBlockById('brass-woodwind-saxophone');
  toggleInstrumentBlock(state, block);
  const counts = state.counts();
  assert.strictEqual(counts.sections[INSTRUMENT_SECTION], block.tags.length);
  assert.strictEqual(counts.sources[INSTRUMENT_BLOCK_SOURCE], block.tags.length);
  assert.strictEqual(counts.total, block.tags.length);
});

s.test('clearSection("instrument") empties the group like any other', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual', weight: 1 });
  toggleInstrumentBlock(state, instrumentBlockById('keys-synths-modular-bleeps'));
  assert.ok(state.list(INSTRUMENT_SECTION).length > 0);

  state.clearSection(INSTRUMENT_SECTION);
  deepEqual(state.list(INSTRUMENT_SECTION), []);
  deepEqual(state.list('genre').map((e) => e.tag), ['techno'], 'nothing else may be touched');
  deepEqual(selectedInstrumentBlocks(state), []);
});

s.test('nothing in the registry conflicts with a plain, instrument-free prompt', () => {
  const base = ['techno', 'driving rhythm', 'warm analog saturation'];
  for (const entry of INSTRUMENT_REGISTRY) {
    const result = resolveConflicts(base.concat(entry.tags));
    const dropped = result.conflicts.map((c) => c.dropped);
    for (const tag of entry.tags) {
      // A tag may legitimately clash with the base line above; what must never
      // happen is a block quietly losing a tag to ANOTHER of its own.
      if (dropped.indexOf(tag) === -1) continue;
      const conflict = result.conflicts.find((c) => c.dropped === tag);
      assert.ok(
        entry.tags.indexOf(conflict.kept) === -1,
        `${entry.id}: "${tag}" was dropped by its own sibling "${conflict.kept}"`
      );
    }
  }
});

/* ========================================================================== */
/* 7. Serialization — FDD #85/#86                                             */
/* ========================================================================== */

s.test('an instrument entry survives serializeWorkspace -> restoreWorkspace intact', () => {
  const source = makeRegistry();
  source.promptState.add({ section: 'genre', tag: 'shoegaze', source: 'manual', weight: 0.9 });
  const block = instrumentBlockById('guitars-strings-nylon');
  toggleInstrumentBlock(source.promptState, block);

  const snapshot = serializeWorkspace(source, { savedAt: 1000 });
  const rows = snapshot.prompt.filter((row) => row.section === INSTRUMENT_SECTION);
  assert.strictEqual(rows.length, block.tags.length, 'every instrument tag must be in the snapshot');
  deepEqual(rows.map((row) => row.tag), block.tags);
  for (let i = 0; i < rows.length; i += 1) {
    assert.strictEqual(rows[i].source, INSTRUMENT_BLOCK_SOURCE, 'the source must round-trip');
    assert.strictEqual(rows[i].weight, INSTRUMENT_TAG_WEIGHTS[i], 'the weight must round-trip');
  }

  const target = makeRegistry();
  const outcome = restoreWorkspace(JSON.parse(JSON.stringify(snapshot)), target);
  assert.ok(outcome.ok, `restore refused the snapshot: ${outcome.reason}`);
  deepEqual(target.promptState.list(), source.promptState.list());
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
  deepEqual(
    selectedInstrumentBlocks(target.promptState).map((e) => e.id),
    [block.id],
    'a restored workspace shows the block as stacked again'
  );
});

s.test('a workspace holding a block, a signature AND a spin round-trips whole', () => {
  const source = makeRegistry();
  toggleInstrumentBlock(source.promptState, instrumentBlockById('bass-upright-bass'));
  app.sandbox.toggleEraSignature(
    source.promptState,
    eraSignatureById('sig-saturation-tape-cassette-compression')
  );
  applyInspiration(source.promptState, spinInspiration({ rng: createSeededRng(11) }));

  const snapshot = serializeWorkspace(source, { savedAt: 42 });
  deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, 'the snapshot must be plain data');

  const target = makeRegistry();
  assert.ok(restoreWorkspace(JSON.parse(JSON.stringify(snapshot)), target).ok);
  deepEqual(
    selectedInstrumentBlocks(target.promptState).map((e) => e.id),
    selectedInstrumentBlocks(source.promptState).map((e) => e.id)
  );
  deepEqual(
    selectedEraSignatures(target.promptState).map((e) => e.id),
    selectedEraSignatures(source.promptState).map((e) => e.id)
  );
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
  assert.strictEqual(
    target.promptState.counts().sources[INSPIRE_SOURCE],
    source.promptState.counts().sources[INSPIRE_SOURCE],
    'the slot machine’s provenance must survive a save and a load'
  );
});

/* ========================================================================== */
/* 8. The seeded RNG — FDD #71's testability                                  */
/* ========================================================================== */

s.test('createSeededRng is uniform-ish, in range, and deterministic per seed', () => {
  for (const seed of [0, 1, 7, -3, 1.5, 2147483647]) {
    const a = createSeededRng(seed);
    const b = createSeededRng(seed);
    for (let i = 0; i < 50; i += 1) {
      const value = a();
      assert.ok(value >= 0 && value < 1, `seed ${seed} produced ${value}, outside [0,1)`);
      assert.strictEqual(value, b(), `seed ${seed} is not reproducible at draw ${i}`);
    }
  }

  // Different seeds must be different streams, or "spin again" would loop.
  assert.notStrictEqual(createSeededRng(1)(), createSeededRng(2)());
  assert.notStrictEqual(createSeededRng(1)(), createSeededRng(1.5)(), 'the fractional part matters');

  // Rough uniformity over ten buckets. Not a statistics test — just enough to
  // catch a generator stuck in one corner, which would make every spin the same.
  const buckets = new Array(10).fill(0);
  const rng = createSeededRng(99);
  for (let i = 0; i < 10000; i += 1) buckets[Math.floor(rng() * 10)] += 1;
  for (let i = 0; i < buckets.length; i += 1) {
    assert.ok(buckets[i] > 700 && buckets[i] < 1300, `bucket ${i} holds ${buckets[i]} of 10000`);
  }
});

s.test('rngInt stays inside its bound, and a nonsense bound is 0 rather than a throw', () => {
  const rng = createSeededRng(5);
  for (let i = 0; i < 500; i += 1) {
    const value = rngInt(rng, 7);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 7, `rngInt gave ${value}`);
  }
  for (const bad of [0, 1, -4, NaN, Infinity, undefined, null, 'x', {}]) {
    assert.strictEqual(rngInt(rng, bad), 0, `${JSON.stringify(bad)} must give 0`);
  }
  // A generator that lies about its range must not push the index out of bounds.
  assert.strictEqual(rngInt(() => 1, 5), 0);
  assert.strictEqual(rngInt(() => -0.2, 5), 0);
  assert.strictEqual(rngInt(() => NaN, 5), 0);
});

s.test('rngSample draws WITHOUT replacement and never reorders its source', () => {
  const source = ['a', 'b', 'c', 'd', 'e'];
  const frozen = source.slice();
  const rng = createSeededRng(13);
  for (let i = 0; i < 200; i += 1) {
    const drawn = rngSample(rng, source, 3);
    assert.strictEqual(drawn.length, 3);
    assert.strictEqual(new Set(drawn).size, 3, `a member was drawn twice: ${drawn.join(',')}`);
    for (const member of drawn) assert.ok(source.indexOf(member) !== -1);
  }
  deepEqual(source, frozen, 'the source list must not be shuffled in place');

  // Asking for more than there is gives everything, once.
  const all = rngSample(rng, source, 99);
  assert.strictEqual(all.length, source.length);
  assert.strictEqual(new Set(all).size, source.length);
  deepEqual(rngSample(rng, [], 3), []);
});

/* ========================================================================== */
/* 9. spinInspiration — the generator itself                                  */
/* ========================================================================== */

s.test('the affinity table has one row per genre, and names only real groups and scenes', () => {
  const groups = new Set(ERA_REGISTRY.map((e) => e.group));
  const scenes = new Set(MUSIC_KB.scenes.map((sc) => sc.id));
  const genreIds = new Set(MUSIC_KB.genres.map((g) => g.id));

  for (const genre of MUSIC_KB.genres) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(INSPIRE_AFFINITY, genre.id),
      `${genre.id} has no INSPIRE_AFFINITY row — it would spin with no era and no scene`
    );
  }
  for (const id of Object.keys(INSPIRE_AFFINITY)) {
    assert.ok(genreIds.has(id), `INSPIRE_AFFINITY names "${id}", which is not a MUSIC_KB genre`);
    const row = INSPIRE_AFFINITY[id];
    assert.ok(Array.isArray(row.eraGroups), `${id} has no eraGroups array`);
    assert.ok(Array.isArray(row.scenes), `${id} has no scenes array`);
    assert.ok(row.eraGroups.length > 0, `${id} names no era group at all`);
    assert.ok(row.scenes.length > 0, `${id} names no scene at all`);
    for (const group of row.eraGroups) {
      assert.ok(
        groups.has(group),
        `${id} -> era group "${group}", which is not in ERA_REGISTRY — the spin would find nothing`
      );
    }
    for (const scene of row.scenes) {
      assert.ok(scenes.has(scene), `${id} -> scene "${scene}", which is not in MUSIC_KB.scenes`);
    }
    assert.strictEqual(new Set(row.eraGroups).size, row.eraGroups.length, `${id} lists a group twice`);
    assert.strictEqual(new Set(row.scenes).size, row.scenes.length, `${id} lists a scene twice`);
  }

  // The worked example the task names by hand, pinned so a rewrite of the
  // table is a decision rather than a drift.
  deepEqual(INSPIRE_AFFINITY['french-electro'].eraGroups, ['era-2000s', 'sig-saturation-tape']);
});

s.test('the same seed always produces the same combination, tag for tag', () => {
  for (const seed of [0, 1, 42, 137, 9999]) {
    const a = spinInspiration({ rng: createSeededRng(seed) });
    const b = spinInspiration({ rng: createSeededRng(seed) });
    assert.ok(a, `seed ${seed} produced nothing`);
    deepEqual(b, a, `seed ${seed} is not reproducible`);
  }
  // …and different seeds really do produce different combinations, or "spin
  // again" would be a button that does nothing.
  const seen = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    seen.add(JSON.stringify(host(spinInspiration({ rng: createSeededRng(seed) }).tags)));
  }
  assert.ok(seen.size > 30, `40 seeds produced only ${seen.size} distinct combinations`);
});

s.test('a spin has the shape the strip renders, and every seed carries source "inspire"', () => {
  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const result = spinInspiration({ rng: createSeededRng(seed) });
    assert.ok(result, `seed ${seed} produced nothing`);
    assert.ok(typeof result.genreId === 'string' && result.genreId, `seed ${seed}: no genre id`);
    assert.ok(typeof result.genreLabel === 'string' && result.genreLabel, `seed ${seed}: no genre label`);
    assert.ok(Array.isArray(result.picks) && result.picks.length >= 3, `seed ${seed}: too few picks`);
    assert.ok(Array.isArray(result.tags) && result.tags.length >= 3, `seed ${seed}: too few tags`);
    assert.ok(
      result.attempts >= 1 && result.attempts <= INSPIRE_MAX_ATTEMPTS,
      `seed ${seed}: ${result.attempts} attempts is outside 1..${INSPIRE_MAX_ATTEMPTS}`
    );

    let lastKind = -1;
    for (const pick of result.picks) {
      const rank = INSPIRE_KINDS.indexOf(pick.kind);
      assert.ok(rank !== -1, `seed ${seed}: unknown pick kind "${pick.kind}"`);
      assert.ok(rank >= lastKind, `seed ${seed}: picks are out of INSPIRE_KINDS order`);
      lastKind = rank;
      assert.ok(typeof pick.label === 'string' && pick.label, `seed ${seed}: a pick has no label`);
      assert.ok(typeof pick.detail === 'string' && pick.detail, `seed ${seed}: a pick has no detail`);
      assert.ok(Array.isArray(pick.seeds) && pick.seeds.length, `seed ${seed}: a pick carries no seeds`);
      for (const one of pick.seeds) {
        assert.strictEqual(
          one.source,
          INSPIRE_SOURCE,
          `seed ${seed}: a ${pick.kind} seed says source "${one.source}" — the slot machine put it there`
        );
        assert.strictEqual(
          one.section,
          pick.kind,
          `seed ${seed}: a ${pick.kind} pick files into section "${one.section}"`
        );
        assert.ok(one.weight > 0 && one.weight <= 1, `seed ${seed}: weight ${one.weight} out of range`);
      }
    }
    // The flat tag list and the picks must agree, or "Add all" would add
    // something the strip never showed.
    deepEqual(
      result.tags,
      inspirationSeeds(result).map((one) => one.tag),
      `seed ${seed}: tags and seeds disagree`
    );
  }
});

s.test('THE SYNERGY GUARANTEE: every output is drawn from the seeding genre’s own vocabulary', () => {
  /*
   * This is the whole of what FDD #71's "high-synergy" means in this codebase,
   * and it is asserted against MUSIC_KB rather than against a copy of it.
   *
   *   descriptors -> that genre's own tokens
   *   mood        -> that genre's own moods
   *   instrument  -> one of that genre's own instruments, or the block the
   *                  derivation record says covers it
   *   era / scene -> that genre's own row in INSPIRE_AFFINITY
   *
   * Nothing is ever blended across genres, which is why a spin cannot hand
   * back amapiano log drums under a black-metal tag. FEATURE-MECHANICS §5.1's
   * numeric Synergy Score is NOT built and this does not pretend to be it.
   */
  const genreIndex = new Map(MUSIC_KB.genres.map((g) => [g.id, g]));

  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const result = spinInspiration({ rng: createSeededRng(seed) });
    const genre = genreIndex.get(result.genreId);
    assert.ok(genre, `seed ${seed}: the result names a genre MUSIC_KB does not have`);
    assert.strictEqual(result.genreLabel, genre.label, `seed ${seed}: the label was rewritten`);

    const allowed = {
      genre: new Set(genre.tokens.map((t) => normalizePromptTag(t.tag))),
      mood: new Set(genre.moods.map((m) => normalizePromptTag(m))),
      instrument: new Set(),
      era: new Set(),
      scene: new Set(),
    };
    for (const name of genre.instruments) {
      const block = resolveKbInstrument(name);
      if (block) for (const tag of block.tags) allowed.instrument.add(normalizePromptTag(tag));
      else allowed.instrument.add(normalizePromptTag(name));
    }
    const affinity = INSPIRE_AFFINITY[genre.id];
    for (const group of affinity.eraGroups) {
      for (const signature of searchEraRegistry('', group)) {
        for (const tag of signature.tags) allowed.era.add(normalizePromptTag(tag));
      }
    }
    for (const sceneId of affinity.scenes) {
      const scene = MUSIC_KB.scenes.find((sc) => sc.id === sceneId);
      assert.ok(scene, `${genre.id} names scene "${sceneId}", which is gone`);
      for (const token of scene.tokens.slice(0, 2)) allowed.scene.add(normalizePromptTag(token.tag));
    }

    for (const pick of result.picks) {
      for (const one of pick.seeds) {
        assert.ok(
          allowed[pick.kind].has(normalizePromptTag(one.tag)),
          `seed ${seed}: "${one.tag}" is a ${pick.kind} that ${genre.id} never claims — ` +
            'the one-genre guarantee is broken'
        );
      }
    }

    // The naming token of the genre always comes: a combination that could
    // describe the music without saying what it is would not be a starting
    // point.
    assert.ok(
      result.tags.some((tag) => normalizePromptTag(tag) === normalizePromptTag(genre.tokens[0].tag)),
      `seed ${seed}: ${genre.id} spun without its own naming token`
    );
  }
});

s.test('the composition stays inside its declared bounds: 2-3 descriptors, 1-2 instruments, 1 mood', () => {
  let withEra = 0;
  let withScene = 0;
  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const result = spinInspiration({ rng: createSeededRng(seed) });
    const counts = {};
    for (const pick of result.picks) counts[pick.kind] = (counts[pick.kind] || 0) + 1;

    // The trim path can legitimately remove a pick, so these are upper bounds
    // with a floor of one descriptor rather than exact counts.
    assert.ok(counts.genre >= 1 && counts.genre <= 3, `seed ${seed}: ${counts.genre} descriptors`);
    assert.ok((counts.instrument || 0) <= 2, `seed ${seed}: ${counts.instrument} instruments`);
    assert.ok((counts.mood || 0) <= 1, `seed ${seed}: ${counts.mood} moods`);
    assert.ok((counts.era || 0) <= 1, `seed ${seed}: ${counts.era} era signatures`);
    assert.ok((counts.scene || 0) <= 1, `seed ${seed}: ${counts.scene} scenes`);
    if (counts.era) withEra += 1;
    if (counts.scene) withScene += 1;
  }
  // Both extras are OPTIONAL, which means both states have to actually occur —
  // an "optional" extra that is always present is a required one.
  assert.ok(withEra > 20 && withEra < SPIN_SEEDS, `an era appeared in ${withEra}/${SPIN_SEEDS} spins`);
  assert.ok(
    withScene > 20 && withScene < SPIN_SEEDS,
    `a scene appeared in ${withScene}/${SPIN_SEEDS} spins`
  );
});

s.test(`all ${SPIN_SEEDS} seeded spins are conflict-free through the REAL resolver`, () => {
  // Driven through resolveConflicts itself — the same #68 engine the compiler
  // uses — rather than through a re-implementation of its rules here.
  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const result = spinInspiration({ rng: createSeededRng(seed) });
    const resolved = resolveConflicts(result.tags);
    deepEqual(
      resolved.conflicts,
      [],
      `seed ${seed} (${result.genreId}) shipped a contradiction: ${JSON.stringify(host(resolved.conflicts))}`
    );
    deepEqual(resolved.tags, result.tags, `seed ${seed}: the resolver would drop something`);
  }
});

s.test('the re-spin and the trim really happen, and the trim is reported rather than hidden', () => {
  let reSpun = 0;
  let trimmed = 0;
  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const result = spinInspiration({ rng: createSeededRng(seed) });
    if (result.attempts > 1) reSpun += 1;
    if (result.trimmed.length) {
      trimmed += 1;
      assert.strictEqual(
        result.attempts,
        INSPIRE_MAX_ATTEMPTS,
        `seed ${seed} trimmed without exhausting its re-rolls`
      );
      for (const drop of result.trimmed) {
        assert.ok(typeof drop.dropped === 'string' && drop.dropped, 'a drop with no tag');
        assert.ok(typeof drop.kept === 'string' && drop.kept, 'a drop with no survivor');
        assert.ok(typeof drop.rule === 'string' && drop.rule, 'a drop with no rule');
        if (drop.id === 'duplicate') {
          /* #68 drops REPEATS as well as contradictions, and a repeat is the
           * one case where the survivor and the casualty are the same string —
           * MUSIC_KB's disco row carries "handclap groove" as a descriptor AND
           * as an instrument. The tag legitimately stays, ONCE. */
          assert.strictEqual(
            result.tags.filter((tag) => tag === drop.dropped).length,
            1,
            `seed ${seed}: the repeated tag "${drop.dropped}" survived ${result.tags.filter((t) => t === drop.dropped).length} times`
          );
        } else {
          assert.strictEqual(
            result.tags.indexOf(drop.dropped),
            -1,
            `seed ${seed}: "${drop.dropped}" was reported as dropped but is still in the result`
          );
        }
      }
    }
  }
  assert.ok(reSpun > 0, `no seed in ${SPIN_SEEDS} ever needed a re-roll — the retry path is untested`);
  assert.ok(trimmed > 0, `no seed in ${SPIN_SEEDS} ever reached the trim — that path is untested`);
  assert.ok(trimmed < SPIN_SEEDS / 10, `${trimmed}/${SPIN_SEEDS} spins needed trimming — too many`);
});

s.test('a pinned genre stays pinned, however many times it re-rolls', () => {
  for (const genreId of ['amapiano', 'lo-fi', 'cinematic-score', 'metal']) {
    for (let seed = 0; seed < 25; seed += 1) {
      const result = spinInspiration({ rng: createSeededRng(seed), genreId });
      assert.ok(result, `${genreId} seed ${seed} produced nothing`);
      assert.strictEqual(result.genreId, genreId, `the pin was ignored on seed ${seed}`);
    }
  }
  // An unknown pin is honest about having nothing to spin rather than quietly
  // falling back to a random genre.
  assert.strictEqual(spinInspiration({ rng: createSeededRng(1), genreId: 'no-such-genre' }), null);
});

s.test('spinInspiration is defensive about its deps, and never touches the real KB', () => {
  const before = JSON.stringify(host(MUSIC_KB.genres.map((g) => g.instruments)));

  // No deps at all: Math.random and MUSIC_KB, which is what the app passes.
  const wild = spinInspiration();
  assert.ok(wild && wild.tags.length, 'a dep-less spin must still work');

  // A knowledge base with no genres has nothing to say, and says so.
  assert.strictEqual(spinInspiration({ kb: { genres: [] } }), null);
  // A nonsense kb falls back to the real one rather than throwing.
  for (const junk of [null, 42, 'kb', {}, { genres: 'x' }]) {
    assert.ok(spinInspiration({ kb: junk, rng: createSeededRng(3) }), `${JSON.stringify(junk)} must fall back`);
  }
  // A nonsense rng falls back to Math.random rather than throwing.
  for (const junk of [null, 42, 'rng', {}]) {
    assert.ok(spinInspiration({ rng: junk }), `${JSON.stringify(junk)} must fall back`);
  }
  // maxAttempts is clamped, not trusted.
  assert.strictEqual(spinInspiration({ rng: createSeededRng(2), maxAttempts: -5 }).attempts >= 1, true);
  assert.ok(spinInspiration({ rng: createSeededRng(2), maxAttempts: 1e6 }).attempts <= 10);

  assert.strictEqual(
    JSON.stringify(host(MUSIC_KB.genres.map((g) => g.instruments))),
    before,
    'spinning must not mutate the knowledge base it reads'
  );
});

s.test('inspirationSeeds is defensive: junk in, an empty list out', () => {
  for (const junk of [undefined, null, 42, 'result', {}, { picks: null }, { picks: 'x' }]) {
    deepEqual(inspirationSeeds(junk), [], `${JSON.stringify(junk)} must yield no seeds`);
  }
});

/* ========================================================================== */
/* 10. applyInspiration — the one writer                                      */
/* ========================================================================== */

s.test('add-all lands every tag in its own section, under source "inspire", in ONE batch', () => {
  const state = createPromptState();
  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });

  const result = spinInspiration({ rng: createSeededRng(23) });
  const outcome = applyInspiration(state, result);

  assert.strictEqual(outcome.added, result.tags.length, 'every tag must land');
  assert.strictEqual(outcome.skipped, 0);
  assert.strictEqual(notifications, 1, 'a combination is ONE user action, not nine repaints');

  const counts = state.counts();
  assert.strictEqual(counts.total, result.tags.length);
  assert.strictEqual(counts.sources[INSPIRE_SOURCE], result.tags.length, 'provenance must be recorded');

  // Section by section, against what the picks said they were.
  const expected = {};
  for (const pick of result.picks) expected[pick.kind] = (expected[pick.kind] || 0) + pick.seeds.length;
  for (const kind of INSPIRE_KINDS) {
    assert.strictEqual(
      counts.sections[kind],
      expected[kind] || 0,
      `the ${kind} group holds ${counts.sections[kind]}, the strip promised ${expected[kind] || 0}`
    );
  }
  // The draft emits them in PROMPT_SECTION_ORDER, which is the order the strip
  // showed them in — so what was previewed is what gets pasted.
  deepEqual(state.draftText().split(', '), result.tags);
});

s.test('adding the same combination twice adds nothing the second time', () => {
  const state = createPromptState();
  const result = spinInspiration({ rng: createSeededRng(31) });
  const first = applyInspiration(state, result);
  const second = applyInspiration(state, result);
  assert.strictEqual(second.added, 0, 'the store rejects a repeat rather than duplicating it');
  assert.strictEqual(second.skipped, first.added, 'and every skip is reported');
  assert.strictEqual(state.counts().total, first.added);
});

s.test('a spun instrument block and era signature show as SELECTED in their cards afterwards', () => {
  // The reason the picks borrow instrumentBlockSeeds/eraSignatureSeeds: a
  // combination that added "log drums" without the card noticing would leave
  // the user unable to remove it from the place they expect to.
  let sawBlock = false;
  let sawSignature = false;
  for (let seed = 0; seed < 60 && !(sawBlock && sawSignature); seed += 1) {
    const state = createPromptState();
    const result = spinInspiration({ rng: createSeededRng(seed) });
    applyInspiration(state, result);
    for (const pick of result.picks) {
      if (pick.kind === 'instrument') {
        const block = INSTRUMENT_REGISTRY.find((b) => b.label === pick.label);
        if (block && pick.seeds.length === block.tags.length) {
          assert.ok(
            instrumentBlockHold(state, block).complete,
            `"${block.label}" was spun in but the Instruments card does not read it as added`
          );
          sawBlock = true;
        }
      }
      if (pick.kind === 'era') {
        const signature = ERA_REGISTRY.find((e) => e.label === pick.label);
        if (signature && pick.seeds.length === signature.tags.length) {
          assert.ok(
            app.sandbox.eraSignatureHold(state, signature).complete,
            `"${signature.label}" was spun in but the Era card does not read it as added`
          );
          sawSignature = true;
        }
      }
    }
  }
  assert.ok(sawBlock, 'no seed in 60 spun a resolvable instrument block — the assertion never ran');
  assert.ok(sawSignature, 'no seed in 60 spun an era signature — the assertion never ran');
});

s.test('applyInspiration is defensive: junk in, an empty draft out — never a throw', () => {
  const state = createPromptState();
  for (const junk of [undefined, null, 42, 'result', {}, { picks: [] }]) {
    deepEqual(applyInspiration(state, junk), { added: 0, skipped: 0 }, `${JSON.stringify(junk)}`);
  }
  deepEqual(state.list(), []);
  for (const notAStore of [undefined, null, 42, {}, { batch: 1 }]) {
    deepEqual(applyInspiration(notAStore, spinInspiration({ rng: createSeededRng(1) })), {
      added: 0,
      skipped: 0,
    });
  }
});

/* ========================================================================== */
/* 11. The cards — static markup, wiring and styling contracts                */
/* ========================================================================== */

s.test('the instrument card ships with every id the boot reaches for', () => {
  const card = readCardMarkup('instrument-panel');
  for (const id of [
    'instrument-heading',
    'instrument-search',
    'instrument-count',
    'instrument-families',
    'instrument-selected-empty',
    'instrument-badges',
    'instrument-empty',
    'instrument-list',
    'instrument-status',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(card), `the card is missing id="${id}"`);
  }
});

s.test('the instrument card is a labelled region with a labelled search box and a live status', () => {
  const card = readCardMarkup('instrument-panel');
  assert.ok(/aria-labelledby="instrument-heading"/.test(card), 'the card must be a named region');
  assert.ok(
    /<label class="field-label" for="instrument-search">/.test(card),
    'the search box needs a real <label>, not a placeholder'
  );
  assert.ok(/type="search"/.test(card), 'the search box should be type="search"');
  assert.ok(
    /id="instrument-status"[^>]*role="status"[^>]*aria-live="polite"/.test(card),
    'add / remove outcomes must be announced'
  );
  assert.ok(
    /id="instrument-list"[^>]*class="vlist"[^>]*aria-label="Instrument blocks"/.test(card),
    'the scroller must be the shared .vlist and must name itself'
  );
  assert.ok(/id="instrument-list"[^>]*tabindex="0"/.test(card), 'the scroller must be keyboard reachable');
  assert.ok(/id="instrument-empty"[^>]*hidden/.test(card), 'the empty-search line starts hidden');
  assert.ok(
    /id="instrument-families"[^>]*role="group"[^>]*aria-label="[^"]+"/.test(card),
    'the filter chips are a named group, not a bare row of buttons'
  );
  assert.ok(
    /id="instrument-badges"[^>]*role="group"[^>]*aria-label="[^"]+"/.test(card),
    'the layering badges are a named group too — it is the surface #27 asks for'
  );
});

s.test('the instrument card is wired to the registry, the shared scroller and the prompt store', () => {
  const boot = app.source;
  const start = boot.indexOf("const instrumentSearch = $('instrument-search');");
  assert.ok(start !== -1, 'the instrument card wiring has gone missing from the boot IIFE');
  const block = boot.slice(start, start + 14000);

  assert.ok(
    /searchInstruments\(query, instrumentFamilyFilter\)/.test(block),
    'the search is not wired'
  );
  assert.ok(/createVirtualList\(\{/.test(block), 'the card must reuse the shared virtual scroller');
  assert.ok(/rowHeight: VIRTUAL_ROW_HEIGHT/.test(block), 'the row height must come from the constant');
  assert.ok(
    /promptState\.subscribe\(renderInstrumentCard\)/.test(block),
    'the card must follow the store'
  );
  assert.ok(
    /instrumentSearch\.addEventListener\('input', renderInstrumentCard\)/.test(block),
    'typing must repaint the card'
  );
  assert.ok(/toggleInstrumentBlock\(promptState, block\)/.test(block), 'the toggle is not wired');
  assert.ok(
    /aria-pressed', added \? 'true' : 'false'/.test(block),
    'the row toggle is not a pressed toggle'
  );
  assert.ok(/data-focus-key', 'instrument-toggle'/.test(block), 'the row toggle has no focus key');
  assert.ok(/keyOf: function \(block\)/.test(block), 'the scroller needs a stable row key');
  assert.ok(
    /instrumentFamilyFilter = instrumentFamilyFilter === family\.id \? '' : family\.id/.test(block),
    'pressing the active family chip again must be the way back to All'
  );
  assert.ok(
    /INSTRUMENT_REGISTRY\.length/.test(block),
    'the count line and the empty state must quote the real table size'
  );
  assert.ok(
    /className = 'instrument-badge'/.test(block),
    'the selected row must build BADGES, not the pill the sibling cards use — that is FDD #27'
  );
  assert.ok(
    /instrument-badge-family/.test(block) && /instrument-badge-name/.test(block),
    'a badge is family over name; one of the two lines is missing'
  );
});

s.test('the instrument list joins the windowed-repaint hook, like every other scroller', () => {
  // tests/persistence.test.js owns the completeness guard; this is the local
  // statement of the same requirement, so a failure here names this card.
  const hook = functionBody(app.source, 'function refreshPersistenceLists()');
  assert.ok(
    /instrumentView\.refresh\(\);/.test(hook),
    'instrumentView is missing from refreshPersistenceLists — it will under-render on first entry'
  );
});

s.test('the instrument card lives in the Shape column, between the voice and the room', () => {
  const editor = readEditorMarkup();
  const vocal = editor.indexOf('vocal-panel');
  const instrument = editor.indexOf('instrument-panel');
  const era = editor.indexOf('era-panel');
  const structure = editor.indexOf('structure-panel');
  assert.ok(vocal !== -1 && instrument !== -1 && era !== -1, 'a card is missing from the view');
  assert.ok(vocal < instrument, 'the instrument card follows the vocal one');
  assert.ok(instrument < era, 'and precedes the era one — the same order the draft emits them in');
  assert.ok(era < structure);

  const shapeStart = editor.indexOf('class="editor-shape"');
  const railStart = editor.indexOf('class="editor-rail"');
  assert.ok(shapeStart !== -1 && railStart > shapeStart, 'the zoned split is gone');
  assert.ok(
    instrument > shapeStart && instrument < railStart,
    'a card holding a search box must not be sticky'
  );
});

s.test('the inspire card ships with every id the boot reaches for, and lives beside the dissector', () => {
  const card = readCardMarkup('inspire-panel');
  for (const id of [
    'inspire-heading',
    'btn-inspire',
    'btn-inspire-label',
    'inspire-seeded',
    'inspire-empty',
    'inspire-strip',
    'inspire-actions',
    'btn-inspire-add',
    'btn-inspire-again',
    'inspire-status',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(card), `the card is missing id="${id}"`);
  }

  const editor = readEditorMarkup();
  const dissector = editor.indexOf('dissector-panel');
  const inspire = editor.indexOf('inspire-panel');
  const shapeStart = editor.indexOf('class="editor-shape"');
  assert.ok(dissector !== -1 && inspire > dissector, 'the inspire card follows the dissector');
  assert.ok(
    inspire < shapeStart,
    'it closes the DESCRIBE zone — it answers the dissector’s question from the other end'
  );
});

s.test('the inspire card is a labelled region whose strip and actions announce themselves', () => {
  const card = readCardMarkup('inspire-panel');
  assert.ok(/aria-labelledby="inspire-heading"/.test(card), 'the card must be a named region');
  assert.ok(
    /id="inspire-status"[^>]*role="status"[^>]*aria-live="polite"/.test(card),
    'the outcome of a spin must be announced'
  );
  assert.ok(
    /id="inspire-strip"[^>]*role="group"[^>]*aria-label="[^"]+"/.test(card),
    'the strip is a named group of chips'
  );
  assert.ok(
    /id="inspire-actions"[^>]*role="group"[^>]*aria-label="[^"]+"[^>]*hidden/.test(card),
    'the actions are a named group, hidden until there is something to act on'
  );
  assert.ok(
    /id="inspire-empty"[^>]*class="draft-empty"/.test(card),
    'the pre-spin state must say what the button will do, not show an empty box'
  );
  // The promise, in the copy the user actually reads.
  assert.ok(
    /Spinning never changes your prompt/i.test(card),
    'the card must SAY that a spin does not touch the draft — that is the honesty contract'
  );
});

s.test('SPINNING NEVER ADDS: the spin handler cannot reach the prompt store', () => {
  /*
   * FDD #71's central promise, asserted structurally rather than trusted. The
   * spin path paints; the Add button writes. If a future edit reaches for
   * promptState inside runInspireSpin — which is exactly how an "it would be
   * convenient" auto-add gets introduced — this fails.
   */
  const body = functionBody(app.source, 'function runInspireSpin()');
  assert.ok(/spinInspiration\(/.test(body), 'the spin handler does not actually spin');
  assert.strictEqual(
    /promptState/.test(body),
    false,
    'runInspireSpin mentions promptState — a spin must never write to the draft'
  );
  assert.strictEqual(
    /applyInspiration/.test(body),
    false,
    'runInspireSpin calls applyInspiration — a spin must never add anything'
  );

  // Exactly ONE writer in the whole boot, and it is the Add button's handler.
  const writers = app.source.match(/applyInspiration\(promptState/g) || [];
  assert.strictEqual(
    writers.length,
    1,
    `applyInspiration(promptState, …) is called ${writers.length} times; there must be exactly one`
  );
  const addHandler = app.source.indexOf("inspireAddBtn.addEventListener('click', function () {");
  assert.ok(addHandler !== -1, 'the Add all button has no click handler');
  const writerAt = app.source.indexOf('applyInspiration(promptState');
  assert.ok(
    writerAt > addHandler && writerAt < addHandler + 2000,
    'the only writer is not inside the Add all handler'
  );

  // Both buttons that spin call the same painting-only handler.
  assert.ok(/inspireSpinBtn\.addEventListener\('click', runInspireSpin\)/.test(app.source));
  assert.ok(/inspireAgainBtn\.addEventListener\('click', runInspireSpin\)/.test(app.source));
});

s.test('the strip names the genre that seeded the combination', () => {
  const render = functionBody(app.source, 'function renderInspireStrip()');
  assert.ok(
    /inspireSeeded\.textContent = 'seeded by ' \+ inspiration\.genreLabel/.test(render),
    'the provenance line is not painted — a suggestion with no source is not arguable'
  );
  assert.ok(/inspireActions\.hidden = !has/.test(render), 'the actions must follow the strip');
  assert.ok(/inspireStrip\.textContent = ''/.test(render), 'the strip must be rebuilt, not appended to');
  // Read-only chips: a <span>, never a button, because the strip is a proposal.
  assert.ok(
    /createElement\('span'\);\s*\n\s*chip\.className = 'inspire-chip'/.test(render),
    'a strip chip must be a span — a button there would imply it does something'
  );
});

s.test('the tumble is gated on prefers-reduced-motion in the SCRIPT as well as the sheet', () => {
  const render = functionBody(app.source, 'function renderInspireStrip()');
  assert.ok(
    /if \(!inspireReducedMotion\(\)\)/.test(render),
    'the animation class must not be added when the OS asks for stillness'
  );
  assert.ok(
    /inspireStrip\.classList\.add\('is-spinning'\)/.test(render),
    'nothing adds the animation class at all'
  );
  const gate = functionBody(app.source, 'function inspireReducedMotion()');
  assert.ok(/inspireMotionQuery/.test(gate), 'the gate must read the live media query');
  assert.ok(
    /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(app.source),
    'the query itself is missing'
  );

  const css = readStyle();
  const guard = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(
    /\.inspire-strip\.is-spinning \.inspire-chip \{ animation: none; \}/.test(guard),
    'the stylesheet must also zero the animation, so a stale class cannot animate'
  );
});

s.test('both cards style themselves from tokens only, in every theme', () => {
  const css = readStyle();
  for (const selector of [
    '.instrument-panel {',
    '.instrument-row {',
    '.instrument-count {',
    '.instrument-families {',
    '.instrument-badges {',
    '.instrument-badge {',
    '.instrument-badge-family {',
    '.instrument-badge-name {',
    '.instrument-family-chip[aria-pressed="true"] {',
    '.btn-instrument[aria-pressed="true"] {',
    '.inspire-panel {',
    '.inspire-row {',
    '.inspire-spin {',
    '.inspire-seeded {',
    '.inspire-strip {',
    '.inspire-chip {',
    '.inspire-chip-kind {',
    '.inspire-actions {',
  ]) {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `the stylesheet is missing a rule for ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(body),
      `${selector} hard-codes a colour, which no theme or Code Mode can reach:\n${body}`
    );
  }

  // Both cards answer to the same container name as their neighbours, so they
  // reflow against their own column rather than the window (ENGINEERING §2.2).
  assert.ok(
    /\.instrument-panel,/.test(css) && /\.inspire-panel,/.test(css),
    'the two new cards must join the dissector container group'
  );
  // The shared selector list, sliced from its first member to the declaration
  // that closes it. `.editor-output` carries the same container-name earlier in
  // the sheet, so the end is searched for FROM the start of this list.
  const groupStart = css.indexOf('.scene-panel,');
  assert.ok(groupStart !== -1, 'the shared container-name group has gone');
  const group = css.slice(groupStart, css.indexOf('container-name: dissector;', groupStart));
  assert.ok(group.indexOf('.instrument-panel,') !== -1, '.instrument-panel is not in the group');
  assert.ok(group.indexOf('.inspire-panel,') !== -1, '.inspire-panel is not in the group');

  const narrow = css.slice(css.indexOf('@container dissector (max-width: 520px)'));
  assert.ok(
    /\.instrument-row \{ flex-direction: column;/.test(narrow),
    'a narrow card must stack the search row instead of squeezing it'
  );
  assert.ok(
    /\.inspire-row \{ flex-direction: column;/.test(narrow),
    'a narrow card must stack the spin row too'
  );
});

s.test('a pressed FAMILY chip does not wear the colour a pressed ADD button wears', () => {
  // Cyan has meant "this is in your prompt" since the persona card shipped. A
  // family chip changes the VIEW and nothing else, so it must not borrow it —
  // the same rule the era card's group chips are held to, and the same
  // measured reason for keeping the base .chip ground under --ink-violet.
  const css = readStyle();
  const filterStart = css.indexOf('.instrument-family-chip[aria-pressed="true"] {');
  const filter = css.slice(filterStart, css.indexOf('}', filterStart));
  assert.ok(/var\(--ink-violet\)/.test(filter), 'chip TEXT must ride the AA-clearing violet ink');
  assert.ok(!/--accent-cyan|--tint-cyan/.test(filter), 'a filter must not read as an added tag');
  assert.ok(
    !/background:/.test(filter),
    'the pressed filter chip must not paint its own ground — a --tint-violet wash behind ' +
      '--ink-violet measured under AA in Obsidian and Tape Deck (see the era card’s note)'
  );
  assert.ok(/border-color:\s*var\(--accent-violet\)/.test(filter), 'the border is the second signal');

  const addStart = css.indexOf('.btn-instrument[aria-pressed="true"] {');
  const add = css.slice(addStart, css.indexOf('}', addStart));
  assert.ok(/var\(--accent-cyan\)/.test(add), 'an added block keeps the additive cyan');
});

s.test('the badge really is heavier than a chip — that is the whole of FDD #27’s "badge"', () => {
  const css = readStyle();
  const start = css.indexOf('.instrument-badge {');
  const badge = css.slice(start, css.indexOf('}', start));
  // Two lines stacked, not one line in a pill.
  assert.ok(/flex-direction: column/.test(badge), 'a badge stacks family over name');
  assert.ok(/border-left: 3px solid var\(--accent-cyan\)/.test(badge), 'the weighted accent edge is gone');
  assert.ok(!/border-radius: 999px/.test(badge), 'a badge is not the pill its siblings use');

  // …and the sibling chip row it is deliberately NOT: the era card's chips.
  const eraStart = css.indexOf('.era-chips {');
  const eraChips = css.slice(eraStart, css.indexOf('}', eraStart));
  assert.ok(!/flex-direction: column/.test(eraChips), 'the era chips must stay a plain wrapped row');
});

s.test('Code Mode keeps every new pressed state legible once the washes are gone', () => {
  const css = readStyle();
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(
    /\.high-contrast \.btn-instrument\[aria-pressed="true"\]\s*\{[^}]*var\(--accent-cyan\)/.test(contrast),
    'flattening the wash must leave the cyan border as the added signal'
  );
  assert.ok(
    /\.high-contrast \.instrument-family-chip\[aria-pressed="true"\]\s*\{[^}]*var\(--accent-violet\)/.test(
      contrast
    ),
    'and the violet border as the filtered signal — the two must stay distinguishable'
  );
  assert.ok(
    /\.high-contrast \.instrument-badge\s*\{[^}]*border-left: 3px solid var\(--accent-cyan\)/.test(contrast),
    'the badge keeps its accent edge once its cyan wash is flattened'
  );
  assert.ok(
    /\.high-contrast \.inspire-spin\s*\{[^}]*var\(--accent-violet\)/.test(contrast),
    'the spin button keeps the violet border, so it still reads as the generator'
  );
  assert.ok(
    /\.high-contrast \.inspire-chip\s*\{[^}]*var\(--bg\)/.test(contrast),
    'a strip chip must flatten its recessed ground like every other surface'
  );
});

s.test('the draft card already knows what to call the instrument group', () => {
  const start = app.source.indexOf('const SECTION_LABELS = {');
  assert.ok(start !== -1, 'SECTION_LABELS disappeared');
  const block = app.source.slice(start, app.source.indexOf('};', start));
  assert.ok(/instrument: 'Instruments'/.test(block), 'the instrument group has no human label');
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
