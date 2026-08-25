'use strict';
/*
 * tests/era-registry.test.js — the Expanded Production Eras and the card built
 * on them:
 *
 *   docs/FDD.md #66  Expanded Production Eras -> var ERA_REGISTRY, and the
 *                                                Production Era & Signature
 *                                                card over it:
 *                                                eraRegistryGroups(),
 *                                                searchEraRegistry(),
 *                                                eraSignatureSeeds(),
 *                                                toggleEraSignature() and
 *                                                the #era-list card
 *
 * This suite is the deliberate sibling of tests/vocal-registry.test.js, in the
 * same order and to the same standard, because the feature is: one static
 * table, pure selector helpers over it, one virtualized card.
 *
 * WHAT IS COVERED
 *   - the table itself: size, the nine groups, unique ids / labels / naming
 *     tags, kebab ids that carry their own group prefix, tags that are
 *     lowercase and comma-free, 2-4 tags plus a description on every entry,
 *     and a blocklist scan proving no real artist, producer, studio or plugin
 *     product was named;
 *   - the declared reading order (ERA_GROUP_ORDER) and the table agreeing in
 *     BOTH directions, so a group added to one without the other fails here;
 *   - the two roads into the 'era' section: the seven MUSIC_KB decade TRIGGERS
 *     (which stay, and which the dissector matches text against) and this
 *     table (direct selection, no phrases, never consulted by the dissector);
 *   - searchEraRegistry: what it matches, what it deliberately does not
 *     (descriptions), the empty query, the group filter as a SECOND
 *     narrowing, and its query-independent order;
 *   - the selector's pure logic over a REAL createPromptState: position
 *     weighting, add / remove toggling, half-a-signature, and the shared-tag
 *     rule that stops one removal breaking the signature beside it;
 *   - era entries surviving serializeWorkspace -> restoreWorkspace and the
 *     preset record built from the same snapshot;
 *   - the #68 conflict proof: a lo-fi / cassette signature really does fight a
 *     modern hyper-clean radio master at compile time, through the EXISTING
 *     rule and with no new plumbing;
 *   - the static markup, aria and wiring contracts of the new card, plus its
 *     token-only styling in both themes and in Code Mode.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Live DOM event wiring: the click that toggles a row, the group chips'
 *     own repaint, the virtual scroller's painting and the focus rescue on the
 *     chip row. Those need a browser; the boot IIFE is proven inert outside
 *     one, the pure halves are exercised behaviourally here, and the strings
 *     the live card depends on are asserted statically at the bottom.
 *   - createVirtualList itself. tests/persistence.test.js owns that contract;
 *     this card reuses it rather than growing a third scroller.
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

/* docs/FDD.md #66 promises "100+" production signatures, grown from the seven
 * decade triggers MUSIC_KB already held. The banked table is 124; the table may
 * grow, never shrink below the promise. */
const REGISTRY_MIN = 100;
const REGISTRY_BANKED = 124;
const GROUP_COUNT = 9;
/* Six decade groups plus the three cross-cutting signature families. */
const DECADE_GROUPS = 6;
/* The seven MUSIC_KB decade triggers this feature does NOT replace. */
const KB_ERA_TRIGGERS = 7;

/*
 * The Safe-Mode standard (FDD #24) applied to a static table, widened for this
 * domain: a production-era registry is one careless label away from naming the
 * producer, the studio or the plugin whose sound it describes, and any of the
 * three would put a real party's name one click from the copied prompt.
 *
 * This list is a SPOT CHECK of obvious, widely known names across the four
 * risky classes — it is not a claim to be exhaustive — and it is written here
 * rather than in index.html so the check cannot be satisfied by editing the
 * thing it checks.
 *
 * DELIBERATELY ABSENT: "autotune" / "auto-tune". The registry's
 * era-2000s-autotune-gloss entry uses it, and so does MUSIC_KB's own 2000s era
 * ('auto-tune vocal effect') — it has been the generic name of the hard
 * pitch-snap sound for two decades, it is the word a user would search for,
 * and blocking it here while shipping it there would be a rule this codebase
 * does not actually hold. Every other product name IS blocked below.
 *
 * Several entries carry a trailing space ('neve ', 'ssl ', 'waves ') because
 * the haystack is space-joined: without it "neve" would match "never" and the
 * check would fail on a word no one objects to.
 */
