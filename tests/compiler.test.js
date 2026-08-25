'use strict';
/*
 * tests/compiler.test.js — the style-prompt compiler pipeline that feeds the
 * 1,000-character limiter:
 *
 *   docs/FDD.md #73  Token Weighting Engine     -> weightTokens()
 *   docs/FDD.md #68  Tag Conflict Resolver      -> TAG_CONFLICTS / resolveConflicts()
 *   docs/FDD.md #30  Negative Tag Shield        -> createExclusionState() + §3.3 syntax
 *   docs/FDD.md #67  1,000-character gauge      -> promptBudgetZone() + the card's markup
 *
 * WHAT IS COVERED
 *   - the emission order, including the stable tie-break that makes two equal
 *     weights keep the order the user built them in;
 *   - the conflict rules table itself (shape, disjointness, uniqueness) and
 *     the resolution policy: the EARLIER, heavier tag always wins, the drop is
 *     always reported, and both directions of every slider opposition behave
 *     the same way;
 *   - that the resolver invents NOTHING: every group in MUSIC_KB is internally
 *     compatible, and it must stay that way;
 *   - the shield's store and the §3.3 block syntax;
 *   - determinism: the same state compiles to the same string, twice;
 *   - the static markup, CSS and subscription contracts of the two new cards.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - The ceiling itself and everything trimming is allowed to do to a string.
 *     tests/limiter-eval.js owns that contract in full.
 *   - DOM event wiring of the exclusion chips and the copy button: those need
 *     a browser. The boot IIFE is proven inert outside one, the subscription
 *     strings the live gauge depends on are asserted statically here, and
 *     every pure half is exercised behaviourally.
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

/* The release the limiter shipped in. A floor, not a pin: the version may go
 * up, but a build claiming to predate the limiter while containing it would be
 * lying about what it is. */
const LIMITER_RELEASE = [0, 10, 0];

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

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
  createPromptState,
  createExclusionState,
  sliderTags,
  weightTokens,
  resolveConflicts,
  compileStylePrompt,
  buildFinalPrompt,
  promptBudgetZone,
  normalizeExclusion,
  normalizeExclusionList,
  conflictBetween,
  normalizePromptTag,
  TAG_CONFLICTS,
  TAG_DUPLICATE_RULE,
  EXCLUSION_PRESETS,
  EXCLUSION_MAX_LEN,
  SLIDER_TAG_SETS,
  MUSIC_KB,
  PROMPT_CHAR_LIMIT,
  PROMPT_ZONE_SAFE_MAX,
  PROMPT_ZONE_WARN_MAX,
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

/** The raw stylesheet, comments intact — for asserting documented thresholds. */
function readStyleRaw() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return m[1];
}

function readEditorMarkup() {
  const html = readIndex();
  const start = html.indexOf('id="view-editor"');
  const end = html.indexOf('</main>');
  assert.ok(start !== -1 && end > start, 'could not locate the Prompt Editor view');
  return html.slice(start, end);
}

/** Cross-realm-safe deep equality (see tests/vibe-translators.test.js). */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(host(actual), host(expected), message);
}

function droppedTagsOf(result) {
  return result.conflicts.map((c) => c.dropped);
}

const s = suite('compiler (FDD #30/#67/#68/#73: weighting, conflicts, shield, gauge)');

/* -------------------------------------------------------------------------- */
/* Reachability + version                                                     */
/* -------------------------------------------------------------------------- */

s.test('every compiler entry point is a reachable top-level declaration', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined', 'the boot IIFE must stay inert');
  for (const name of [
    'weightTokens',
    'resolveConflicts',
    'conflictBetween',
    'conflictSideOf',
    'conflictSidesOf',
    'compileStylePrompt',
    'limitPrompt',
    'buildFinalPrompt',
    'promptBudgetZone',
    'splitTags',
    'cutAtWord',
    'cutTagsToBudget',
    'splitExcludeBlock',
    'shrinkExcludeBlock',
    'normalizeExclusion',
    'normalizeExclusionList',
    'createExclusionState',
  ]) {
    assert.strictEqual(fresh.evaluate(`typeof ${name}`), 'function', `${name} is not reachable`);
  }
  for (const name of [
    'TAG_CONFLICTS',
    'TAG_DUPLICATE_RULE',
    'EXCLUDE_OPEN',
    'EXCLUDE_CLOSE',
    'EXCLUDE_JOIN',
    'EXCLUSION_PRESETS',
    'EXCLUSION_MAX_LEN',
    'PROMPT_CHAR_LIMIT',
    'PROMPT_ZONE_SAFE_MAX',
    'PROMPT_ZONE_WARN_MAX',
  ]) {
    assert.ok(fresh.sandbox[name] !== undefined, `${name} must be a var binding tests can read`);
  }
});

s.test('APP_VERSION is at or past the release the limiter shipped in', () => {
  const version = app.evaluate('APP_VERSION');
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(parts, `APP_VERSION "${version}" is not semver-shaped`);
  const actual = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const ordered =
    actual[0] !== LIMITER_RELEASE[0]
      ? actual[0] > LIMITER_RELEASE[0]
      : actual[1] !== LIMITER_RELEASE[1]
        ? actual[1] > LIMITER_RELEASE[1]
        : actual[2] >= LIMITER_RELEASE[2];
  assert.ok(
    ordered,
    `APP_VERSION is ${version}, behind ${LIMITER_RELEASE.join('.')} — this build ships the ` +
      'limiter, so it cannot claim to predate it'
  );
});

