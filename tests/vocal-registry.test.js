'use strict';
/*
 * tests/vocal-registry.test.js — the Expanded Vocal Registries and the card
 * built on them:
 *
 *   docs/FDD.md #65  Expanded Vocal Registries  -> var VOCAL_REGISTRY
 *   docs/FDD.md #28  Vocal Persona Selector     -> searchVocalRegistry(),
 *                                                  vocalPersonaSeeds(),
 *                                                  toggleVocalPersona() and
 *                                                  the #vocal-list card
 *
 * WHAT IS COVERED
 *   - the table itself: size, the eight families, unique ids / labels /
 *     naming tags, kebab ids that carry their own family prefix, tags that are
 *     lowercase and comma-free, 2-4 tags plus a description on every entry,
 *     and a blocklist scan proving no real artist, band or track was named;
 *   - searchVocalRegistry: what it matches, what it deliberately does not
 *     (descriptions), the empty query, and its query-independent order;
 *   - the selector's pure logic over a REAL createPromptState: position
 *     weighting, add / remove toggling, half-a-persona, and the shared-tag
 *     rule that stops one removal breaking the persona beside it;
 *   - the section order this release changed, asserted from BOTH sides —
 *     draftText() (the ingredients) and weightTokens() (the compiler);
 *   - a vocal entry surviving serializeWorkspace -> restoreWorkspace and the
 *     preset record built from the same snapshot;
 *   - the #68 conflict proof: an instrumental-only directive really does drop
 *     a persona's naming tag, for EVERY persona in the table, and the
 *     rule's original hand-written vocabulary still works;
 *   - the static markup, aria and wiring contracts of the new card, plus its
 *     token-only styling in both themes and in Code Mode.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Live DOM event wiring: the click that toggles a row, the virtual
 *     scroller's own painting and the focus rescue on the chip row. Those need
 *     a browser; the boot IIFE is proven inert outside one, the pure halves
 *     are exercised behaviourally here, and the strings the live card depends
 *     on are asserted statically at the bottom of this file.
 *   - createVirtualList itself. tests/persistence.test.js owns that contract;
 *     this card reuses it rather than growing a second scroller.
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

/* docs/FDD.md #65 promises "80+ timbres"; the table may grow, never shrink
 * below the promise. */
const REGISTRY_MIN = 80;
const FAMILY_COUNT = 8;

/*
 * The Safe-Mode standard (FDD #24) applied to a static table: a registry that
 * shipped a real performer's name would put it one click away from the copied
 * prompt, which is exactly what the sanitizer exists to prevent. This list is a
 * SPOT CHECK of obvious, widely known names across the eight families — it is
 * not a claim to be exhaustive, and it is written here rather than in
 * index.html so the check cannot be satisfied by editing the thing it checks.
 */
const ARTIST_BLOCKLIST = [
  'pavarotti',
  'callas',
  'sinatra',
  'ella fitzgerald',
  'aretha',
  'billie holiday',
  'nina simone',
  'freddie mercury',
  'cobain',
  'ozzy',
  'bowie',
  'beyonce',
  'billie eilish',
  'adele',
  'taylor swift',
  'eminem',
  'tupac',
  'kendrick',
  'drake',
  'daft punk',
  'cher',
  'bjork',
  'enya',
  'elvis',
  'johnny cash',
  'dolly parton',
  'bob dylan',
  'beatles',
  'metallica',
  'nirvana',
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
  VOCAL_REGISTRY,
  VOCAL_SECTION,
  VOCAL_PERSONA_SOURCE,
  VOCAL_TAG_WEIGHTS,
  vocalRegistryFamilies,
  searchVocalRegistry,
  vocalPersonaById,
  vocalPersonaSeeds,
  vocalPersonaHold,
  selectedVocalPersonas,
  toggleVocalPersona,
  vocalPersonaConflictPhrases,
  createPromptState,
  createExclusionState,
  createStructureState,
  createPresetRecord,
  serializeWorkspace,
  restoreWorkspace,
  weightTokens,
  resolveConflicts,
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

/** The Vocal Persona card's own markup, from its <section> to the next one. */
function readVocalCardMarkup() {
  const editor = readEditorMarkup();
  const start = editor.indexOf('class="view-col vibe-card vocal-panel"');
  assert.ok(start !== -1, 'the Prompt Editor has no .vocal-panel card');
  const end = editor.indexOf('</section>', start);
  assert.ok(end > start, 'the .vocal-panel card is never closed');
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

const s = suite('vocal registry + persona selector (FDD #65/#28)');

/* ========================================================================== */
/* 1. Reachability                                                            */
/* ========================================================================== */

s.test('the registry and its helpers are reachable top-level declarations', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined', 'the boot IIFE must stay inert');
  for (const name of [
    'vocalRegistryFamilies',
    'searchVocalRegistry',
    'vocalPersonaById',
    'vocalPersonaSeeds',
    'vocalPersonaHold',
    'selectedVocalPersonas',
    'toggleVocalPersona',
    'vocalPersonaConflictPhrases',
  ]) {
    assert.strictEqual(fresh.evaluate(`typeof ${name}`), 'function', `${name} is not reachable`);
  }
  for (const name of ['VOCAL_REGISTRY', 'VOCAL_SECTION', 'VOCAL_PERSONA_SOURCE', 'VOCAL_TAG_WEIGHTS']) {
    assert.ok(fresh.sandbox[name] !== undefined, `${name} must be a var binding tests can read`);
  }
  assert.strictEqual(VOCAL_SECTION, 'vocal');
  assert.strictEqual(VOCAL_PERSONA_SOURCE, 'vocal-persona');
});

/* ========================================================================== */
/* 2. Registry integrity — FDD #65                                            */
/* ========================================================================== */

s.test(`the table ships at least ${REGISTRY_MIN} timbres across ${FAMILY_COUNT} families`, () => {
  assert.ok(Array.isArray(VOCAL_REGISTRY), 'VOCAL_REGISTRY must be an array');
  assert.ok(
    VOCAL_REGISTRY.length >= REGISTRY_MIN,
    `FDD #65 promises 80+ timbres; the table holds ${VOCAL_REGISTRY.length}`
  );

  const families = vocalRegistryFamilies();
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
  assert.strictEqual(counted, VOCAL_REGISTRY.length, 'the family counts must add up to the table');

  // The four families FDD #65 names by hand must all be represented.
  const labels = families.map((f) => f.label.toLowerCase()).join(' | ');
  for (const promised of ['choral', 'pop', 'rap', 'metal']) {
    assert.ok(labels.indexOf(promised) !== -1, `#65 names "${promised}"; no family covers it`);
  }
});

s.test('ids are kebab-case, unique, and carry their own family prefix', () => {
  const ids = new Set();
  for (const entry of VOCAL_REGISTRY) {
    assert.ok(typeof entry.id === 'string' && entry.id, `an entry has no id: ${JSON.stringify(entry)}`);
    assert.ok(!ids.has(entry.id), `duplicate id "${entry.id}"`);
    ids.add(entry.id);
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id),
      `id "${entry.id}" is not kebab-case (lowercase, digits and single hyphens)`
    );
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.family),
      `family "${entry.family}" is not kebab-case`
    );
    assert.strictEqual(
      entry.id.indexOf(entry.family + '-'),
      0,
      `id "${entry.id}" does not start with its family "${entry.family}-"`
    );
  }
});