const NAME_BLOCKLIST = [
  /* producers and engineers */
  'phil spector',
  'spector',
  'quincy jones',
  'rick rubin',
  'brian eno',
  'butch vig',
  'dr dre',
  'timbaland',
  'nigel godrich',
  'steve albini',
  'albini',
  'trent reznor',
  'mutt lange',
  'george martin',
  'joe meek',
  'tony visconti',
  'daniel lanois',
  'jack antonoff',
  'max martin',
  'andrew scheps',
  /* studios and labels */
  'abbey road',
  'motown',
  'sun studio',
  'muscle shoals',
  'stax',
  'electric lady',
  'capitol studios',
  'trident',
  'hitsville',
  /* plugin and hardware products */
  'fabfilter',
  'izotope',
  'ozone',
  'neve ',
  'ssl ',
  'la-2a',
  '1176',
  'lexicon',
  'emt 140',
  'urei',
  'pultec',
  'distressor',
  'decapitator',
  'valhalla',
  'soundtoys',
  'universal audio',
  'antares',
  'melodyne',
  'kontakt',
  'serum',
  'omnisphere',
  'pro tools',
  'protools',
  'ableton',
  'logic pro',
  'cubase',
  'fl studio',
  'waves ',
  'oberheim',
  'fairlight',
  'synclavier',
  'linndrum',
  'roland ',
  'yamaha',
  'korg',
  'moog',
  'juno-106',
  'tr-808',
  'tr-909',
  'sp-1200',
  'akai',
  'dx7',
  /* bands */
  'beatles',
  'nirvana',
  'daft punk',
  'radiohead',
  'pink floyd',
  'led zeppelin',
  'metallica',
  'beach boys',
  'kraftwerk',
  'abba',
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
  ERA_REGISTRY,
  ERA_SECTION,
  ERA_SIGNATURE_SOURCE,
  ERA_TAG_WEIGHTS,
  ERA_GROUP_ORDER,
  eraRegistryGroups,
  searchEraRegistry,
  eraSignatureById,
  eraSignatureSeeds,
  eraSignatureHold,
  selectedEraSignatures,
  toggleEraSignature,
  MUSIC_KB,
  createPromptState,
  createExclusionState,
  createStructureState,
  createPresetRecord,
  serializeWorkspace,
  restoreWorkspace,
  weightTokens,
  resolveConflicts,
  compileStylePrompt,
  normalizePromptTag,
  TAG_CONFLICTS,
  PROMPT_SECTIONS,
  PROMPT_SECTION_ORDER,
  PROMPT_SOURCES,
  PROMPT_SOURCE_SECTION,
  SLIDER_AXES,
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

/** The era card's own markup, from its <section> to the next one. */
function readEraCardMarkup() {
  const editor = readEditorMarkup();
  const start = editor.indexOf('class="view-col vibe-card era-panel"');
  assert.ok(start !== -1, 'the Prompt Editor has no .era-panel card');
  const end = editor.indexOf('</section>', start);
  assert.ok(end > start, 'the .era-panel card is never closed');
  return editor.slice(start, end);
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

/* The two entries that really do share a tag ("squashed dynamics"), found in
 * the data rather than invented for the test — see the shared-tag section. */
const SHARED_TAG = 'squashed dynamics';
const SHARED_A = 'sig-saturation-tape-cassette-compression';
const SHARED_B = 'era-2000s-brickwall-loudness';

const s = suite('era registry + production signature selector (FDD #66)');

/* ========================================================================== */
/* 1. Reachability                                                            */
/* ========================================================================== */

s.test('the registry and its helpers are reachable top-level declarations', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined', 'the boot IIFE must stay inert');
  for (const name of [
    'eraRegistryGroups',
    'searchEraRegistry',
    'eraSignatureById',
    'eraSignatureSeeds',
    'eraSignatureHold',
    'selectedEraSignatures',
    'toggleEraSignature',
  ]) {
    assert.strictEqual(fresh.evaluate(`typeof ${name}`), 'function', `${name} is not reachable`);
  }
  for (const name of ['ERA_REGISTRY', 'ERA_SECTION', 'ERA_SIGNATURE_SOURCE', 'ERA_TAG_WEIGHTS', 'ERA_GROUP_ORDER']) {
    assert.ok(fresh.sandbox[name] !== undefined, `${name} must be a var binding tests can read`);
  }
  assert.strictEqual(ERA_SECTION, 'era');
  assert.strictEqual(ERA_SIGNATURE_SOURCE, 'era-signature');
});

s.test('the new source is registered, and it files into the era section by default', () => {
  assert.ok(
    PROMPT_SOURCES.indexOf(ERA_SIGNATURE_SOURCE) !== -1,
    'a source the store does not know is rejected by build() — every add would return null'
  );
  assert.strictEqual(PROMPT_SOURCE_SECTION[ERA_SIGNATURE_SOURCE], ERA_SECTION);
  assert.ok(PROMPT_SECTIONS.indexOf(ERA_SECTION) !== -1);

  // The section is NOT new — this release adds a second source to an existing
  // group — so the canonical order must be untouched by #66.
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
  /*
   * A behavioural test that reaches for a renamed id gets `null` back, and
   * every helper below treats null as a no-op — so the test would go on
   * PASSING while asserting nothing at all. This is the guard: the fixtures
   * are declared once, checked once, and a rename fails HERE with the id in
   * the message instead of hollowing out a dozen tests silently.
   */
  const FIXTURES = [
    'era-1950s-60s-mono-ribbon-vocal',
    'era-1970s-console-saturation',
    'era-1980s-cassette-tape-saturation',
    'era-1980s-fm-bell-sheen',
    'era-1990s-4-track-tape-hiss',
    'era-2000s-brickwall-loudness',
    'era-2010s-2020s-lofi-chillhop-wobble',
    'sig-saturation-tape-cassette-compression',
    'sig-saturation-tape-vinyl-crackle',
    'sig-reverb-space-gated-drums',
    'sig-reverb-space-plate-shimmer',
    'sig-mix-master-crystalline-top-end',
    'sig-mix-master-mono-punch',
    'sig-mix-master-wide-stereo-spread',
  ];
  for (const id of FIXTURES) {
    assert.ok(eraSignatureById(id), `fixture drift: this suite names "${id}", which is gone`);
  }
  // The one vocal fixture the cross-registry test borrows.
  assert.ok(
    app.sandbox.vocalPersonaById('rock-metal-death-growl'),
    'fixture drift: the borrowed vocal persona is gone'
  );
});

/* ========================================================================== */
/* 2. Registry integrity — FDD #66                                            */
/* ========================================================================== */

s.test(`the table ships at least ${REGISTRY_MIN} signatures across ${GROUP_COUNT} groups`, () => {
  assert.ok(Array.isArray(ERA_REGISTRY), 'ERA_REGISTRY must be an array');
  assert.ok(
    ERA_REGISTRY.length >= REGISTRY_MIN,
    `FDD #66 promises ${REGISTRY_MIN}+ signatures; the table holds ${ERA_REGISTRY.length}`
  );
  assert.strictEqual(
    ERA_REGISTRY.length,
    REGISTRY_BANKED,
    'the banked table is 124 entries — a change to that number is a data change, not a refactor'
  );

  const groups = eraRegistryGroups();
  assert.strictEqual(groups.length, GROUP_COUNT, `expected ${GROUP_COUNT} groups`);

  let counted = 0;
  const seen = new Set();
  for (const group of groups) {
    assert.ok(typeof group.id === 'string' && group.id, 'a group has no id');
    assert.ok(typeof group.label === 'string' && group.label, `${group.id} has no label`);
    assert.ok(!seen.has(group.id), `duplicate group id "${group.id}"`);
    seen.add(group.id);
    assert.ok(group.count > 0, `${group.id} is declared but empty`);
    counted += group.count;
  }
  assert.strictEqual(counted, ERA_REGISTRY.length, 'the group counts must add up to the table');

  // Six decades and three cross-cutting signature families, by id prefix.
  const decades = groups.filter((g) => g.id.indexOf('era-') === 0);
  const signatures = groups.filter((g) => g.id.indexOf('sig-') === 0);
  assert.strictEqual(decades.length, DECADE_GROUPS, 'six decade groups');
  assert.strictEqual(signatures.length, GROUP_COUNT - DECADE_GROUPS, 'three signature families');

  // The three families the task names by hand must all be represented.
  const labels = groups.map((g) => g.label.toLowerCase()).join(' | ');
  for (const promised of ['saturation & tape', 'reverb & space', 'mix & master']) {
    assert.ok(labels.indexOf(promised) !== -1, `no group covers "${promised}"`);
  }
});

s.test('the declared reading order and the table agree, in BOTH directions', () => {
  assert.ok(Array.isArray(ERA_GROUP_ORDER), 'ERA_GROUP_ORDER must be an array');
  assert.strictEqual(new Set(ERA_GROUP_ORDER).size, ERA_GROUP_ORDER.length, 'a group is listed twice');

  const inTable = new Set(ERA_REGISTRY.map((e) => e.group));
  for (const id of ERA_GROUP_ORDER) {
    assert.ok(inTable.has(id), `ERA_GROUP_ORDER names "${id}", which no entry belongs to`);
  }
  for (const id of inTable) {
    assert.ok(
      ERA_GROUP_ORDER.indexOf(id) !== -1,
      `group "${id}" is in the table but has no place in ERA_GROUP_ORDER — it would sort last`
    );
  }

  // The order is the POINT of declaring it: decades forwards, then the three
  // cross-cutting families. Deriving it from the array's storage order would
  // put the 2010s in front of the 1980s.
  deepEqual(eraRegistryGroups().map((g) => g.id), ERA_GROUP_ORDER);
  deepEqual(eraRegistryGroups().map((g) => g.label), [
    '1950s & 1960s',
    '1970s',
    '1980s',
    '1990s',
    '2000s',
    '2010s & 2020s',
    'Saturation & Tape',
    'Reverb & Space',
    'Mix & Master Aesthetics',
  ]);
});

s.test('ids are kebab-case, unique, and carry their own group prefix', () => {
  const ids = new Set();
  for (const entry of ERA_REGISTRY) {
    assert.ok(typeof entry.id === 'string' && entry.id, `an entry has no id: ${JSON.stringify(entry)}`);
    assert.ok(!ids.has(entry.id), `duplicate id "${entry.id}"`);
    ids.add(entry.id);
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id),
      `id "${entry.id}" is not kebab-case (lowercase, digits and single hyphens)`
    );
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.group),
      `group "${entry.group}" is not kebab-case`
    );
    assert.strictEqual(
      entry.id.indexOf(entry.group + '-'),
      0,
      `id "${entry.id}" does not start with its group "${entry.group}-"`
    );
  }
  assert.strictEqual(ids.size, ERA_REGISTRY.length);
});