/* -------------------------------------------------------------------------- */
/* A. weightTokens — FDD #73                                                  */
/* -------------------------------------------------------------------------- */

s.test('genre tokens lead, heaviest first', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'light', weight: 0.2, source: 'dissector' });
  state.add({ section: 'genre', tag: 'heavy', weight: 1, source: 'dissector' });
  state.add({ section: 'genre', tag: 'middling', weight: 0.6, source: 'dissector' });
  deepEqual(weightTokens(state.list()), ['heavy', 'middling', 'light']);
});

s.test('equal weights keep insertion order — the sort is stable by construction', () => {
  const state = createPromptState();
  for (const tag of ['zeta', 'alpha', 'mid', 'omega', 'beta']) {
    state.add({ section: 'genre', tag: tag, weight: 0.5, source: 'dissector' });
  }
  deepEqual(
    weightTokens(state.list()),
    ['zeta', 'alpha', 'mid', 'omega', 'beta'],
    'a tie must not re-sort what the user added'
  );

  // …and a tie INSIDE a mixed set only ties against its own weight.
  const mixed = createPromptState();
  mixed.add({ section: 'genre', tag: 'tie-a', weight: 0.5, source: 'dissector' });
  mixed.add({ section: 'genre', tag: 'top', weight: 0.9, source: 'dissector' });
  mixed.add({ section: 'genre', tag: 'tie-b', weight: 0.5, source: 'dissector' });
  deepEqual(weightTokens(mixed.list()), ['top', 'tie-a', 'tie-b']);
});

s.test('a weightless genre counts as zero, so a scored dissection outranks a hand-typed one', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'typed by hand', source: 'manual' });
  state.add({ section: 'genre', tag: 'scored', weight: 0.4, source: 'dissector' });
  deepEqual(weightTokens(state.list()), ['scored', 'typed by hand']);
});

s.test('after genre come mood, vocal, instrument, scene, era, custom — in section order, insertion order within', () => {
  const state = createPromptState();
  // Added in deliberately the WRONG order.
  state.add({ section: 'custom', tag: 'hand written', source: 'manual' });
  state.add({ section: 'era', tag: '1980s production', source: 'dissector' });
  state.add({ section: 'scene', tag: 'neon rain', source: 'scene' });
  state.add({ section: 'instrument', tag: 'TR-909 kick', source: 'dissector' });
  state.add({ section: 'instrument', tag: 'supersaw stack', source: 'dissector' });
  state.add({ section: 'vocal', tag: 'breathy soft vocals', weight: 0.9, source: 'vocal-persona' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });
  state.add({ section: 'genre', tag: 'techno', weight: 1, source: 'dissector' });

  /* CONSCIOUSLY UPDATED IN 0.13.0 (FDD #65 + #28): the 'vocal' section joined
   * PROMPT_SECTION_ORDER between 'mood' and 'instrument', so weightTokens()
   * emits a named voice ahead of the instrument list — see the long note on
   * PROMPT_SECTION_ORDER in index.html. Note what did NOT change: the weight
   * on the vocal tag does not move it, because only the genre bucket is ever
   * re-sorted by weight. */
  deepEqual(weightTokens(state.list()), [
    'techno',
    'hypnotic',
    'breathy soft vocals',
    'TR-909 kick',
    'supersaw stack',
    'neon rain',
    '1980s production',
    'hand written',
  ]);

  // Only the genre bucket is re-sorted: a weight on a mood must NOT move it.
  const moods = createPromptState();
  moods.add({ section: 'mood', tag: 'first', weight: 0.1, source: 'dissector' });
  moods.add({ section: 'mood', tag: 'second', weight: 0.9, source: 'dissector' });
  deepEqual(weightTokens(moods.list()), ['first', 'second']);
});

s.test('slider tags come last, energy -> warmth -> density, whatever order they moved in', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', weight: 1, source: 'dissector' });
  state.setSource('slider-density', ['dense arrangement']);
  state.setSource('slider-energy', ['high energy']);
  state.setSource('slider-warmth', ['tape hiss']);
  deepEqual(weightTokens(state.list()), [
    'techno',
    'high energy',
    'tape hiss',
    'dense arrangement',
  ]);

  // A slider-section tag from some OTHER source still reaches the prompt, last.
  state.add({ section: 'slider', tag: 'hand-tuned feel', source: 'manual' });
  deepEqual(weightTokens(state.list()), [
    'techno',
    'high energy',
    'tape hiss',
    'dense arrangement',
    'hand-tuned feel',
  ]);
});