s.test('labels and family labels are unique, human, and consistent per family', () => {
  const labels = new Set();
  const familyLabels = Object.create(null);
  for (const entry of VOCAL_REGISTRY) {
    const key = entry.label.toLowerCase();
    assert.ok(typeof entry.label === 'string' && entry.label.trim(), `${entry.id} has no label`);
    assert.ok(!labels.has(key), `duplicate persona label "${entry.label}"`);
    labels.add(key);

    assert.ok(typeof entry.familyLabel === 'string' && entry.familyLabel.trim());
    if (familyLabels[entry.family] === undefined) familyLabels[entry.family] = entry.familyLabel;
    assert.strictEqual(
      entry.familyLabel,
      familyLabels[entry.family],
      `${entry.id}: family "${entry.family}" is labelled two different ways`
    );
  }
});

s.test('every entry carries 2-4 lowercase, comma-free tags and one description', () => {
  for (const entry of VOCAL_REGISTRY) {
    assert.ok(Array.isArray(entry.tags), `${entry.id}.tags is not an array`);
    assert.ok(
      entry.tags.length >= 2 && entry.tags.length <= 4,
      `${entry.id} has ${entry.tags.length} tags; the contract is 2-4`
    );
    for (const tag of entry.tags) {
      assert.ok(typeof tag === 'string' && tag.trim(), `${entry.id} holds an empty tag`);
      assert.strictEqual(tag, tag.toLowerCase(), `${entry.id}: tag "${tag}" is not lowercase`);
      assert.strictEqual(tag, tag.trim(), `${entry.id}: tag "${tag}" has stray whitespace`);
      assert.ok(!/\s{2,}/.test(tag), `${entry.id}: tag "${tag}" has a double space`);
      // A comma would split one tag into two the moment the draft is joined.
      assert.strictEqual(tag.indexOf(','), -1, `${entry.id}: tag "${tag}" contains a comma`);
      assert.strictEqual(tag.indexOf('['), -1, `${entry.id}: tag "${tag}" looks like a metatag`);
    }
    assert.ok(
      typeof entry.description === 'string' && entry.description.trim().length >= 20,
      `${entry.id} has no usable description`
    );
    assert.ok(
      /[.!?]$/.test(entry.description.trim()),
      `${entry.id}: the description is prose for a human and should end as a sentence`
    );
  }
});

s.test('the naming tag of every persona is unique across the table', () => {
  // tags[0] is the persona's identity: it is what the conflict rule matches on
  // and what the row shows, so two personas sharing one would be two rows the
  // prompt state could never tell apart.
  const seen = new Map();
  for (const entry of VOCAL_REGISTRY) {
    const key = normalizePromptTag(entry.tags[0]);
    assert.ok(
      !seen.has(key),
      `"${entry.tags[0]}" names both ${seen.get(key)} and ${entry.id}`
    );
    seen.set(key, entry.id);
  }
});