s.test('labels and group labels are unique, human, and consistent per group', () => {
  const labels = new Set();
  const groupLabels = Object.create(null);
  for (const entry of ERA_REGISTRY) {
    assert.ok(typeof entry.label === 'string' && entry.label.trim(), `${entry.id} has no label`);
    const key = entry.label.toLowerCase();
    assert.ok(!labels.has(key), `duplicate signature label "${entry.label}"`);
    labels.add(key);

    assert.ok(typeof entry.groupLabel === 'string' && entry.groupLabel.trim());
    if (groupLabels[entry.group] === undefined) groupLabels[entry.group] = entry.groupLabel;
    assert.strictEqual(
      entry.groupLabel,
      groupLabels[entry.group],
      `${entry.id}: group "${entry.group}" is labelled two different ways`
    );
  }
  assert.strictEqual(labels.size, ERA_REGISTRY.length);
});

s.test('every entry carries 2-4 lowercase, comma-free tags and one description', () => {
  for (const entry of ERA_REGISTRY) {
    assert.ok(Array.isArray(entry.tags), `${entry.id} has no tags array`);
    assert.ok(
      entry.tags.length >= 2 && entry.tags.length <= 4,
      `${entry.id} has ${entry.tags.length} tags; the shape is 2-4`
    );
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

    assert.ok(
      typeof entry.description === 'string' && entry.description.trim(),
      `${entry.id} has no description — every entry owes the reader one plain sentence`
    );
    assert.ok(
      /[.!?]$/.test(entry.description.trim()),
      `${entry.id}: the description should read as a sentence: "${entry.description}"`
    );
  }
});

s.test('the naming tag of every signature is unique across the table', () => {
  // tags[0] IS the signature's identity: it is what the row shows, what the
  // #73 weighting engine ranks highest and what the #67 limiter keeps longest.
  // Two entries sharing one would make "Added" ambiguous between them.
  const primary = new Map();
  for (const entry of ERA_REGISTRY) {
    const norm = normalizePromptTag(entry.tags[0]);
    assert.ok(
      !primary.has(norm),
      `${entry.id} and ${primary.get(norm)} both name themselves "${entry.tags[0]}"`
    );
    primary.set(norm, entry.id);
  }
  assert.strictEqual(primary.size, ERA_REGISTRY.length);
});

s.test('no entry names a real artist, producer, studio or plugin product', () => {
  for (const entry of ERA_REGISTRY) {
    const haystack = (
      entry.id +
      ' ' +
      entry.label +
      ' ' +
      entry.tags.join(' ') +
      ' ' +
      entry.description
    ).toLowerCase();
    for (const name of NAME_BLOCKLIST) {
      assert.strictEqual(
        haystack.indexOf(name),
        -1,
        `${entry.id} names "${name}" — the registry describes techniques, never real parties`
      );
    }
  }
});

s.test('a signature is internally consistent: its own tags never contradict each other', () => {
  // The same standard the vocal registry and MUSIC_KB are held to. A signature
  // that fought itself would drop one of its own tags the instant it was added
  // — and this table is the one most likely to, since half of it describes
  // saturation and the other half describes clean masters.
  for (const entry of ERA_REGISTRY) {
    const result = resolveConflicts(entry.tags);
    deepEqual(
      result.conflicts,
      [],
      `${entry.id} contradicts itself: ${JSON.stringify(host(result.conflicts))}`
    );
  }
});

/* ========================================================================== */
/* 3. The two roads into the 'era' section                                    */
/* ========================================================================== */

s.test(`the ${KB_ERA_TRIGGERS} MUSIC_KB decade triggers stay exactly where they were`, () => {
  // #66 GROWS the era path; it does not replace it. MUSIC_KB.eras is what
  // dissectLocal() matches typed text against ("90s", "seventies"), and
  // deleting it in favour of this table would silently break the dissector.
  assert.ok(Array.isArray(MUSIC_KB.eras), 'MUSIC_KB.eras must still be an array');
  assert.strictEqual(MUSIC_KB.eras.length, KB_ERA_TRIGGERS);
  deepEqual(MUSIC_KB.eras.map((e) => e.id), [
    'era-1960s',
    'era-1970s',
    'era-1980s',
    'era-1990s',
    'era-2000s',
    'era-2010s',
    'era-2020s',
  ]);
  for (const era of MUSIC_KB.eras) {
    assert.ok(Array.isArray(era.phrases) && era.phrases.length, `${era.id} lost its trigger phrases`);
    assert.ok(Array.isArray(era.tokens) && era.tokens.length, `${era.id} lost its tokens`);
  }
});

s.test('the two tables are different SHAPES, so neither can be mistaken for the other', () => {
  // A KB era is a TRIGGER (phrases in, weighted tokens out). A registry entry
  // is a SELECTION (no phrases, no bpm, tags carried by position). Keeping the
  // shapes apart is what stops a future edit wiring the dissector into this
  // table and matching "1970s Console Warmth" against the word "warm".
  for (const entry of ERA_REGISTRY) {
    assert.strictEqual(entry.phrases, undefined, `${entry.id} must not carry dissector phrases`);
    assert.strictEqual(entry.tokens, undefined, `${entry.id} must not carry KB tokens`);
    assert.strictEqual(entry.bpm, undefined, `${entry.id} must not carry a bpm`);
  }
  for (const era of MUSIC_KB.eras) {
    assert.strictEqual(era.group, undefined, `${era.id} must not carry a registry group`);
  }

  // The ids cannot collide either: a registry id always carries a group prefix
  // with a further segment behind it, so 'era-1980s' (a KB id) is never one.
  const kbIds = new Set(MUSIC_KB.eras.map((e) => e.id));
  for (const entry of ERA_REGISTRY) {
    assert.ok(!kbIds.has(entry.id), `${entry.id} collides with a MUSIC_KB era id`);
  }
});

/* ========================================================================== */
/* 4. searchEraRegistry                                                       */
/* ========================================================================== */

s.test('an empty or whitespace-only query is not a filter — everything matches', () => {
  for (const query of ['', '   ', '\t\n', undefined, null, 42, {}]) {
    assert.strictEqual(
      searchEraRegistry(query).length,
      ERA_REGISTRY.length,
      `${JSON.stringify(query)} must not filter anything`
    );
  }
});