s.test('weightTokens is defensive: junk in, nothing out — never a throw', () => {
  deepEqual(weightTokens(undefined), []);
  deepEqual(weightTokens(null), []);
  deepEqual(weightTokens('techno'), []);
  deepEqual(weightTokens(42), []);
  deepEqual(weightTokens([]), []);
  deepEqual(
    weightTokens([null, 'techno', 7, {}, { tag: '' }, { tag: '   ' }, { tag: 'kept' }]),
    ['kept'],
    'only real entries survive'
  );
  // An unknown section is filed under custom rather than being dropped.
  deepEqual(weightTokens([{ section: 'nonsense', tag: 'orphan' }]), ['orphan']);
  // A non-finite weight is not a weight.
  deepEqual(
    weightTokens([
      { section: 'genre', tag: 'nan', weight: NaN },
      { section: 'genre', tag: 'real', weight: 0.5 },
    ]),
    ['real', 'nan']
  );
  // Whitespace inside a tag is collapsed on the way out.
  deepEqual(weightTokens([{ section: 'genre', tag: '  warm   analog  ' }]), ['warm analog']);
});

/* -------------------------------------------------------------------------- */
/* B. The conflict rules table — FDD #68                                      */
/* -------------------------------------------------------------------------- */

s.test('the rules table is well formed: unique ids, two named sides, a documented reason', () => {
  assert.ok(Array.isArray(TAG_CONFLICTS), 'TAG_CONFLICTS must be an array');
  assert.ok(TAG_CONFLICTS.length >= 8, `only ${TAG_CONFLICTS.length} conflict rules declared`);

  const ids = new Set();
  for (const rule of TAG_CONFLICTS) {
    assert.ok(typeof rule.id === 'string' && rule.id, `a rule has no id: ${JSON.stringify(rule)}`);
    assert.ok(!ids.has(rule.id), `duplicate rule id "${rule.id}"`);
    ids.add(rule.id);

    assert.ok(
      typeof rule.rule === 'string' && rule.rule.length > 20,
      `${rule.id} has no human-readable reason — the UI prints it verbatim`
    );
    assert.ok(
      rule.match === 'exact' || rule.match === 'phrase',
      `${rule.id}: match must be 'exact' or 'phrase', got ${JSON.stringify(rule.match)}`
    );

    for (const side of ['a', 'b']) {
      assert.ok(Array.isArray(rule[side]) && rule[side].length, `${rule.id} has an empty side ${side}`);
      for (const member of rule[side]) {
        assert.ok(
          typeof member === 'string' && member.trim(),
          `${rule.id}.${side} holds a non-string member`
        );
      }
    }

    // The two sides must be DISJOINT, or a tag would contradict itself.
    const left = new Set(rule.a.map((m) => normalizePromptTag(m)));
    for (const member of rule.b) {
      assert.ok(
        !left.has(normalizePromptTag(member)),
        `${rule.id}: "${member}" is on both sides — that is not an opposition`
      );
    }
  }

  assert.ok(ids.has('lofi-texture-vs-clean-master'), 'the FEATURE-MECHANICS §5.1 pair must be a rule');
  for (const id of ['energy-low-vs-high', 'warmth-cold-vs-analog', 'density-sparse-vs-dense']) {
    assert.ok(ids.has(id), `the §4 slider opposition "${id}" must be a rule`);
  }
});

s.test('the three slider rules ARE the §4 sets — not a paraphrase of them', () => {
  const byId = {};
  for (const rule of TAG_CONFLICTS) byId[rule.id] = rule;
  const pairs = [
    ['energy-low-vs-high', 'energy'],
    ['warmth-cold-vs-analog', 'warmth'],
    ['density-sparse-vs-dense', 'density'],
  ];
  for (const [id, axis] of pairs) {
    deepEqual(byId[id].a, SLIDER_TAG_SETS[axis].low, `${id} side a drifted from the §4 low set`);
    deepEqual(byId[id].b, SLIDER_TAG_SETS[axis].high, `${id} side b drifted from the §4 high set`);
    assert.strictEqual(byId[id].match, 'exact', `${id} must match the closed §4 list exactly`);
  }
});

/* -------------------------------------------------------------------------- */
/* C. resolveConflicts — the resolution policy                                */
/* -------------------------------------------------------------------------- */

s.test('the FEATURE-MECHANICS §5.1 example resolves, keeping whichever came first', () => {
  const lofiFirst = resolveConflicts([
    'lo-fi cassette hiss',
    'modern hyper-clean radio master',
    'techno',
  ]);
  deepEqual(lofiFirst.tags, ['lo-fi cassette hiss', 'techno']);
  deepEqual(lofiFirst.conflicts, [
    {
      kept: 'lo-fi cassette hiss',
      dropped: 'modern hyper-clean radio master',
      rule: 'lo-fi tape and vinyl texture cannot survive a modern hyper-clean radio master',
      id: 'lofi-texture-vs-clean-master',
    },
  ]);

  // Reversed: the policy is positional, so the OTHER one now survives.
  const cleanFirst = resolveConflicts([
    'modern hyper-clean radio master',
    'lo-fi cassette hiss',
    'techno',
  ]);
  deepEqual(cleanFirst.tags, ['modern hyper-clean radio master', 'techno']);
  deepEqual(droppedTagsOf(cleanFirst), ['lo-fi cassette hiss']);
});