s.test('no entry names a real artist, band or track (FDD #24 Safe-Mode standard)', () => {
  for (const entry of VOCAL_REGISTRY) {
    const haystack = (
      entry.id +
      ' ' +
      entry.label +
      ' ' +
      entry.tags.join(' ') +
      ' ' +
      entry.description
    ).toLowerCase();
    for (const name of ARTIST_BLOCKLIST) {
      assert.strictEqual(
        haystack.indexOf(name),
        -1,
        `${entry.id} names "${name}" — the registry describes techniques, never performers`
      );
    }
  }
});

s.test('a persona is internally consistent: its own tags never contradict each other', () => {
  // The same standard tests/compiler.test.js holds MUSIC_KB to. A persona that
  // fought itself would drop one of its own tags the instant it was added.
  for (const entry of VOCAL_REGISTRY) {
    const result = resolveConflicts(entry.tags);
    deepEqual(
      result.conflicts,
      [],
      `${entry.id} contradicts itself: ${JSON.stringify(host(result.conflicts))}`
    );
  }
});

/* ========================================================================== */
/* 3. searchVocalRegistry                                                     */
/* ========================================================================== */

s.test('an empty or whitespace-only query is not a filter — everything matches', () => {
  for (const query of ['', '   ', '\t\n', undefined, null, 42, {}]) {
    assert.strictEqual(
      searchVocalRegistry(query).length,
      VOCAL_REGISTRY.length,
      `query ${JSON.stringify(query)} must match the whole table`
    );
  }
});

s.test('search is case-insensitive over label, tags and family — but not description', () => {
  const byLabel = searchVocalRegistry('RaSpY rOcK').map((e) => e.id);
  deepEqual(byLabel, ['rock-metal-raspy-baritone'], 'a label match is case-insensitive');

  const byTag = searchVocalRegistry('vocoder').map((e) => e.id);
  assert.ok(
    byTag.indexOf('electronic-processed-vocoder-choir') !== -1,
    'a tag match must find the Vocoder Choir'
  );

  const byFamilyId = searchVocalRegistry('character-texture');
  assert.ok(byFamilyId.length > 0, 'the family id must be searchable');
  for (const entry of byFamilyId) assert.strictEqual(entry.family, 'character-texture');

  const byFamilyLabel = searchVocalRegistry('Folk, World');
  assert.ok(byFamilyLabel.length > 0, 'the family LABEL must be searchable too');
  for (const entry of byFamilyLabel) assert.strictEqual(entry.family, 'folk-world');

  // A word that lives only in a description must NOT match: descriptions are
  // prose for a human, and searching them makes short queries match half the
  // table for reasons the user cannot see.
  const proseOnly = VOCAL_REGISTRY.find(
    (e) => e.description.toLowerCase().indexOf('rafter') !== -1
  );
  assert.ok(proseOnly, 'fixture drifted: no description mentions "rafter"');
  deepEqual(searchVocalRegistry('rafter'), [], 'descriptions are deliberately not searched');
});

s.test('a query that matches nothing returns nothing — never a nearest guess', () => {
  deepEqual(searchVocalRegistry('zzzz-not-a-timbre'), []);
  deepEqual(searchVocalRegistry('bagpipe solo'), []);
});

s.test('the order is family-then-label and does not depend on the query', () => {
  const families = vocalRegistryFamilies().map((f) => f.id);
  const check = (query) => {
    const hits = searchVocalRegistry(query);
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
  check('vocals');
  const first = check('a');
  const second = searchVocalRegistry('a').map((e) => e.id);
  deepEqual(first, second, 'the same query must produce the same order every time');
});

s.test('searchVocalRegistry hands back the table entries, and the table is never re-sorted', () => {
  const before = VOCAL_REGISTRY.map((e) => e.id);
  searchVocalRegistry('vocals');
  searchVocalRegistry('');
  deepEqual(
    VOCAL_REGISTRY.map((e) => e.id),
    before,
    'sorting the search result must not sort the registry itself'
  );
});

s.test('vocalPersonaById finds by id and answers null for anything else', () => {
  const entry = vocalPersonaById('jazz-soul-blues-gospel-powerhouse');
  assert.ok(entry, 'a known id must resolve');
  assert.strictEqual(entry.label, 'Gospel Powerhouse');
  for (const missing of ['', 'nope', null, undefined, 42, {}]) {
    assert.strictEqual(vocalPersonaById(missing), null, `${JSON.stringify(missing)} is not an id`);
  }
});

/* ========================================================================== */
/* 4. Seeds, weighting and the add/remove toggle                              */
/* ========================================================================== */

s.test('seeds file under the vocal section and source, weighted by POSITION', () => {
  const persona = vocalPersonaById('choral-classical-dramatic-soprano');
  const seeds = vocalPersonaSeeds(persona);
  assert.strictEqual(seeds.length, persona.tags.length);
  deepEqual(seeds.map((seed) => seed.tag), persona.tags, 'tag order must survive');
  for (let i = 0; i < seeds.length; i += 1) {
    assert.strictEqual(seeds[i].section, VOCAL_SECTION);
    assert.strictEqual(seeds[i].source, VOCAL_PERSONA_SOURCE);
    assert.strictEqual(seeds[i].weight, VOCAL_TAG_WEIGHTS[i], `tag ${i} got the wrong weight`);
  }
  // The first tag is the heaviest, and the weights only ever fall.
  for (let i = 1; i < seeds.length; i += 1) {
    assert.ok(seeds[i].weight < seeds[i - 1].weight, 'the weights must descend with position');
  }
  deepEqual(VOCAL_TAG_WEIGHTS, [0.9, 0.7, 0.6, 0.5]);
});

s.test('vocalPersonaSeeds is defensive: junk in, an empty list out', () => {
  for (const junk of [undefined, null, 42, 'persona', {}, { tags: null }, { tags: 'x' }]) {
    deepEqual(vocalPersonaSeeds(junk), [], `${JSON.stringify(junk)} must yield no seeds`);
  }
  deepEqual(vocalPersonaSeeds({ tags: ['  ', ''] }), [], 'blank tags are not tags');
});

s.test('the first toggle adds every tag of a persona, in one notification', () => {
  const state = createPromptState();
  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });

  const persona = vocalPersonaById('rock-metal-raspy-baritone');
  const outcome = toggleVocalPersona(state, persona);

  assert.strictEqual(outcome.state, 'added');
  assert.strictEqual(outcome.added, persona.tags.length);
  assert.strictEqual(outcome.removed, 0);
  assert.strictEqual(notifications, 1, 'one user action must publish exactly one change');
  deepEqual(state.list(VOCAL_SECTION).map((e) => e.tag), persona.tags);
  for (const entry of state.list(VOCAL_SECTION)) {
    assert.strictEqual(entry.source, VOCAL_PERSONA_SOURCE);
  }
});