s.test('search is case-insensitive over label, tags and group — but not description', () => {
  const byLabel = searchEraRegistry('GATED REVERB DRUMS');
  assert.ok(
    byLabel.some((e) => e.id === 'sig-reverb-space-gated-drums'),
    'an upper-case label query must match'
  );

  const byTag = searchEraRegistry('vinyl crackle');
  assert.ok(byTag.length >= 2, 'a texture shared by two entries must find both');
  for (const entry of byTag) {
    assert.ok(
      entry.tags.join(' ').indexOf('vinyl crackle') !== -1,
      `${entry.id} matched "vinyl crackle" without holding it`
    );
  }

  const byGroupLabel = searchEraRegistry('Mix & Master');
  assert.strictEqual(byGroupLabel.length, 14, 'a group label is searchable');
  for (const entry of byGroupLabel) assert.strictEqual(entry.group, 'sig-mix-master');

  const byGroupId = searchEraRegistry('sig-saturation-tape');
  assert.strictEqual(byGroupId.length, 14, 'a group id is searchable too');

  // Descriptions are prose for a human. Find a word that appears ONLY in one
  // description and prove the search does not reach it.
  const entry = eraSignatureById('sig-reverb-space-plate-shimmer');
  assert.ok(
    entry.description.toLowerCase().indexOf('metallic') !== -1,
    'fixture drift: the description no longer holds the probe word'
  );
  const descOnly = searchEraRegistry('shimmering');
  for (const hit of descOnly) {
    assert.ok(
      hit.label.toLowerCase().indexOf('shimmering') !== -1 ||
        hit.tags.join(' ').indexOf('shimmering') !== -1 ||
        hit.groupLabel.toLowerCase().indexOf('shimmering') !== -1,
      `${hit.id} was matched through its description, which is not searchable`
    );
  }
});

s.test('a query that matches nothing returns nothing — never a nearest guess', () => {
  deepEqual(searchEraRegistry('zzzz-not-a-signature'), []);
  deepEqual(searchEraRegistry('bagpipe solo'), []);
});

s.test('the group filter is a SECOND narrowing, not text folded into the query', () => {
  const all = searchEraRegistry('');
  const eighties = searchEraRegistry('', 'era-1980s');
  assert.strictEqual(eighties.length, 13, 'the 1980s group holds 13 signatures');
  for (const entry of eighties) assert.strictEqual(entry.group, 'era-1980s');
  assert.ok(eighties.length < all.length);

  // "reverb, within the 1980s" — a narrowing plain text could not express,
  // because "reverb" alone crosses every decade.
  const reverbEverywhere = searchEraRegistry('reverb');
  const reverbIn80s = searchEraRegistry('reverb', 'era-1980s');
  assert.ok(reverbIn80s.length > 0, 'the 1980s really do have reverb signatures');
  assert.ok(
    reverbIn80s.length < reverbEverywhere.length,
    'the group filter must narrow the text result, not replace it'
  );
  for (const entry of reverbIn80s) {
    assert.strictEqual(entry.group, 'era-1980s');
    assert.ok(searchEraRegistry('reverb').indexOf(entry) !== -1, 'it must also match the text');
  }

  // Both narrowings can be empty together, honestly.
  deepEqual(searchEraRegistry('sidechain', 'era-1950s-60s'), []);
});

s.test('an absent, empty or unknown group filters nothing rather than everything', () => {
  const all = ERA_REGISTRY.length;
  for (const group of [undefined, null, '', '   ', 42, {}]) {
    assert.strictEqual(
      searchEraRegistry('', group).length,
      all,
      `${JSON.stringify(group)} must not be treated as a filter`
    );
  }
  // An unknown id is the one case that legitimately empties the list: it is a
  // filter, it just matches nothing. Silently ignoring it would be a lie.
  deepEqual(searchEraRegistry('', 'no-such-group'), []);
});

s.test('the order is group-then-label and does not depend on the query', () => {
  const groups = eraRegistryGroups().map((g) => g.id);
  const check = (query, group) => {
    const hits = searchEraRegistry(query, group);
    let lastGroup = -1;
    let lastLabel = '';
    for (const entry of hits) {
      const rank = groups.indexOf(entry.group);
      assert.ok(rank !== -1, `${entry.id} has an unknown group`);
      assert.ok(rank >= lastGroup, `"${query}": ${entry.id} broke the group order`);
      if (rank !== lastGroup) {
        lastGroup = rank;
        lastLabel = '';
      }
      const label = entry.label.toLowerCase();
      assert.ok(label >= lastLabel, `"${query}": ${entry.label} broke the A-Z order in its group`);
      lastLabel = label;
    }
    return hits.map((e) => e.id);
  };

  check('');
  check('tape');
  check('', 'sig-mix-master');
  check('reverb', 'era-1980s');
  const first = check('a');
  const second = searchEraRegistry('a').map((e) => e.id);
  deepEqual(first, second, 'the same query must produce the same order every time');

  // Chronology, proven at the ends: the first hit of an unfiltered search is a
  // 1950s/60s signature and the last is a Mix & Master one.
  const everything = searchEraRegistry('');
  assert.strictEqual(everything[0].group, 'era-1950s-60s');
  assert.strictEqual(everything[everything.length - 1].group, 'sig-mix-master');
});

s.test('searchEraRegistry hands back the table entries, and the table is never re-sorted', () => {
  const before = ERA_REGISTRY.map((e) => e.id);
  searchEraRegistry('tape');
  searchEraRegistry('');
  searchEraRegistry('', 'era-1970s');
  deepEqual(
    ERA_REGISTRY.map((e) => e.id),
    before,
    'sorting the search result must not sort the registry itself'
  );
  // Identity, not copies — the table is read-only by contract.
  const hit = searchEraRegistry('', 'era-1970s')[0];
  assert.ok(ERA_REGISTRY.indexOf(hit) !== -1, 'search must hand back the entries themselves');
});

s.test('eraSignatureById finds by id and answers null for anything else', () => {
  const entry = eraSignatureById('era-1980s-cassette-tape-saturation');
  assert.ok(entry, 'a known id must resolve');
  assert.strictEqual(entry.label, 'Cassette Tape Saturation');
  assert.strictEqual(entry.groupLabel, '1980s');
  for (const missing of ['', 'nope', 'era-1980s', null, undefined, 42, {}]) {
    assert.strictEqual(eraSignatureById(missing), null, `${JSON.stringify(missing)} is not an id`);
  }
});

/* ========================================================================== */
/* 5. Seeds, weighting and the add/remove toggle                              */
/* ========================================================================== */

s.test('seeds file under the era section and source, weighted by POSITION', () => {
  const signature = eraSignatureById('sig-reverb-space-gated-drums');
  const seeds = eraSignatureSeeds(signature);
  assert.strictEqual(seeds.length, signature.tags.length);
  deepEqual(seeds.map((seed) => seed.tag), signature.tags, 'tag order must survive');
  for (let i = 0; i < seeds.length; i += 1) {
    assert.strictEqual(seeds[i].section, ERA_SECTION);
    assert.strictEqual(seeds[i].source, ERA_SIGNATURE_SOURCE);
    assert.strictEqual(seeds[i].weight, ERA_TAG_WEIGHTS[i], `tag ${i} got the wrong weight`);
  }
  for (let i = 1; i < seeds.length; i += 1) {
    assert.ok(seeds[i].weight < seeds[i - 1].weight, 'the weights must descend with position');
  }
  deepEqual(ERA_TAG_WEIGHTS, [0.85, 0.65, 0.55, 0.5]);
});