s.test('every slider opposition resolves in BOTH directions, and the earlier set wins whole', () => {
  for (const axis of ['energy', 'warmth', 'density']) {
    const low = sliderTags(axis, 0);
    const high = sliderTags(axis, 100);

    const lowFirst = resolveConflicts(low.concat(high));
    deepEqual(lowFirst.tags, low, `${axis}: the low set must survive whole when it came first`);
    deepEqual(droppedTagsOf(lowFirst), high, `${axis}: every high tag must be reported`);

    const highFirst = resolveConflicts(high.concat(low));
    deepEqual(highFirst.tags, high, `${axis}: the high set must survive whole when it came first`);
    deepEqual(droppedTagsOf(highFirst), low, `${axis}: every low tag must be reported`);

    // Every report names a real rule and the tag it lost to.
    for (const conflict of lowFirst.conflicts) {
      assert.ok(low.indexOf(conflict.kept) !== -1, `${axis}: kept "${conflict.kept}" is not a low tag`);
      assert.ok(conflict.rule && conflict.rule.length > 20, `${axis}: no reason given`);
      assert.notStrictEqual(conflict.id, 'duplicate');
    }
  }
});

s.test('the report names kept, dropped and the reason — never a bare count', () => {
  const result = resolveConflicts(['tape hiss', 'clinical mix']);
  assert.strictEqual(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  deepEqual(Object.keys(conflict).sort(), ['dropped', 'id', 'kept', 'rule']);
  assert.strictEqual(conflict.kept, 'tape hiss');
  assert.strictEqual(conflict.dropped, 'clinical mix');
  assert.strictEqual(typeof conflict.rule, 'string');

  // Nothing that was dropped may still be in the surviving list.
  for (const dropped of droppedTagsOf(result)) {
    assert.strictEqual(result.tags.indexOf(dropped), -1, `"${dropped}" was reported AND kept`);
  }
});

s.test('an exact repeat is dropped as redundancy, with its own rule, not as a contradiction', () => {
  const result = resolveConflicts(['techno', 'Techno', '  TECHNO  ', 'house']);
  deepEqual(result.tags, ['techno', 'house']);
  assert.strictEqual(result.conflicts.length, 2);
  for (const conflict of result.conflicts) {
    assert.strictEqual(conflict.id, 'duplicate');
    assert.strictEqual(conflict.rule, TAG_DUPLICATE_RULE);
    assert.strictEqual(conflict.kept, 'techno');
  }
});

s.test('the resolver invents nothing: every group in MUSIC_KB is internally compatible', () => {
  // A genre, a scene or an era describing itself must never be read as
  // self-contradictory — that is the false-positive failure mode, and it would
  // silently delete half of a one-click "Add all".
  let checked = 0;
  for (const genre of MUSIC_KB.genres) {
    for (const list of [genre.tokens.map((t) => t.tag), genre.instruments, genre.moods]) {
      const result = resolveConflicts(list);
      deepEqual(result.conflicts, [], `${genre.id} contradicts itself: ${JSON.stringify(host(result.conflicts))}`);
      checked += 1;
    }
  }
  for (const scene of MUSIC_KB.scenes) {
    const result = resolveConflicts(scene.tokens.map((t) => t.tag));
    deepEqual(result.conflicts, [], `scene ${scene.id} contradicts itself`);
    checked += 1;
  }
  for (const era of MUSIC_KB.eras) {
    const result = resolveConflicts(era.tokens.map((t) => t.tag));
    deepEqual(result.conflicts, [], `era ${era.id} contradicts itself`);
    checked += 1;
  }
  assert.ok(checked > 60, `only ${checked} groups checked — the KB got smaller`);
});

s.test('compatible tags that merely share a word are left alone', () => {
  // "acoustic" inside "natural room acoustics" is not the word "acoustic", so
  // the acoustic-vs-synthetic rule must not fire on it; "crackling fireplace"
  // is not "vinyl crackle"; and a driving rhythm on an acoustic guitar is a
  // perfectly ordinary request rather than a contradiction.
  //
  // (The pair "natural room acoustics" + "digital synthesis" IS a real
  // conflict — both are verbatim members of the opposing §4.2 Warmth sets —
  // and is covered by the slider-opposition test above.)
  for (const list of [
    ['natural room acoustics', 'fully synthesised textures'],
    ['crackling fireplace texture', 'glossy digital mix'],
    ['warm acoustic guitar', 'driving rhythm'],
    ['techno', 'hypnotic', 'TR-909 kick', 'neon rain', '1980s production'],
    ['soulful lead vocal', 'layered vocal harmonies', 'gospel style vocal'],
  ]) {
    const result = resolveConflicts(list);
    deepEqual(result.conflicts, [], `false positive on ${list.join(' + ')}`);
    deepEqual(result.tags, list);
  }
});

s.test('a tag matching BOTH sides of a rule is ambiguous evidence and drops nobody', () => {
  // "lo-fi hyper-clean" is on both sides of the §5.1 rule at once. It must not
  // be used to convict either of its neighbours.
  const result = resolveConflicts(['lo-fi hyper-clean master', 'tape hiss', 'clinical mix']);
  assert.strictEqual(result.tags[0], 'lo-fi hyper-clean master');
  assert.strictEqual(
    conflictBetween('lo-fi hyper-clean master', 'tape hiss'),
    null,
    'an ambiguous tag must not convict anything'
  );
  // The other two still contradict each other on their own account.
  deepEqual(droppedTagsOf(result), ['clinical mix']);
});

s.test('resolveConflicts is defensive and order-preserving', () => {
  deepEqual(resolveConflicts(undefined).tags, []);
  deepEqual(resolveConflicts('techno').tags, []);
  deepEqual(resolveConflicts([null, 7, {}, { tag: 'kept' }, 'also kept', { tag: '  ' }]).tags, [
    'kept',
    'also kept',
  ]);
  // Compatible input comes back untouched, in the order it arrived.
  const list = ['zeta', 'alpha', 'mid'];
  deepEqual(resolveConflicts(list).tags, list);
});

/* -------------------------------------------------------------------------- */
/* D. The Negative Tag Shield — FDD #30, FEATURE-MECHANICS.md §3.3            */
/* -------------------------------------------------------------------------- */

s.test('the curated preset list is real, unique and within the term length cap', () => {
  assert.ok(EXCLUSION_PRESETS.length >= 8, `only ${EXCLUSION_PRESETS.length} presets offered`);
  const seen = new Set();
  for (const term of EXCLUSION_PRESETS) {
    assert.strictEqual(normalizeExclusion(term), term, `"${term}" is not already canonical`);
    assert.ok(term.length <= EXCLUSION_MAX_LEN, `"${term}" is over the ${EXCLUSION_MAX_LEN}-char cap`);
    assert.ok(!seen.has(term), `the preset row repeats "${term}"`);
    seen.add(term);
  }
  for (const required of ['harsh noise', 'male vocals', 'acoustic guitars']) {
    assert.ok(seen.has(required), `FEATURE-MECHANICS §3.3's own example term "${required}" is missing`);
  }
});

s.test('normalizeExclusion refuses the unusable and neuters what would break the block', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, ',', '[]', ' , , ']) {
    assert.strictEqual(normalizeExclusion(bad), '', `${JSON.stringify(bad)} must normalise to ''`);
  }
  // A comma or a bracket typed inside a term would split or close the block.
  assert.strictEqual(normalizeExclusion('harsh noise, male vocals'), 'harsh noise male vocals');
  assert.strictEqual(normalizeExclusion('[Exclude: autotune]'), 'Exclude: autotune');
  assert.strictEqual(normalizeExclusion('  spoken    word  '), 'spoken word');
  // The length cap is applied, and the result never ends mid-space.
  const long = normalizeExclusion('x'.repeat(80));
  assert.strictEqual(long.length, EXCLUSION_MAX_LEN);
});