s.test('the second toggle takes the same tags straight back out', () => {
  const state = createPromptState();
  const persona = vocalPersonaById('rock-metal-raspy-baritone');
  toggleVocalPersona(state, persona);

  let notifications = 0;
  state.subscribe(() => {
    notifications += 1;
  });
  const outcome = toggleVocalPersona(state, persona);

  assert.strictEqual(outcome.state, 'removed');
  assert.strictEqual(outcome.removed, persona.tags.length);
  assert.strictEqual(notifications, 1, 'a removal is one action too');
  deepEqual(state.list(VOCAL_SECTION), []);
  assert.strictEqual(state.draftText(), '', 'the draft is empty again');
});

s.test('a persona is "added" only when EVERY tag is held — half a persona is not one', () => {
  const state = createPromptState();
  const persona = vocalPersonaById('pop-indie-stadium-belter');
  toggleVocalPersona(state, persona);
  assert.strictEqual(vocalPersonaHold(state, persona).complete, true);

  // The user removes one chip by hand from the draft card.
  const victim = state.list(VOCAL_SECTION)[1];
  state.remove(victim.id);
  const hold = vocalPersonaHold(state, persona);
  assert.strictEqual(hold.complete, false, 'a persona missing a tag is not added');
  assert.strictEqual(hold.missing.length, 1);
  assert.strictEqual(hold.missing[0].tag, victim.tag);
  deepEqual(selectedVocalPersonas(state), [], 'and it is not in the selected list either');

  // Toggling now COMPLETES it rather than removing what is left.
  const outcome = toggleVocalPersona(state, persona);
  assert.strictEqual(outcome.state, 'added');
  assert.strictEqual(outcome.added, 1, 'only the missing tag is added back');
  assert.strictEqual(vocalPersonaHold(state, persona).complete, true);
});

s.test('removing one persona never breaks another that still claims a shared tag', () => {
  // The table shares exactly one texture word between two personas today; the
  // rule is written against the SHAPE, so it holds however that changes.
  const shared = [];
  for (let i = 0; i < VOCAL_REGISTRY.length && !shared.length; i += 1) {
    for (let j = i + 1; j < VOCAL_REGISTRY.length && !shared.length; j += 1) {
      const overlap = VOCAL_REGISTRY[i].tags.filter(
        (tag) => VOCAL_REGISTRY[j].tags.indexOf(tag) !== -1
      );
      if (overlap.length) shared.push(VOCAL_REGISTRY[i], VOCAL_REGISTRY[j], overlap[0]);
    }
  }
  assert.strictEqual(shared.length, 3, 'fixture drifted: no two personas share a tag any more');
  const [first, second, tag] = shared;

  const state = createPromptState();
  toggleVocalPersona(state, first);
  toggleVocalPersona(state, second);
  assert.strictEqual(selectedVocalPersonas(state).length, 2);

  const outcome = toggleVocalPersona(state, first);
  assert.strictEqual(outcome.state, 'removed');
  assert.strictEqual(outcome.kept, 1, 'the shared tag must be reported as kept, not dropped');
  assert.strictEqual(
    vocalPersonaHold(state, second).complete,
    true,
    `removing "${first.label}" broke "${second.label}"`
  );
  const held = state.list(VOCAL_SECTION).map((e) => e.tag);
  assert.ok(held.indexOf(tag) !== -1, `the shared tag "${tag}" must survive`);
  assert.ok(held.indexOf(first.tags[0]) === -1, 'the removed persona keeps nothing of its own');
});