s.test('the era weights sit one notch under the vocal ones, deliberately', () => {
  // A production signature colours a recording; a named voice decides who is
  // singing. When both are present the voice is the more load-bearing
  // instruction, so the #67 limiter (which trims from the light end) sheds a
  // reverb texture before it sheds the singer.
  const vocalWeights = app.sandbox.VOCAL_TAG_WEIGHTS;
  assert.strictEqual(ERA_TAG_WEIGHTS.length, vocalWeights.length);
  assert.ok(
    ERA_TAG_WEIGHTS[0] < vocalWeights[0],
    `the era naming tag (${ERA_TAG_WEIGHTS[0]}) must not outrank the vocal one (${vocalWeights[0]})`
  );
  for (const weight of ERA_TAG_WEIGHTS) {
    assert.ok(weight > 0 && weight <= 1, `${weight} is outside the 0-1 range the store clamps to`);
  }
});

s.test('eraSignatureSeeds is defensive: junk in, an empty list out', () => {
  for (const junk of [undefined, null, 42, 'signature', {}, { tags: null }, { tags: 'x' }]) {
    deepEqual(eraSignatureSeeds(junk), [], `${JSON.stringify(junk)} must yield no seeds`);
  }
  deepEqual(eraSignatureSeeds({ tags: ['  ', ''] }), [], 'blank tags are not tags');
});

s.test('the first toggle adds every tag of a signature, in one notification', () => {
  const state = createPromptState();
  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });

  const signature = eraSignatureById('era-1970s-console-saturation');
  const outcome = toggleEraSignature(state, signature);

  deepEqual(outcome, {
    state: 'added',
    added: signature.tags.length,
    removed: 0,
    kept: 0,
  });
  assert.strictEqual(notifications, 1, 'a signature is ONE user action, not four repaints');

  const entries = state.list(ERA_SECTION);
  deepEqual(entries.map((e) => e.tag), signature.tags);
  for (let i = 0; i < entries.length; i += 1) {
    assert.strictEqual(entries[i].source, ERA_SIGNATURE_SOURCE);
    assert.strictEqual(entries[i].weight, ERA_TAG_WEIGHTS[i]);
  }
  assert.ok(eraSignatureHold(state, signature).complete, 'the signature must read as added');
});

s.test('the second toggle takes the same tags straight back out', () => {
  const state = createPromptState();
  const signature = eraSignatureById('sig-mix-master-wide-stereo-spread');
  toggleEraSignature(state, signature);

  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });
  const outcome = toggleEraSignature(state, signature);

  deepEqual(outcome, {
    state: 'removed',
    added: 0,
    removed: signature.tags.length,
    kept: 0,
  });
  assert.strictEqual(notifications, 1, 'a removal is one notification too');
  deepEqual(state.list(ERA_SECTION), []);
  assert.ok(!eraSignatureHold(state, signature).complete);
});

s.test('a signature is "added" only when EVERY tag is held — half is not one', () => {
  const state = createPromptState();
  const signature = eraSignatureById('sig-saturation-tape-vinyl-crackle');
  toggleEraSignature(state, signature);

  // The user deletes one texture word from the draft chips by hand.
  const entries = state.list(ERA_SECTION);
  assert.ok(state.remove(entries[entries.length - 1].id));

  const hold = eraSignatureHold(state, signature);
  assert.strictEqual(hold.complete, false, 'a signature missing a tag is not added');
  assert.strictEqual(hold.held.length, signature.tags.length - 1);
  assert.strictEqual(hold.missing.length, 1);
  deepEqual(
    selectedEraSignatures(state).map((e) => e.id),
    [],
    'and it must not appear in the selected chips row'
  );

  // Toggling now COMPLETES it rather than duplicating what is already there.
  const outcome = toggleEraSignature(state, signature);
  deepEqual(outcome, { state: 'added', added: 1, removed: 0, kept: 0 });
  assert.ok(eraSignatureHold(state, signature).complete);
  assert.strictEqual(state.list(ERA_SECTION).length, signature.tags.length, 'no duplicate tag');
});

s.test('removing one signature never breaks another that still claims a shared tag', () => {
  // Found in the data, not invented: these two really do share "squashed
  // dynamics", which is exactly the case the shared-tag rule exists for.
  const a = eraSignatureById(SHARED_A);
  const b = eraSignatureById(SHARED_B);
  assert.ok(a && b, 'fixture drift: the shared-tag pair is gone');
  const shared = normalizePromptTag(SHARED_TAG);
  assert.ok(
    a.tags.some((t) => normalizePromptTag(t) === shared) &&
      b.tags.some((t) => normalizePromptTag(t) === shared),
    `fixture drift: "${SHARED_TAG}" is no longer shared by ${SHARED_A} and ${SHARED_B}`
  );

  const state = createPromptState();
  toggleEraSignature(state, a);
  toggleEraSignature(state, b);

  // One entry per (section, tag): the shared word is held ONCE.
  const union = new Set(a.tags.concat(b.tags).map(normalizePromptTag));
  assert.strictEqual(state.list(ERA_SECTION).length, union.size);
  assert.ok(eraSignatureHold(state, a).complete && eraSignatureHold(state, b).complete);

  const outcome = toggleEraSignature(state, a);
  assert.strictEqual(outcome.state, 'removed');
  assert.strictEqual(outcome.kept, 1, 'the shared tag must be KEPT, and reported as kept');
  assert.strictEqual(outcome.removed, a.tags.length - 1);

  assert.ok(!eraSignatureHold(state, a).complete, 'the removed signature is gone');
  assert.ok(
    eraSignatureHold(state, b).complete,
    'taking one signature out must never quietly break the one beside it'
  );
  // Exactly b's tags remain — as a SET, because the shared word kept the slot
  // it was first inserted into rather than jumping to b's position for it.
  deepEqual(
    state.list(ERA_SECTION).map((e) => e.tag).slice().sort(),
    b.tags.slice().sort(),
    'the survivor must hold all of its own tags and none of the removed one’s'
  );
  assert.strictEqual(state.list(ERA_SECTION)[0].tag, SHARED_TAG, 'the kept tag holds its position');
});

s.test('toggleEraSignature is defensive: junk in, a no-op out — never a throw', () => {
  const state = createPromptState();
  for (const junk of [undefined, null, 42, 'signature', {}, { tags: [] }]) {
    deepEqual(
      toggleEraSignature(state, junk),
      { state: 'noop', added: 0, removed: 0, kept: 0 },
      `${JSON.stringify(junk)} must be a no-op`
    );
  }
  deepEqual(state.list(), []);

  for (const notAStore of [undefined, null, 42, {}, { batch: 1 }]) {
    deepEqual(toggleEraSignature(notAStore, eraSignatureById(SHARED_A)), {
      state: 'noop',
      added: 0,
      removed: 0,
      kept: 0,
    });
  }
});

s.test('selectedEraSignatures reports every fully-held signature, in READING order', () => {
  const state = createPromptState();
  // Added deliberately out of order: a 2000s signature, then a 1950s one.
  const late = eraSignatureById('era-2000s-brickwall-loudness');
  const early = eraSignatureById(searchEraRegistry('', 'era-1950s-60s')[0].id);
  toggleEraSignature(state, late);
  toggleEraSignature(state, early);

  deepEqual(
    selectedEraSignatures(state).map((e) => e.id),
    [early.id, late.id],
    'the chips row must read the way the list above it does — group, then label'
  );
  deepEqual(selectedEraSignatures(createPromptState()), []);
});