s.test('normalizeExclusionList de-duplicates case-insensitively and keeps toggle order', () => {
  deepEqual(normalizeExclusionList(['Autotune', 'autotune', '  AUTOTUNE  ', 'spoken word']), [
    'Autotune',
    'spoken word',
  ]);
  deepEqual(normalizeExclusionList(['', null, 'kept', 7, '   ']), ['kept']);
  deepEqual(normalizeExclusionList(undefined), []);
  deepEqual(normalizeExclusionList('autotune'), []);
});

s.test('the shield store adds, refuses repeats, removes and toggles', () => {
  const shield = createExclusionState();
  assert.strictEqual(shield.count(), 0);
  deepEqual(shield.list(), []);

  assert.strictEqual(shield.add('harsh noise'), 'harsh noise');
  assert.strictEqual(shield.add('HARSH NOISE'), null, 'a repeat must be refused');
  assert.strictEqual(shield.add('   '), null);
  assert.strictEqual(shield.count(), 1);
  assert.strictEqual(shield.has('harsh noise'), true);
  assert.strictEqual(shield.has('Harsh Noise'), true);
  assert.strictEqual(shield.has('autotune'), false);

  assert.strictEqual(shield.toggle('autotune'), true, 'toggle must report the state AFTER');
  assert.strictEqual(shield.toggle('autotune'), false);
  assert.strictEqual(shield.count(), 1);

  assert.strictEqual(shield.remove('nothing here'), false);
  assert.strictEqual(shield.remove('HARSH noise'), true);
  assert.strictEqual(shield.count(), 0);

  // list() hands back a copy.
  shield.add('spoken word');
  const view = shield.list();
  view.push('smuggled');
  deepEqual(shield.list(), ['spoken word']);

  assert.strictEqual(shield.clear(), 1);
  assert.strictEqual(shield.clear(), 0, 'an empty shield clears nothing');
});

s.test('the shield publishes once per real change, and a broken subscriber breaks nothing', () => {
  const shield = createExclusionState();
  const seen = [];
  const order = [];
  shield.subscribe((terms) => seen.push(terms.slice()));
  shield.subscribe(() => {
    order.push('boom');
    throw new Error('subscriber exploded');
  });
  shield.subscribe(() => order.push('last'));

  shield.add('harsh noise');
  shield.add('harsh noise'); // refused: no change, no notification
  shield.remove('not held'); // no change
  shield.toggle('autotune');
  shield.remove('autotune');

  assert.strictEqual(seen.length, 3, `expected 3 notifications, got ${seen.length}`);
  deepEqual(seen[0], ['harsh noise']);
  deepEqual(seen[2], ['harsh noise']);
  deepEqual(order, ['boom', 'last', 'boom', 'last', 'boom', 'last']);

  const off = shield.subscribe(() => seen.push(['extra']));
  off();
  off();
  shield.add('spoken word');
  assert.strictEqual(seen.length, 4, 'an unsubscribed listener must not be called again');
  assert.strictEqual(typeof shield.subscribe('not a function'), 'function');
});