s.test('toggleVocalPersona is defensive: junk in, a no-op out — never a throw', () => {
  const state = createPromptState();
  for (const junk of [undefined, null, 42, {}, { id: 'x', tags: [] }]) {
    const outcome = toggleVocalPersona(state, junk);
    assert.strictEqual(outcome.state, 'noop', `${JSON.stringify(junk)} must change nothing`);
    assert.strictEqual(outcome.added, 0);
    assert.strictEqual(outcome.removed, 0);
  }
  deepEqual(state.list(), []);
  // A missing store is a no-op too, rather than a crash on the click path.
  const orphan = toggleVocalPersona(null, VOCAL_REGISTRY[0]);
  assert.strictEqual(orphan.state, 'noop');
});

s.test('selectedVocalPersonas reports every fully-held persona, in registry order', () => {
  const state = createPromptState();
  const picks = ['character-texture-childlike-naive', 'choral-classical-basso-profondo'];
  for (const id of picks) toggleVocalPersona(state, vocalPersonaById(id));
  deepEqual(
    selectedVocalPersonas(state).map((e) => e.id),
    ['choral-classical-basso-profondo', 'character-texture-childlike-naive'],
    'the chip row follows the table, not the order the user clicked'
  );
});

s.test('every persona in the table round-trips through add, hold and remove', () => {
  for (const persona of VOCAL_REGISTRY) {
    const state = createPromptState();
    const added = toggleVocalPersona(state, persona);
    assert.strictEqual(added.state, 'added', `${persona.id} could not be added`);
    assert.strictEqual(
      added.added,
      persona.tags.length,
      `${persona.id} added ${added.added} of ${persona.tags.length} tags`
    );
    assert.strictEqual(vocalPersonaHold(state, persona).complete, true, `${persona.id} is not held`);
    const removed = toggleVocalPersona(state, persona);
    assert.strictEqual(removed.state, 'removed', `${persona.id} could not be removed`);
    assert.strictEqual(state.list(VOCAL_SECTION).length, 0, `${persona.id} left tags behind`);
  }
});

/* ========================================================================== */
/* 5. Section ordering — the canonical order this release changed             */
/* ========================================================================== */

s.test('the canonical order is genre, mood, vocal, instrument, scene, era, custom', () => {
  /* CHANGED IN 0.13.0, deliberately. 'vocal' was inserted between 'mood' and
   * 'instrument': a named voice decides WHO is singing and colours every
   * instrument choice after it, and Suno v5.5 weights what it reads first, so
   * the one tag saying a human sings at all must not sit behind a long
   * instrument list. Nothing else moved. */
  deepEqual(PROMPT_SECTION_ORDER, [
    'genre',
    'mood',
    'vocal',
    'instrument',
    'scene',
    'era',
    'custom',
  ]);
  deepEqual(PROMPT_SECTIONS, PROMPT_SECTION_ORDER.concat(['slider']));
  assert.strictEqual(PROMPT_SECTION_ORDER.indexOf(VOCAL_SECTION), 2);
  assert.ok(
    PROMPT_SECTION_ORDER.indexOf('mood') < PROMPT_SECTION_ORDER.indexOf(VOCAL_SECTION),
    'the mood still leads the voice'
  );
  assert.ok(
    PROMPT_SECTION_ORDER.indexOf(VOCAL_SECTION) < PROMPT_SECTION_ORDER.indexOf('instrument'),
    'the voice leads the instruments'
  );
  assert.ok(PROMPT_SOURCES.indexOf(VOCAL_PERSONA_SOURCE) !== -1, 'the source must be registered');
  assert.strictEqual(PROMPT_SOURCE_SECTION[VOCAL_PERSONA_SOURCE], VOCAL_SECTION);
});

s.test('draftText emits the vocal group between the moods and the instruments', () => {
  const state = createPromptState();
  // Added in deliberately the WRONG order.
  state.add({ section: 'custom', tag: 'hand written', source: 'manual' });
  state.add({ section: 'era', tag: '1980s production', source: 'dissector' });
  state.add({ section: 'scene', tag: 'neon rain', source: 'scene' });
  state.add({ section: 'instrument', tag: 'TR-909 kick', source: 'dissector' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });
  state.add({ section: 'genre', tag: 'techno', source: 'dissector' });
  toggleVocalPersona(state, vocalPersonaById('rock-metal-raspy-baritone'));

  assert.strictEqual(
    state.draftText(),
    'techno, hypnotic, raspy baritone vocals, gravelly chest voice, rock grit, TR-909 kick, ' +
      'neon rain, 1980s production, hand written'
  );
});

s.test('weightTokens emits the same order — the compiler and the draft agree', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', weight: 1, source: 'dissector' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });
  state.add({ section: 'instrument', tag: 'TR-909 kick', source: 'dissector' });
  state.add({ section: 'era', tag: '1980s production', source: 'dissector' });
  toggleVocalPersona(state, vocalPersonaById('jazz-soul-blues-torch-singer'));

  const ordered = weightTokens(state.list());
  deepEqual(ordered, [
    'techno',
    'hypnotic',
    'aching torch vocals',
    'sultry vibrato',
    'slow ballad phrasing',
    'TR-909 kick',
    '1980s production',
  ]);
  // Same tags, same order, from the ingredient store's own compiler.
  deepEqual(ordered, state.draftText().split(', '));

  // The heavier naming tag does NOT jump the mood: only the genre bucket is
  // ever re-sorted by weight (FDD #73).
  assert.ok(ordered.indexOf('hypnotic') < ordered.indexOf('aching torch vocals'));
});