s.test('every signature in the table round-trips through add, hold and remove', () => {
  for (const signature of ERA_REGISTRY) {
    const state = createPromptState();
    const added = toggleEraSignature(state, signature);
    assert.strictEqual(added.state, 'added', `${signature.id} would not add`);
    assert.strictEqual(added.added, signature.tags.length, `${signature.id} lost a tag on the way in`);
    assert.ok(eraSignatureHold(state, signature).complete, `${signature.id} does not read as added`);
    deepEqual(
      selectedEraSignatures(state).map((e) => e.id),
      [signature.id],
      `${signature.id} is not the only thing selected`
    );

    const removed = toggleEraSignature(state, signature);
    assert.strictEqual(removed.state, 'removed', `${signature.id} would not remove`);
    assert.strictEqual(removed.kept, 0, `${signature.id} alone can share nothing`);
    deepEqual(state.list(), [], `${signature.id} left something behind`);
  }
});

/* ========================================================================== */
/* 6. Where the tags land in the compiled prompt                              */
/* ========================================================================== */

s.test('draftText emits the era group between the scene and the custom tags', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'synthwave', source: 'manual', weight: 1 });
  state.add({ section: 'vocal', tag: 'raspy baritone vocals', source: 'vocal-persona', weight: 0.9 });
  state.add({ section: 'scene', tag: 'neon rain-slick street', source: 'scene', weight: 0.8 });
  state.add({ section: 'custom', tag: 'moody', source: 'manual', weight: 0.4 });
  const signature = eraSignatureById('sig-reverb-space-gated-drums');
  toggleEraSignature(state, signature);

  deepEqual(
    state.draftText().split(', '),
    [
      'synthwave',
      'raspy baritone vocals',
      'neon rain-slick street',
      'gated reverb drums',
      'big 80s drum room',
      'abrupt cutoff tail',
      'moody',
    ],
    'the era group sits after the scene and before the custom tags'
  );
});

s.test('weightTokens emits the same order — the compiler and the draft agree', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'synthwave', source: 'manual', weight: 1 });
  state.add({ section: 'custom', tag: 'moody', source: 'manual', weight: 0.4 });
  const signature = eraSignatureById('sig-reverb-space-gated-drums');
  toggleEraSignature(state, signature);

  const ordered = weightTokens(state.list());
  deepEqual(ordered, state.draftText().split(', '));
  // Inside the group, position weighting keeps the naming tag first.
  const start = ordered.indexOf(signature.tags[0]);
  assert.ok(start !== -1, 'the naming tag must reach the compiler');
  deepEqual(ordered.slice(start, start + signature.tags.length), signature.tags);
});

s.test('counts() books the tags under the era section and the new source', () => {
  const state = createPromptState();
  const signature = eraSignatureById('era-1990s-4-track-tape-hiss');
  toggleEraSignature(state, signature);
  const counts = state.counts();
  assert.strictEqual(counts.sections[ERA_SECTION], signature.tags.length);
  assert.strictEqual(counts.sources[ERA_SIGNATURE_SOURCE], signature.tags.length);
  assert.strictEqual(counts.total, signature.tags.length);
});

s.test('clearSection("era") empties the group like any other', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual', weight: 1 });
  toggleEraSignature(state, eraSignatureById('sig-mix-master-mono-punch'));
  assert.ok(state.list(ERA_SECTION).length > 0);

  state.clearSection(ERA_SECTION);
  deepEqual(state.list(ERA_SECTION), []);
  deepEqual(state.list('genre').map((e) => e.tag), ['techno'], 'nothing else may be touched');
  deepEqual(selectedEraSignatures(state), []);
});

s.test('a dissector era token and a signature share the group without doubling up', () => {
  // The two roads meet here. MUSIC_KB's 1980s trigger emits 'gated reverb
  // drums'; so does the Gated Reverb Drums signature. The store holds one
  // entry per (section, tag), so the group shows it ONCE.
  const state = createPromptState();
  state.add({ section: ERA_SECTION, tag: 'gated reverb drums', source: 'dissector', weight: 0.9 });

  const signature = eraSignatureById('sig-reverb-space-gated-drums');
  assert.strictEqual(signature.tags[0], 'gated reverb drums', 'fixture drift: the tags diverged');

  const outcome = toggleEraSignature(state, signature);
  assert.strictEqual(outcome.state, 'added');
  assert.strictEqual(outcome.added, signature.tags.length - 1, 'the shared tag must not be re-added');

  const tags = state.list(ERA_SECTION).map((e) => e.tag);
  assert.strictEqual(
    tags.filter((t) => t === 'gated reverb drums').length,
    1,
    'the same phrase reaching the group by both roads must be held once'
  );
  // …and the signature still reads as added, whatever put the tag there.
  assert.ok(eraSignatureHold(state, signature).complete);
});

/* ========================================================================== */
/* 7. Serialization — FDD #85/#86                                             */
/* ========================================================================== */

s.test('an era entry survives serializeWorkspace -> restoreWorkspace intact', () => {
  const source = makeRegistry();
  source.promptState.add({ section: 'genre', tag: 'shoegaze', source: 'manual', weight: 0.9 });
  const signature = eraSignatureById('sig-saturation-tape-cassette-compression');
  toggleEraSignature(source.promptState, signature);

  const snapshot = serializeWorkspace(source, { savedAt: 1000 });
  const eraRows = snapshot.prompt.filter((row) => row.section === ERA_SECTION);
  assert.strictEqual(eraRows.length, signature.tags.length, 'every era tag must be in the snapshot');
  deepEqual(eraRows.map((row) => row.tag), signature.tags);
  for (let i = 0; i < eraRows.length; i += 1) {
    assert.strictEqual(eraRows[i].source, ERA_SIGNATURE_SOURCE, 'the source must round-trip');
    assert.strictEqual(eraRows[i].weight, ERA_TAG_WEIGHTS[i], 'the weight must round-trip');
  }

  const target = makeRegistry();
  const outcome = restoreWorkspace(JSON.parse(JSON.stringify(snapshot)), target);
  assert.ok(outcome.ok, `restore refused the snapshot: ${outcome.reason}`);
  deepEqual(target.promptState.list(), source.promptState.list());
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
  deepEqual(
    selectedEraSignatures(target.promptState).map((e) => e.id),
    [signature.id],
    'a restored workspace shows the signature as selected again'
  );
});

s.test('a restore REPLACES the era group rather than merging into it', () => {
  const target = makeRegistry();
  toggleEraSignature(target.promptState, eraSignatureById('era-1950s-60s-mono-ribbon-vocal'));

  const source = makeRegistry();
  const wanted = eraSignatureById('sig-mix-master-crystalline-top-end');
  toggleEraSignature(source.promptState, wanted);

  const outcome = restoreWorkspace(serializeWorkspace(source), target);
  assert.ok(outcome.ok);
  deepEqual(
    selectedEraSignatures(target.promptState).map((e) => e.id),
    [wanted.id],
    'the mono mix must not survive a restore that never mentioned it'
  );
});