s.test('compileStylePrompt writes the §3.3 block exactly, and only when there is one', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', weight: 1, source: 'dissector' });

  const withShield = compileStylePrompt(state, ['harsh noise', 'male vocals', 'acoustic guitars']);
  assert.strictEqual(
    withShield.text,
    'techno [Exclude: harsh noise, male vocals, acoustic guitars]',
    'FEATURE-MECHANICS §3.3: ONE bracketed block, at the very end'
  );
  deepEqual(withShield.meta.exclusions, ['harsh noise', 'male vocals', 'acoustic guitars']);

  // The list is normalised on the way in, and duplicates collapse.
  const messy = compileStylePrompt(state, ['  Harsh   Noise ', 'harsh noise', 'auto,tune']);
  assert.strictEqual(messy.text, 'techno [Exclude: Harsh Noise, auto tune]');

  // Exclusions with nothing to describe: the block stands alone rather than
  // being introduced by an orphaned separator.
  const alone = compileStylePrompt(createPromptState(), ['harsh noise']);
  assert.strictEqual(alone.text, '[Exclude: harsh noise]');

  // Neither, and the result is empty rather than a stray bracket pair.
  assert.strictEqual(compileStylePrompt(createPromptState(), []).text, '');
});

/* -------------------------------------------------------------------------- */
/* E. The pipeline as a whole                                                 */
/* -------------------------------------------------------------------------- */

s.test('compileStylePrompt takes a live store or a plain entry array, identically', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', weight: 1, source: 'dissector' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });

  const fromStore = compileStylePrompt(state, ['autotune']);
  const fromArray = compileStylePrompt(state.list(), ['autotune']);
  assert.strictEqual(fromArray.text, fromStore.text);
  deepEqual(fromArray.meta.tags, fromStore.meta.tags);

  // And anything else is an empty prompt, not an exception.
  for (const junk of [undefined, null, 'techno', 42]) {
    assert.strictEqual(compileStylePrompt(junk, []).text, '');
  }
});

s.test('the pipeline is deterministic: the same state compiles to the same string, twice', () => {
  const build = () => {
    const state = createPromptState();
    state.batch(function () {
      for (const genre of MUSIC_KB.genres) {
        for (const token of genre.tokens) {
          state.add({ section: 'genre', tag: token.tag, weight: token.weight, source: 'dissector' });
        }
      }
      for (const scene of MUSIC_KB.scenes) {
        for (const token of scene.tokens) {
          state.add({ section: 'scene', tag: token.tag, weight: token.weight, source: 'scene' });
        }
      }
      state.setSource('slider-energy', sliderTags('energy', 95));
      state.setSource('slider-warmth', sliderTags('warmth', 5));
    });
    return state;
  };

  const first = buildFinalPrompt(build(), ['harsh noise', 'autotune']);
  const second = buildFinalPrompt(build(), ['harsh noise', 'autotune']);
  assert.strictEqual(first.text, second.text, 'two identical states compiled differently');
  assert.strictEqual(first.length, second.length);
  deepEqual(first.droppedTags, second.droppedTags);
  deepEqual(first.conflicts, second.conflicts);

  // The same store compiled twice in a row must not drift either.
  const once = build();
  assert.strictEqual(buildFinalPrompt(once, []).text, buildFinalPrompt(once, []).text);
});

s.test('buildFinalPrompt reports the whole truth: length, zone, trims, drops and conflicts', () => {
  const state = createPromptState();
  state.batch(function () {
    state.add({ section: 'genre', tag: 'lo-fi cassette hiss', weight: 1, source: 'dissector' });
    state.add({ section: 'genre', tag: 'modern hyper-clean radio master', weight: 0.5, source: 'dissector' });
  });

  const final = buildFinalPrompt(state, ['harsh noise']);
  /* CONSCIOUSLY UPDATED IN 0.21.0: 'modelId' and 'excludeOmitted' joined the
   * result for FDD #69. The pin exists to catch the shape growing by accident;
   * this growth is deliberate and is what keeps the model-scoped omission of
   * the [Exclude: …] block REPORTED rather than silent, which is the same
   * "nothing is ever dropped quietly" rule droppedTags already serves.
   * tests/model-deeplink.test.js asserts what both fields mean. */
  deepEqual(Object.keys(final).sort(), [
    'conflicts',
    'droppedExclusions',
    'droppedTags',
    'excludeOmitted',
    'exclusions',
    'length',
    'limit',
    'modelId',
    'tags',
    'text',
    'trimmed',
    'zone',
  ]);
  assert.strictEqual(final.modelId, 'v5-5', 'no options means the default model, as it always did');
  assert.strictEqual(final.excludeOmitted, false, 'v5.5 writes the shield, so nothing was omitted');
  assert.strictEqual(final.limit, PROMPT_CHAR_LIMIT);
  assert.strictEqual(final.length, final.text.length, 'the reported length IS the string length');
  assert.strictEqual(final.trimmed, false);
  assert.strictEqual(final.zone, 'safe');
  assert.strictEqual(final.text, 'lo-fi cassette hiss [Exclude: harsh noise]');
  assert.strictEqual(final.conflicts.length, 1, 'the conflict must reach the caller');
  assert.strictEqual(final.conflicts[0].dropped, 'modern hyper-clean radio master');

  // A caller-supplied ceiling is honoured — that is what makes it testable.
  const tight = buildFinalPrompt(state, ['harsh noise'], { max: 30 });
  assert.ok(tight.length <= 30, `${tight.length} > 30`);
  assert.strictEqual(tight.limit, 30);
  assert.strictEqual(tight.trimmed, true);
});