s.test('clearSection("vocal") empties the group like any other', () => {
  const state = createPromptState();
  const persona = vocalPersonaById('folk-world-alpine-yodel');
  toggleVocalPersona(state, persona);
  assert.strictEqual(state.counts().sections[VOCAL_SECTION], persona.tags.length);
  assert.strictEqual(state.clearSection(VOCAL_SECTION), persona.tags.length);
  assert.strictEqual(state.counts().sections[VOCAL_SECTION], 0);
  deepEqual(selectedVocalPersonas(state), []);
});

/* ========================================================================== */
/* 6. Serialization — FDD #85/#86                                             */
/* ========================================================================== */

s.test('a vocal entry survives serializeWorkspace -> restoreWorkspace intact', () => {
  const source = makeRegistry();
  source.promptState.add({ section: 'genre', tag: 'french electro', source: 'manual', weight: 0.9 });
  const persona = vocalPersonaById('electronic-processed-vocoder-choir');
  toggleVocalPersona(source.promptState, persona);

  const snapshot = serializeWorkspace(source, { savedAt: 1000 });
  const vocalRows = snapshot.prompt.filter((row) => row.section === VOCAL_SECTION);
  assert.strictEqual(vocalRows.length, persona.tags.length, 'every vocal tag must be in the snapshot');
  deepEqual(vocalRows.map((row) => row.tag), persona.tags);
  for (let i = 0; i < vocalRows.length; i += 1) {
    assert.strictEqual(vocalRows[i].source, VOCAL_PERSONA_SOURCE, 'the source must round-trip');
    assert.strictEqual(vocalRows[i].weight, VOCAL_TAG_WEIGHTS[i], 'the weight must round-trip');
  }

  const target = makeRegistry();
  const outcome = restoreWorkspace(JSON.parse(JSON.stringify(snapshot)), target);
  assert.ok(outcome.ok, `restore refused the snapshot: ${outcome.reason}`);
  deepEqual(target.promptState.list(), source.promptState.list());
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
  deepEqual(
    selectedVocalPersonas(target.promptState).map((e) => e.id),
    [persona.id],
    'a restored workspace shows the persona as selected again'
  );
});

s.test('a restore REPLACES the vocal group rather than merging into it', () => {
  const target = makeRegistry();
  toggleVocalPersona(target.promptState, vocalPersonaById('rock-metal-death-growl'));

  const source = makeRegistry();
  const wanted = vocalPersonaById('character-texture-lullaby-soft');
  toggleVocalPersona(source.promptState, wanted);

  const outcome = restoreWorkspace(serializeWorkspace(source), target);
  assert.ok(outcome.ok);
  deepEqual(
    selectedVocalPersonas(target.promptState).map((e) => e.id),
    [wanted.id],
    'the growl must not survive a restore that never mentioned it'
  );
});

s.test('a preset built from the same snapshot carries the vocal tags too', () => {
  const registry = makeRegistry();
  const persona = vocalPersonaById('hiphop-spoken-boom-bap');
  toggleVocalPersona(registry.promptState, persona);

  const record = createPresetRecord('Boom bap bed', serializeWorkspace(registry));
  assert.ok(record, 'the preset record must be built');
  const rows = record.workspace.prompt.filter((row) => row.section === VOCAL_SECTION);
  deepEqual(rows.map((row) => row.tag), persona.tags);

  const restored = makeRegistry();
  assert.ok(restoreWorkspace(JSON.parse(JSON.stringify(record.workspace)), restored).ok);
  deepEqual(selectedVocalPersonas(restored.promptState).map((e) => e.id), [persona.id]);
});

s.test('the snapshot survives a JSON round-trip byte for byte', () => {
  const registry = makeRegistry();
  toggleVocalPersona(registry.promptState, vocalPersonaById('folk-world-qawwali-lead'));
  const snapshot = serializeWorkspace(registry, { savedAt: 42 });
  deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, 'the snapshot must be plain data');
  for (const axis of SLIDER_AXES) assert.strictEqual(snapshot.sliders[axis], SLIDER_DEFAULT);
});

/* ========================================================================== */
/* 7. The conflict proof — FDD #68                                            */
/* ========================================================================== */

s.test('the instrumental rule now names every persona in the registry', () => {
  const rule = TAG_CONFLICTS.find((r) => r.id === 'instrumental-vs-vocals');
  assert.ok(rule, 'the instrumental-vs-vocals rule must exist');
  assert.strictEqual(rule.match, 'phrase');

  const phrases = vocalPersonaConflictPhrases();
  assert.strictEqual(phrases.length, VOCAL_REGISTRY.length, 'one naming tag per persona');
  deepEqual(phrases, VOCAL_REGISTRY.map((e) => e.tags[0]));
  for (const phrase of phrases) {
    assert.ok(rule.b.indexOf(phrase) !== -1, `"${phrase}" is not on the rule's vocal side`);
  }

  // The hand-written vocabulary the rule shipped with is still there: the
  // registry EXTENDS it, it does not replace it.
  for (const original of ['lead vocal', 'male vocals', 'female vocals', 'rap vocal']) {
    assert.ok(rule.b.indexOf(original) !== -1, `the rule lost its original phrase "${original}"`);
  }
  // And the two sides stay disjoint, or a tag would contradict itself.
  const left = new Set(rule.a.map((m) => normalizePromptTag(m)));
  for (const member of rule.b) {
    assert.ok(!left.has(normalizePromptTag(member)), `"${member}" is on both sides`);
  }
});