s.test('a preset built from the same snapshot carries the era tags too', () => {
  const registry = makeRegistry();
  const signature = eraSignatureById('era-2010s-2020s-lofi-chillhop-wobble');
  toggleEraSignature(registry.promptState, signature);

  const record = createPresetRecord('Dusty chillhop bed', serializeWorkspace(registry));
  assert.ok(record, 'the preset record must be built');
  const rows = record.workspace.prompt.filter((row) => row.section === ERA_SECTION);
  deepEqual(rows.map((row) => row.tag), signature.tags);

  const restored = makeRegistry();
  assert.ok(restoreWorkspace(JSON.parse(JSON.stringify(record.workspace)), restored).ok);
  deepEqual(selectedEraSignatures(restored.promptState).map((e) => e.id), [signature.id]);
});

s.test('a workspace holding BOTH a persona and a signature round-trips whole', () => {
  const source = makeRegistry();
  const persona = app.sandbox.vocalPersonaById('rock-metal-death-growl');
  const signature = eraSignatureById('era-1990s-4-track-tape-hiss');
  app.sandbox.toggleVocalPersona(source.promptState, persona);
  toggleEraSignature(source.promptState, signature);

  const snapshot = serializeWorkspace(source, { savedAt: 42 });
  deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, 'the snapshot must be plain data');
  for (const axis of SLIDER_AXES) assert.strictEqual(snapshot.sliders[axis], SLIDER_DEFAULT);

  const target = makeRegistry();
  assert.ok(restoreWorkspace(JSON.parse(JSON.stringify(snapshot)), target).ok);
  deepEqual(app.sandbox.selectedVocalPersonas(target.promptState).map((e) => e.id), [persona.id]);
  deepEqual(selectedEraSignatures(target.promptState).map((e) => e.id), [signature.id]);
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
});

/* ========================================================================== */
/* 8. The conflict proof — FDD #68                                            */
/* ========================================================================== */

s.test('a lo-fi cassette signature really does fight a hyper-clean radio master', () => {
  // FEATURE-MECHANICS §5.1's own worked example, reached from the registry
  // rather than from a hand-typed pair. NOTHING was added to TAG_CONFLICTS for
  // this: the signature's tags flow into the same ordered list every other tag
  // does, so the EXISTING rule sees them.
  const rule = TAG_CONFLICTS.find((r) => r.id === 'lofi-texture-vs-clean-master');
  assert.ok(rule, 'the FEATURE-MECHANICS §5.1 rule must exist');

  const state = createPromptState();
  const signature = eraSignatureById('sig-saturation-tape-cassette-compression');
  toggleEraSignature(state, signature);
  // The clean master arrives LATER and lighter, so the policy drops it.
  state.add({
    section: 'custom',
    tag: 'modern hyper-clean radio master',
    source: 'manual',
    weight: 0.3,
  });

  const compiled = compileStylePrompt(state, []);
  assert.strictEqual(
    compiled.meta.tags.indexOf('modern hyper-clean radio master'),
    -1,
    'the contradiction must not reach the copied prompt'
  );
  deepEqual(compiled.meta.tags, signature.tags, 'the signature survives whole');
  assert.strictEqual(compiled.meta.conflicts.length, 1, 'exactly one drop, and it is reported');
  deepEqual(compiled.meta.conflicts[0], {
    kept: 'lo-fi cassette warmth',
    dropped: 'modern hyper-clean radio master',
    rule: rule.rule,
    id: 'lofi-texture-vs-clean-master',
  });
  assert.ok(compiled.text.indexOf('lo-fi cassette warmth') !== -1);
});

s.test('the policy is positional, so a clean master added FIRST wins instead', () => {
  const state = createPromptState();
  state.add({
    section: 'genre',
    tag: 'modern hyper-clean radio master',
    source: 'manual',
    weight: 1,
  });
  const signature = eraSignatureById('sig-saturation-tape-cassette-compression');
  toggleEraSignature(state, signature);

  const compiled = compileStylePrompt(state, []);
  assert.ok(compiled.meta.tags.indexOf('modern hyper-clean radio master') !== -1);
  assert.strictEqual(
    compiled.meta.tags.indexOf('lo-fi cassette warmth'),
    -1,
    'the later, lighter lo-fi texture is the one that goes'
  );
  // …and the REST of the signature, which contradicts nothing, is untouched.
  assert.ok(compiled.meta.tags.indexOf('cassette compression') !== -1);
  assert.ok(compiled.meta.tags.indexOf('squashed dynamics') !== -1);
  deepEqual(
    compiled.meta.conflicts.map((c) => c.dropped),
    ['lo-fi cassette warmth'],
    'a conflict drops one tag, never a whole signature'
  );
});

s.test('every registry tag that the lo-fi rule claims is on the TEXTURE side of it', () => {
  // A signature landing on the CLEAN side of the rule would silently fight the
  // tape signatures beside it. Fourteen tags across nine entries match today,
  // and every one is side 'a' — the check is over the whole table, so a future
  // entry that broke it fails here rather than in a user's prompt.
  const rule = TAG_CONFLICTS.find((r) => r.id === 'lofi-texture-vs-clean-master');
  const sideOf = (tag) => app.sandbox.conflictSideOf(rule, normalizePromptTag(tag));
  let matched = 0;
  for (const entry of ERA_REGISTRY) {
    for (const tag of entry.tags) {
      const side = sideOf(tag);
      if (side === null) continue;
      matched += 1;
      assert.strictEqual(
        side,
        'a',
        `${entry.id}: "${tag}" sits on the clean-master side of the lo-fi rule`
      );
    }
  }
  assert.ok(matched > 0, 'no registry tag reaches the rule at all — the fixture has drifted');
});

s.test('two era signatures picked together compile without inventing a conflict', () => {
  // The resolver must not manufacture contradictions between signatures that
  // simply describe different parts of one chain (ENGINEERING-STANDARD §1.1).
  const state = createPromptState();
  toggleEraSignature(state, eraSignatureById('sig-reverb-space-gated-drums'));
  toggleEraSignature(state, eraSignatureById('era-1980s-fm-bell-sheen'));

  const compiled = compileStylePrompt(state, []);
  deepEqual(compiled.meta.conflicts, [], 'a reverb and a synth timbre are not opposites');
  assert.strictEqual(compiled.meta.tags.length, state.list(ERA_SECTION).length);
});