/* -------------------------------------------------------------------------- */
/* F. The gauge's zones — FDD #67                                             */
/* -------------------------------------------------------------------------- */

s.test('the safety zones are 0-850 / 851-950 / 951+, from both sides of every threshold', () => {
  assert.strictEqual(PROMPT_ZONE_SAFE_MAX, 850);
  assert.strictEqual(PROMPT_ZONE_WARN_MAX, 950);
  assert.strictEqual(PROMPT_CHAR_LIMIT, 1000);

  assert.strictEqual(promptBudgetZone(0), 'safe');
  assert.strictEqual(promptBudgetZone(849), 'safe');
  assert.strictEqual(promptBudgetZone(850), 'safe', '850 is the inclusive top of the safe band');
  assert.strictEqual(promptBudgetZone(851), 'warn');
  assert.strictEqual(promptBudgetZone(950), 'warn', '950 is the inclusive top of the warning band');
  assert.strictEqual(promptBudgetZone(951), 'danger');
  assert.strictEqual(promptBudgetZone(1000), 'danger');

  // Anything past the ceiling in force is danger, whatever the ceiling is.
  assert.strictEqual(promptBudgetZone(31, 30), 'danger');
  // And an unreadable length parks at the bottom rather than crying wolf.
  assert.strictEqual(promptBudgetZone(NaN), 'safe');
  assert.strictEqual(promptBudgetZone(undefined), 'safe');
});

/* -------------------------------------------------------------------------- */
/* G. Static markup, CSS and wiring contracts                                 */
/* -------------------------------------------------------------------------- */

s.test('the Exclusions card and the Style prompt card live in the Editor view', () => {
  const editor = readEditorMarkup();
  for (const id of [
    'exclude-presets',
    'exclude-input',
    'btn-exclude-add',
    'exclude-chips',
    'exclude-empty',
    'exclude-status',
    'style-count',
    'style-meter',
    'style-meter-fill',
    'style-zone-note',
    'style-empty',
    'style-text',
    'style-trimmed',
    'style-conflicts',
    'style-tally',
    'btn-style-copy',
  ]) {
    assert.ok(editor.indexOf(`id="${id}"`) !== -1, `#${id} must live inside the Prompt Editor view`);
  }

  for (const [id, text] of [
    ['exclude-heading', 'Exclusions'],
    ['style-heading', 'Style prompt'],
  ]) {
    assert.ok(new RegExp(`aria-labelledby="${id}"`).test(editor), `no section is labelled by #${id}`);
    assert.ok(new RegExp(`id="${id}"[^>]*>\\s*${text}`).test(editor), `#${id} must read "${text}"`);
  }

  // Reading order: the ingredients, then what to exclude, then the compiled
  // field that is actually pasted into Suno.
  const draft = editor.indexOf('id="draft-heading"');
  const shield = editor.indexOf('id="exclude-heading"');
  const style = editor.indexOf('id="style-heading"');
  assert.ok(draft < shield && shield < style, 'the compiled prompt must come after its ingredients');

  // The free-text field is labelled and capped in the markup as well as in JS.
  assert.ok(/<label class="field-label" for="exclude-input">/.test(editor), '#exclude-input has no label');
  assert.ok(/id="exclude-input"[^>]*maxlength="40"/.test(editor), '#exclude-input has no length cap');
  assert.ok(/id="exclude-presets"[^>]*role="group"/.test(editor), 'the preset row must be a group');
  assert.ok(
    /id="exclude-empty"[\s\S]{0,160}Nothing excluded yet/.test(editor),
    'the shield must state its empty case plainly'
  );
  assert.ok(
    /id="style-empty"[\s\S]{0,160}Nothing compiled yet/.test(editor),
    'the style card must state its empty case plainly'
  );
});