s.test('an instrumental-only directive drops the naming tag of EVERY persona', () => {
  for (const persona of VOCAL_REGISTRY) {
    const result = resolveConflicts(['instrumental only', persona.tags[0]]);
    deepEqual(
      result.tags,
      ['instrumental only'],
      `"${persona.tags[0]}" survived an instrumental-only directive`
    );
    assert.strictEqual(result.conflicts.length, 1, `${persona.id}: the drop must be reported`);
    assert.strictEqual(result.conflicts[0].id, 'instrumental-vs-vocals');
    assert.strictEqual(result.conflicts[0].kept, 'instrumental only');
    assert.strictEqual(result.conflicts[0].dropped, persona.tags[0]);
    assert.ok(
      result.conflicts[0].rule.length > 20,
      'the UI prints the reason verbatim, so it has to be a sentence'
    );
  }
});

s.test('"raspy baritone vocals" is the worked example, and the EARLIER tag wins', () => {
  const instrumentalFirst = resolveConflicts(['purely instrumental', 'raspy baritone vocals']);
  deepEqual(instrumentalFirst.tags, ['purely instrumental']);
  deepEqual(instrumentalFirst.conflicts.map((c) => c.dropped), ['raspy baritone vocals']);

  // Reversed: the heavier, earlier tag still wins — the rule has no favourite
  // side, only an order.
  const vocalFirst = resolveConflicts(['raspy baritone vocals', 'purely instrumental']);
  deepEqual(vocalFirst.tags, ['raspy baritone vocals']);
  deepEqual(vocalFirst.conflicts.map((c) => c.dropped), ['purely instrumental']);
});

s.test('the rule still catches its original vocabulary, both directions', () => {
  // The regression this guards: a bare "vocals" phrase on the vocal side would
  // have put "no vocals" and "without vocals" on BOTH sides of the rule, which
  // this resolver treats as ambiguous — silently switching the rule off for
  // the two most obvious instrumental directives in it.
  for (const directive of ['no vocals', 'without vocals', 'instrumental version']) {
    const result = resolveConflicts([directive, 'male vocals']);
    deepEqual(result.tags, [directive], `"${directive}" stopped conflicting with a vocal part`);
    assert.strictEqual(result.conflicts.length, 1);
    assert.strictEqual(result.conflicts[0].id, 'instrumental-vs-vocals');
  }
});

s.test('a persona and a hand-typed instrumental directive resolve honestly, both ways', () => {
  const persona = vocalPersonaById('pop-indie-whisper-pop');

  /* Through the real pipeline first. A hand-typed "purely instrumental" lands
   * in the 'custom' group, which is emitted LAST, so the persona reaches the
   * resolver first and the directive is the tag that goes. That is the rule
   * working, not failing: the resolver keeps the earlier, heavier tag and
   * REPORTS the drop rather than quietly picking a winner. */
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'downtempo', weight: 0.8, source: 'manual' });
  state.add({ section: 'custom', tag: 'purely instrumental', source: 'manual' });
  toggleVocalPersona(state, persona);

  const compiled = resolveConflicts(weightTokens(state.list()));
  assert.strictEqual(compiled.conflicts.length, 1, 'exactly one drop, and it is reported');
  assert.strictEqual(compiled.conflicts[0].dropped, 'purely instrumental');
  assert.strictEqual(compiled.conflicts[0].kept, persona.tags[0]);
  assert.strictEqual(compiled.conflicts[0].id, 'instrumental-vs-vocals');
  for (const tag of persona.tags) {
    assert.ok(compiled.tags.indexOf(tag) !== -1, `"${tag}" should have survived`);
  }

  /* And with the directive AHEAD of the voice — a dissection that filed it
   * early, or a genre token that says it — the naming tag goes instead. */
  const reversed = resolveConflicts(['purely instrumental'].concat(persona.tags));
  assert.strictEqual(reversed.conflicts.length, 1);
  assert.strictEqual(reversed.conflicts[0].dropped, persona.tags[0]);
  assert.ok(reversed.tags.indexOf(persona.tags[0]) === -1, 'the naming tag must go');
  // The textures are NOT dropped with it: they describe how a sound behaves and
  // can honestly belong to an instrument, so inventing a conflict for them
  // would be the resolver guessing (docs/ENGINEERING-STANDARD.md §1.1).
  for (let i = 1; i < persona.tags.length; i += 1) {
    assert.ok(reversed.tags.indexOf(persona.tags[i]) !== -1, `"${persona.tags[i]}" was over-dropped`);
  }
});