s.test('nothing in the registry conflicts with a plain, era-free prompt', () => {
  const base = ['techno', 'driving rhythm', 'warm analog saturation'];
  for (const entry of ERA_REGISTRY) {
    const result = resolveConflicts(base.concat(entry.tags));
    const dropped = result.conflicts.map((c) => c.dropped);
    for (const tag of entry.tags) {
      // A tag may legitimately clash with the base line above; what must never
      // happen is a signature quietly losing a tag to ANOTHER of its own.
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
/* 9. The card — static markup, wiring and styling contracts                  */
/* ========================================================================== */

s.test('the era card ships with every id the boot reaches for', () => {
  const card = readEraCardMarkup();
  for (const id of [
    'era-heading',
    'era-search',
    'era-count',
    'era-groups',
    'era-selected-empty',
    'era-chips',
    'era-empty',
    'era-list',
    'era-status',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(card), `the card is missing id="${id}"`);
  }
});

s.test('the card is a labelled region with a labelled search box and a live status', () => {
  const card = readEraCardMarkup();
  assert.ok(
    /aria-labelledby="era-heading"/.test(card),
    'the card must be a region named by its own heading'
  );
  assert.ok(
    /<label class="field-label" for="era-search">/.test(card),
    'the search box needs a real <label>, not a placeholder'
  );
  assert.ok(/type="search"/.test(card), 'the search box should be type="search"');
  assert.ok(
    /id="era-status"[^>]*role="status"[^>]*aria-live="polite"/.test(card),
    'add / remove outcomes must be announced'
  );
  assert.ok(
    /id="era-list"[^>]*class="vlist"[^>]*aria-label="Production era signatures"/.test(card),
    'the scroller must be the shared .vlist and must name itself'
  );
  assert.ok(/id="era-list"[^>]*tabindex="0"/.test(card), 'the scroller must be keyboard reachable');
  assert.ok(/id="era-empty"[^>]*hidden/.test(card), 'the empty-search line starts hidden');
  assert.ok(
    /id="era-groups"[^>]*role="group"[^>]*aria-label="[^"]+"/.test(card),
    'the filter chips are a named group, not a bare row of buttons'
  );
});

s.test('the card is wired to the registry, the shared scroller and the prompt store', () => {
  const boot = extractScriptById(INDEX, 'app-main');
  const start = boot.indexOf("const eraSearch = $('era-search');");
  assert.ok(start !== -1, 'the era card wiring has gone missing from the boot IIFE');
  const block = boot.slice(start, start + 12000);

  assert.ok(/searchEraRegistry\(query, eraGroupFilter\)/.test(block), 'the search is not wired');
  assert.ok(/createVirtualList\(\{/.test(block), 'the card must reuse the shared virtual scroller');
  assert.ok(/rowHeight: VIRTUAL_ROW_HEIGHT/.test(block), 'the row height must come from the constant');
  assert.ok(/promptState\.subscribe\(renderEraCard\)/.test(block), 'the card must follow the store');
  assert.ok(
    /eraSearch\.addEventListener\('input', renderEraCard\)/.test(block),
    'typing must repaint the card'
  );
  assert.ok(/toggleEraSignature\(promptState, signature\)/.test(block), 'the toggle is not wired');
  assert.ok(
    /aria-pressed', added \? 'true' : 'false'/.test(block),
    'the row toggle is not a pressed toggle'
  );
  assert.ok(/data-focus-key', 'era-toggle'/.test(block), 'the row toggle has no focus key');
  assert.ok(/keyOf: function \(signature\)/.test(block), 'the scroller needs a stable row key');
  assert.ok(
    /eraGroupFilter = eraGroupFilter === group\.id \? '' : group\.id/.test(block),
    'pressing the active group chip again must be the way back to All'
  );
  assert.ok(
    /ERA_REGISTRY\.length/.test(block),
    'the count line and the empty state must quote the real table size'
  );
});

s.test('the card lives in the Shape column, beside the vocal card it mirrors', () => {
  const editor = readEditorMarkup();
  const vocal = editor.indexOf('vocal-panel');
  const era = editor.indexOf('era-panel');
  const structure = editor.indexOf('structure-panel');
  assert.ok(vocal !== -1 && era !== -1 && structure !== -1, 'a card is missing from the view');
  assert.ok(vocal < era, 'the era card follows its sibling');
  assert.ok(era < structure, 'and still precedes the structure card');

  const shapeStart = editor.indexOf('class="editor-shape"');
  const railStart = editor.indexOf('class="editor-rail"');
  assert.ok(shapeStart !== -1 && railStart > shapeStart, 'the zoned split is gone');
  assert.ok(era > shapeStart && era < railStart, 'a card holding a search box must not be sticky');
});

s.test('the card styles itself from tokens only, in both themes', () => {
  const css = readStyle();
  for (const selector of [
    '.era-panel {',
    '.era-row {',
    '.era-count {',
    '.era-groups {',
    '.era-chips {',
    '.era-group-chip[aria-pressed="true"] {',
    '.btn-era[aria-pressed="true"] {',
  ]) {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `the stylesheet is missing a rule for ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(body),
      `${selector} hard-codes a colour, which no theme or Code Mode can reach:\n${body}`
    );
  }

  // The card answers to the same container name as its neighbours, so it
  // reflows against its own column rather than the window (ENGINEERING §2.2).
  assert.ok(
    /\.era-panel,\s*\n\s*\.structure-panel,/.test(css) ||
      /\.era-panel,[\s\S]{0,200}container-name: dissector;/.test(css),
    '.era-panel must join the dissector container group'
  );
  assert.ok(
    /@container dissector \(max-width: 520px\)[\s\S]*\.era-row \{ flex-direction: column;/.test(css),
    'a narrow card must stack the search row instead of squeezing it'
  );
});

s.test('a pressed FILTER chip does not wear the colour a pressed ADD button wears', () => {
  // Cyan has meant "this is in your prompt" since the persona card shipped. A
  // group chip changes the VIEW and nothing else, so it must not borrow it.
  const css = readStyle();
  const filterStart = css.indexOf('.era-group-chip[aria-pressed="true"] {');
  const filter = css.slice(filterStart, css.indexOf('}', filterStart));
  assert.ok(/var\(--ink-violet\)/.test(filter), 'chip TEXT must ride the AA-clearing violet ink');
  assert.ok(!/--accent-cyan|--tint-cyan/.test(filter), 'a filter must not read as an added tag');
  // MEASURED, not preferred: a --tint-violet wash behind --ink-violet lifts the
  // backdrop far enough to drag the label to 4.36:1 in Studio Obsidian, under
  // AA. Keeping the base .chip ground holds it at 5.09:1 in the worst theme.
  assert.ok(
    !/background:/.test(filter),
    'the pressed filter chip must not paint its own ground — a wash behind --ink-violet ' +
      'falls under AA in Obsidian and Tape Deck; the border and the ink carry the state'
  );
  assert.ok(/border-color:\s*var\(--accent-violet\)/.test(filter), 'the border is the second signal');

  const addStart = css.indexOf('.btn-era[aria-pressed="true"] {');
  const add = css.slice(addStart, css.indexOf('}', addStart));
  assert.ok(/var\(--accent-cyan\)/.test(add), 'an added signature keeps the additive cyan');
});

s.test('Code Mode keeps both pressed states legible once the washes are gone', () => {
  const css = readStyle();
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(
    /\.high-contrast \.btn-era\[aria-pressed="true"\]\s*\{[^}]*var\(--accent-cyan\)/.test(contrast),
    'flattening the wash must leave the cyan border as the added signal'
  );
  assert.ok(
    /\.high-contrast \.era-group-chip\[aria-pressed="true"\]\s*\{[^}]*var\(--accent-violet\)/.test(
      contrast
    ),
    'and the violet border as the filtered signal — the two must stay distinguishable'
  );
});

s.test('the draft card already knows what to call the era group', () => {
  const source = extractScriptById(INDEX, 'app-main');
  const start = source.indexOf('const SECTION_LABELS = {');
  assert.ok(start !== -1, 'SECTION_LABELS disappeared');
  const block = source.slice(start, source.indexOf('};', start));
  assert.ok(/era: 'Era'/.test(block), 'the era group has no human label in the draft card');
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