s.test('the gauge announces its ZONE, not its every character', () => {
  const editor = readEditorMarkup();

  // The live region is the zone note.
  assert.ok(/id="style-zone-note"[^>]*role="status"/.test(editor), '#style-zone-note is not a status');
  assert.ok(/id="style-zone-note"[^>]*aria-live="polite"/.test(editor));

  // The count is NOT: it changes on every keystroke and every slider pixel.
  const count = /<span id="style-count"[^>]*>/.exec(editor);
  assert.ok(count, '#style-count is missing');
  assert.ok(!/aria-live|role="status"/.test(count[0]), `#style-count must not be a live region: ${count[0]}`);

  // The bar itself carries a text alternative, since a bar alone says nothing.
  assert.ok(/id="style-meter"[^>]*role="img"/.test(editor), '#style-meter needs a role');
  assert.ok(/id="style-meter"[\s\S]{0,160}aria-label="Character budget: 0 of 1000/.test(editor));
  assert.ok(/id="style-count" class="style-count">0 \/ 1000</.test(editor), 'the gauge must read "N / 1000"');
});

s.test('the zone thresholds are declared once and documented where they are painted', () => {
  const css = readStyle();
  const raw = readStyleRaw();

  for (const selector of ['.style-meter.is-warn', '.style-meter.is-danger', '.style-count.is-warn', '.style-count.is-danger']) {
    assert.ok(css.indexOf(selector) !== -1, `the stylesheet has no ${selector} rule`);
  }
  assert.ok(
    /\.style-meter\.is-warn[^{]*\{[^}]*var\(--warning-amber\)/.test(css),
    'the warning zone must paint with --warning-amber'
  );
  assert.ok(
    /\.style-meter\.is-danger[^{]*\{[^}]*var\(--danger-crimson\)/.test(css),
    'the danger zone must paint with --danger-crimson'
  );
  assert.ok(
    /\.style-meter-fill\s*\{[^}]*background:\s*var\(--accent-cyan\)/.test(css),
    'the safe zone must paint with --accent-cyan'
  );

  // The numbers are documented in the stylesheet next to the rules they drive,
  // and they are the SAME numbers the script enforces.
  const table = /0\s*\.\.\s*850[\s\S]{0,200}?951/.exec(raw);
  assert.ok(table, 'the stylesheet must document the 850 / 950 zone boundaries beside the rules');
  assert.ok(/PROMPT_ZONE_SAFE_MAX/.test(raw), 'the CSS comment must name the constants it mirrors');

  const script = extractScriptById(INDEX, 'app-main');
  assert.ok(/var PROMPT_ZONE_SAFE_MAX = 850;/.test(script), 'PROMPT_ZONE_SAFE_MAX must be 850 in source');
  assert.ok(/var PROMPT_ZONE_WARN_MAX = 950;/.test(script), 'PROMPT_ZONE_WARN_MAX must be 950 in source');
  assert.ok(/var PROMPT_CHAR_LIMIT = 1000;/.test(script), 'the ceiling must be 1000 in source');
});

s.test('the gauge is a SUBSCRIBER of both stores — it can never show a stale count', () => {
  const html = readIndex();
  for (const wiring of [
    'promptState.subscribe(renderStylePrompt)',
    'exclusions.subscribe(renderStylePrompt)',
    'exclusions.subscribe(renderExclusions)',
  ]) {
    assert.ok(html.indexOf(wiring) !== -1, `the wiring "${wiring}" is missing`);
  }

  // The compiled string comes from the real pipeline over the real stores,
  // recomputed — never from a cached number (ENGINEERING-STANDARD.md §1.2).
  /* CONSCIOUSLY UPDATED IN 0.21.0: the call now carries the FDD #69 model
   * options. The contract is stronger than before, not weaker — the ceiling
   * and the exclusion block are model-scoped, so a call site that compiled
   * without them would show a gauge for a model the user has not selected. */
  assert.ok(
    /buildFinalPrompt\(promptState, exclusions\.list\(\), activeModelOptions\(\)\)/.test(html),
    'the panel must compile from live state, for the selected model'
  );
  // Both call sites — the render and the copy — must agree about the model.
  assert.strictEqual(
    (html.match(/buildFinalPrompt\(promptState, exclusions\.list\(\)/g) || []).length,
    (html.match(/buildFinalPrompt\(promptState, exclusions\.list\(\), activeModelOptions\(\)\)/g) || [])
      .length,
    'a buildFinalPrompt call over the live stores must never omit the model options'
  );
  assert.ok(
    /styleCount\.textContent = final\.length \+ ' \/ ' \+ final\.limit;/.test(html),
    'the displayed count must be the real compiled length'
  );
  // The three sliders and the draft chips write into that same store.
  assert.ok(html.indexOf('promptState.setSource(source, tags)') !== -1, 'sliders must write to the store');
});

s.test('the two new cards are token-only: no colour literal escaped into their CSS', () => {
  const css = readStyle();
  for (const selector of [
    '.exclude-chip[aria-pressed="true"] {',
    '.style-count {',
    '.style-meter {',
    '.style-meter-fill {',
    '.style-zone-note {',
    '.style-trimmed {',
    '.style-conflicts {',
  ]) {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `the stylesheet is missing a rule for ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(body),
      `${selector} hard-codes a colour, which no theme or Code Mode can reach:\n${body}`
    );
  }
});

s.test('Code Mode flattens the gauge track and keeps the shield’s pressed state visible', () => {
  const css = readStyle();
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(
    /\.high-contrast \.style-meter/.test(contrast),
    'the gauge track is a translucent wash; Code Mode must flatten it like the confidence meter'
  );
  assert.ok(
    /\.high-contrast \.exclude-chip\[aria-pressed="true"\]/.test(contrast),
    'a toggled exclusion is a tinted chip; Code Mode must flatten it'
  );
  assert.ok(
    /\.high-contrast \.exclude-chip\[aria-pressed="true"\]\s*\{[^}]*var\(--danger-crimson\)/.test(contrast),
    'flattening the wash must leave the crimson border as the pressed signal, not a neutral hairline'
  );
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.style-meter-fill\s*\{\s*transition:\s*none/.test(css),
    'the gauge animates its width; reduced motion must switch that off'
  );
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