s.test('nothing in the registry conflicts with a plain, vocal-free prompt', () => {
  for (const persona of VOCAL_REGISTRY) {
    const result = resolveConflicts(['techno', 'hypnotic'].concat(persona.tags));
    deepEqual(
      result.conflicts,
      [],
      `${persona.id} invented a conflict with a neutral prompt: ${JSON.stringify(host(result.conflicts))}`
    );
  }
});

/* ========================================================================== */
/* 8. Static markup, aria, wiring and styling contracts                       */
/* ========================================================================== */

s.test('the Vocal Persona card ships with every id the boot reaches for', () => {
  const card = readVocalCardMarkup();
  for (const id of [
    'vocal-heading',
    'vocal-search',
    'vocal-count',
    'vocal-selected-empty',
    'vocal-chips',
    'vocal-empty',
    'vocal-list',
    'vocal-status',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(card), `the card is missing id="${id}"`);
  }
});

s.test('the card is a labelled region with a labelled search box and a live status', () => {
  const card = readVocalCardMarkup();
  assert.ok(
    /aria-labelledby="vocal-heading"/.test(card),
    'the card must be labelled by its own heading'
  );
  assert.ok(
    /<label class="field-label" for="vocal-search">/.test(card),
    'the search box needs a real <label for>, not a placeholder'
  );
  assert.ok(/type="search"/.test(card), 'the search box should be type="search"');
  assert.ok(
    /id="vocal-status"[^>]*role="status"[^>]*aria-live="polite"/.test(card),
    'what happened to a persona must be announced, politely'
  );
  assert.ok(
    /id="vocal-list"[^>]*class="vlist"[^>]*aria-label="Vocal personas"/.test(card),
    'the scroller must be the shared .vlist, labelled for a screen reader'
  );
  assert.ok(/id="vocal-list"[^>]*tabindex="0"/.test(card), 'the scroller must be keyboard reachable');
  assert.ok(/id="vocal-empty"[^>]*hidden/.test(card), 'the empty-search line starts hidden');
});

s.test('the card is wired to the registry, the shared scroller and the prompt store', () => {
  const source = extractScriptById(INDEX, 'app-main');
  const boot = source.slice(source.indexOf('the Vocal Persona Selector (FDD #28)'));
  assert.ok(boot, 'the boot IIFE has no Vocal Persona block');

  for (const needle of [
    'createVirtualList({',
    "label: 'Vocal personas'",
    'rowHeight: VIRTUAL_ROW_HEIGHT',
    'renderRow: buildVocalRow',
    'searchVocalRegistry(query)',
    'selectedVocalPersonas(promptState)',
    'toggleVocalPersona(promptState, persona)',
    'promptState.subscribe(renderVocalCard)',
  ]) {
    assert.ok(
      boot.indexOf(needle) !== -1,
      `the card no longer wires "${needle}" — the live list would stop tracking the draft`
    );
  }

  // The row's toggle carries its state in aria-pressed and a focus key, so the
  // styling, the accessibility tree and the virtual list's focus rescue all
  // read the same thing.
  assert.ok(/aria-pressed', added \? 'true' : 'false'/.test(boot), 'the row toggle is not a pressed toggle');
  assert.ok(/data-focus-key', 'persona-toggle'/.test(boot), 'the row toggle has no focus key');
  assert.ok(
    /keyOf: function \(persona\)/.test(boot),
    'rows need a stable key or focus cannot survive a repaint'
  );
});

s.test('the draft card knows what to call the new group', () => {
  const source = extractScriptById(INDEX, 'app-main');
  const start = source.indexOf('const SECTION_LABELS = {');
  assert.ok(start !== -1, 'SECTION_LABELS disappeared');
  const block = source.slice(start, source.indexOf('};', start));
  for (const section of PROMPT_SECTIONS) {
    assert.ok(
      new RegExp(`(^|\\s)'?${section}'?:`, 'm').test(block),
      `the draft card has no human label for the "${section}" group`
    );
  }
  assert.ok(/vocal: 'Vocals'/.test(block));
});

s.test('the card styles itself from tokens only, in both themes', () => {
  const css = readStyle();
  for (const selector of [
    '.vocal-panel {',
    '.vocal-row {',
    '.vocal-count {',
    '.vocal-chips {',
    '.btn-persona[aria-pressed="true"] {',
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
    /\.vocal-panel,[\s\S]{0,120}container-name: dissector;/.test(css) ||
      /container-name: dissector;/.test(css.slice(css.indexOf('.vocal-panel,'))),
    '.vocal-panel must join the dissector container group'
  );
  assert.ok(
    /@container dissector \(max-width: 520px\)[\s\S]*\.vocal-row \{ flex-direction: column;/.test(css),
    'a narrow card must stack the search row instead of squeezing it'
  );
});

s.test('Code Mode keeps an added persona legible once the wash is gone', () => {
  const css = readStyle();
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(
    /\.high-contrast \.btn-persona\[aria-pressed="true"\]/.test(contrast),
    'the added state is a tinted chip; Code Mode must flatten it like the others'
  );
  assert.ok(
    /\.high-contrast \.btn-persona\[aria-pressed="true"\]\s*\{[^}]*var\(--accent-cyan\)/.test(contrast),
    'flattening the wash must leave the cyan border as the pressed signal, not a neutral hairline'
  );
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
