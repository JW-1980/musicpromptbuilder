'use strict';
/*
 * tests/vibe-translators.test.js — the Layman Vibe Translators
 * (docs/FDD.md Domain C: #22 Cinematic Scene Generator, #23 Tri-Axis Physical
 * Sliders, #24 Artist Style Dissector in Safe-Mode) and the shared prompt
 * state all three write into.
 *
 * WHAT IS COVERED
 *   - sliderTags against a SECOND, INDEPENDENTLY TYPED copy of the tag lists
 *     in docs/FEATURE-MECHANICS.md §4. The point of writing them out again
 *     here rather than importing the app's own constant is that a typo in
 *     index.html then fails a test instead of quietly redefining the spec.
 *     Both the 30 and the 70 boundary are pinned from either side.
 *   - createPromptState: dedupe, removal, per-section clearing, the ATOMIC
 *     per-source slider swap (5 tags out, 5 tags in, never 10), subscriber
 *     exception isolation, deterministic draftText ordering and counts.
 *   - matchScenes: real KB phrases in, real production tokens out; every
 *     scene in the knowledge base round-trips; unmatched text yields NOTHING
 *     rather than an invented guess.
 *   - sanitizeSafeMode: an artist name typed into the box can never reach the
 *     prompt, while the taxonomy's own vocabulary survives being typed next
 *     to it.
 *   - The static markup/CSS contracts of the three new cards and the draft
 *     panel: ids, labelled controls, aria-valuetext, and the token policy.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - DOM rendering and event wiring of the new cards: chip clicks, the copy
 *     button's clipboard/execCommand fallback, and the Physical-feel group's
 *     Clear (which returns the handles to neutral rather than dropping tags
 *     the handles would immediately re-add). Those need a browser; they are
 *     verified by hand against a served localhost build, the boot IIFE is
 *     proven to stay inert outside one, and every pure half is exercised here.
 *   - Any character-budget behaviour. counts() deliberately still reports a
 *     length and stops: the budget belongs to the compiler pipeline, and
 *     tests/limiter-eval.js (the ceiling) and tests/compiler.test.js (the
 *     weighting, the conflict rules and the shield) own that contract.
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
  createPromptState,
  sliderTags,
  sliderZone,
  sliderZoneLabel,
  sliderValueText,
  matchScenes,
  sceneTriggerList,
  sanitizeSafeMode,
  safeModeNameCandidates,
  dissectLocal,
  MUSIC_KB,
  PROMPT_SECTIONS,
  PROMPT_SECTION_ORDER,
  PROMPT_SLIDER_SOURCES,
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

/** The markup of the Prompt Editor view only. */
function readEditorMarkup() {
  const html = readIndex();
  const start = html.indexOf('id="view-editor"');
  const end = html.indexOf('</main>');
  assert.ok(start !== -1 && end > start, 'could not locate the Prompt Editor view');
  return html.slice(start, end);
}

function tagsOf(result) {
  return result.genre_tokens.map((t) => t.tag);
}

/*
 * Values built inside the vm carry THAT realm's %Object.prototype% /
 * %Array.prototype%, so deepStrictEqual against a literal written here fails
 * on prototype identity even when every value matches. Round-tripping through
 * JSON rebuilds them with this realm's intrinsics — and asserts in passing
 * that everything the store hands out is plain, serialisable data.
 */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(host(actual), host(expected), message);
}

/* -------------------------------------------------------------------------- */
/* The §4 tag lists, typed out again from docs/FEATURE-MECHANICS.md            */
/* -------------------------------------------------------------------------- */

/*
 * Transcribed by hand from FEATURE-MECHANICS.md §4.1-§4.3. This is a SECOND
 * source of truth on purpose: comparing index.html against itself would prove
 * nothing about whether it matches the spec.
 */
const SPEC_ENERGY_LOW = ['low energy', 'slow-tempo', 'restrained', 'acoustic', 'soft dynamics'];
const SPEC_ENERGY_HIGH = [
  'high energy',
  'driving rhythm',
  'explosive',
  'heavy compression',
  'loud dynamics',
];
const SPEC_WARMTH_LOW = [
  'cold digital master',
  'clinical mix',
  'sterile',
  'digital synthesis',
  'wide stereo',
  'hyper-clean',
];
const SPEC_WARMTH_HIGH = [
  'warm analog saturation',
  'vintage tube preamp',
  'tape hiss',
  'vinyl crackle',
  'natural room acoustics',
];
const SPEC_DENSITY_LOW = [
  'minimalist arrangement',
  'sparse instrumentation',
  'intimate',
  'stripped down',
  'raw',
];
const SPEC_DENSITY_HIGH = [
  'wall of sound',
  'dense arrangement',
  'massive orchestration',
  'heavily layered',
  'complex production',
];

const SPEC = {
  energy: { low: SPEC_ENERGY_LOW, high: SPEC_ENERGY_HIGH },
  warmth: { low: SPEC_WARMTH_LOW, high: SPEC_WARMTH_HIGH },
  density: { low: SPEC_DENSITY_LOW, high: SPEC_DENSITY_HIGH },
};

const s = suite('vibe translators (FDD Domain C: scenes, sliders, safe mode)');

/* -------------------------------------------------------------------------- */
/* Reachability                                                               */
/* -------------------------------------------------------------------------- */

s.test('#app-main evaluates with no DOM and the boot IIFE stays inert', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined');
  assert.strictEqual(fresh.evaluate('typeof createPromptState'), 'function');
});

s.test('every Domain C factory is a reachable top-level function declaration', () => {
  for (const name of [
    'createPromptState',
    'normalizePromptTag',
    'sliderValueOrNull',
    'sliderZone',
    'sliderTags',
    'sliderZoneLabel',
    'sliderValueText',
    'matchScenes',
    'sceneTriggerList',
    'sanitizeSafeMode',
    'safeModeNameCandidates',
    'safeModeVocabulary',
  ]) {
    assert.strictEqual(
      app.evaluate(`typeof ${name}`),
      'function',
      `${name} is not reachable as a top-level function declaration`
    );
  }
  for (const name of [
    'PROMPT_SECTIONS',
    'PROMPT_SECTION_ORDER',
    'PROMPT_SLIDER_SECTION',
    'PROMPT_SLIDER_SOURCES',
    'PROMPT_SOURCES',
    'SLIDER_AXES',
    'SLIDER_TAG_SETS',
    'SLIDER_DEFAULT',
  ]) {
    assert.ok(app.sandbox[name] !== undefined, `${name} must be a var binding tests can read`);
  }
});

/* -------------------------------------------------------------------------- */
/* B. sliderTags — FEATURE-MECHANICS.md §4, verbatim                          */
/* -------------------------------------------------------------------------- */

s.test('every §4 tag set is reproduced EXACTLY, element for element', () => {
  deepEqual(sliderTags('energy', 0), SPEC_ENERGY_LOW, 'energy low set');
  deepEqual(sliderTags('energy', 100), SPEC_ENERGY_HIGH, 'energy high set');
  deepEqual(sliderTags('warmth', 0), SPEC_WARMTH_LOW, 'warmth cold set');
  deepEqual(sliderTags('warmth', 100), SPEC_WARMTH_HIGH, 'warmth analog set');
  deepEqual(sliderTags('density', 0), SPEC_DENSITY_LOW, 'density sparse set');
  deepEqual(sliderTags('density', 100), SPEC_DENSITY_HIGH, 'density wall-of-sound set');

  // §4.2 gives warmth SIX cold tags where every other set has five; a silent
  // truncation to five would still "look right" without this.
  assert.strictEqual(sliderTags('warmth', 0).length, 6, 'the cold set has six tags in §4.2');
});

s.test('the 30 and 70 boundaries are inclusive-neutral on all three axes', () => {
  for (const axis of ['energy', 'warmth', 'density']) {
    deepEqual(sliderTags(axis, 29), SPEC[axis].low, `${axis} 29 must be in the low zone`);
    deepEqual(sliderTags(axis, 30), [], `${axis} 30 is inside the neutral band (30 <= v <= 70)`);
    deepEqual(sliderTags(axis, 50), [], `${axis} 50 must inject nothing`);
    deepEqual(sliderTags(axis, 70), [], `${axis} 70 is inside the neutral band (30 <= v <= 70)`);
    deepEqual(sliderTags(axis, 71), SPEC[axis].high, `${axis} 71 must be in the high zone`);
  }
});

s.test('29.9 and 70.1 are still extremes — the band is a comparison, not a rounding', () => {
  deepEqual(sliderTags('energy', 29.9), SPEC_ENERGY_LOW);
  deepEqual(sliderTags('energy', 70.1), SPEC_ENERGY_HIGH);
  deepEqual(sliderTags('energy', 30.1), []);
  deepEqual(sliderTags('energy', 69.9), []);
});

s.test('an unknown axis returns [] rather than throwing', () => {
  // Chosen over throwing: sliderTags runs on every `input` event, and the rest
  // of this file answers a bad argument with emptiness, not an exception.
  deepEqual(sliderTags('weirdness', 0), []);
  deepEqual(sliderTags('', 100), []);
  deepEqual(sliderTags(null, 100), []);
  deepEqual(sliderTags(undefined, 0), []);
  // Prototype keys are not axes either.
  deepEqual(sliderTags('constructor', 0), []);
  deepEqual(sliderTags('toString', 100), []);
  assert.strictEqual(sliderZone('weirdness', 0), null, 'an unknown axis has no zone');
  assert.strictEqual(sliderZoneLabel('weirdness', 0), '');
  assert.strictEqual(sliderValueText('weirdness', 0), '');
});

s.test('an unreadable value parks the slider at neutral instead of an extreme', () => {
  // Number(null) is 0, which would be "hard left" and five uninvited tags.
  for (const value of [NaN, Infinity, -Infinity, 'abc', '', '   ', null, undefined, true, {}]) {
    deepEqual(sliderTags('energy', value), [], `value ${String(value)} must inject nothing`);
    assert.strictEqual(sliderZone('energy', value), 'neutral');
  }
  // A numeric STRING is a real position — that is what input.value hands over.
  deepEqual(sliderTags('energy', '5'), SPEC_ENERGY_LOW);
  deepEqual(sliderTags('energy', '95'), SPEC_ENERGY_HIGH);
  deepEqual(sliderTags('energy', '50'), []);
});

s.test('the returned array is a copy — a caller cannot edit the spec', () => {
  const first = sliderTags('density', 100);
  first.push('mutated');
  first[0] = 'clobbered';
  deepEqual(sliderTags('density', 100), SPEC_DENSITY_HIGH, 'the constant leaked out by reference');
});

s.test('aria-valuetext names the position, the zone and the exact injected words', () => {
  const low = sliderValueText('energy', 12);
  assert.ok(low.indexOf('12 of 100') === 0, `value text must lead with the position: ${low}`);
  assert.ok(/restrained/.test(low), `energy low must announce its zone name: ${low}`);
  for (const tag of SPEC_ENERGY_LOW) {
    assert.ok(low.indexOf(tag) !== -1, `value text omits the injected tag "${tag}": ${low}`);
  }

  const neutral = sliderValueText('warmth', 50);
  assert.ok(/neutral/.test(neutral), neutral);
  assert.ok(/no warmth tags/.test(neutral), `neutral must say nothing is injected: ${neutral}`);

  const high = sliderValueText('density', 96);
  assert.ok(/wall of sound/.test(high), high);
  assert.strictEqual(sliderZoneLabel('energy', 95), 'explosive');
  assert.strictEqual(sliderZoneLabel('warmth', 5), 'cold and digital');
  assert.strictEqual(sliderZoneLabel('density', 5), 'sparse');
});

/* -------------------------------------------------------------------------- */
/* A. createPromptState                                                       */
/* -------------------------------------------------------------------------- */

s.test('a fresh store is empty, and says so in every accessor', () => {
  const state = createPromptState();
  deepEqual(state.list(), []);
  assert.strictEqual(state.draftText(), '');
  const counts = state.counts();
  assert.strictEqual(counts.total, 0);
  assert.strictEqual(counts.length, 0);
  for (const section of PROMPT_SECTIONS) assert.strictEqual(counts.sections[section], 0);
});

s.test('add() returns a stable id and stores exactly what it was given', () => {
  const state = createPromptState();
  const id = state.add({ section: 'genre', tag: 'techno', weight: 0.9, source: 'dissector' });
  assert.ok(typeof id === 'string' && id, 'add() must return an id');
  deepEqual(state.list(), [{ id, section: 'genre', tag: 'techno', source: 'dissector', weight: 0.9 }]);
  assert.strictEqual(state.counts().total, 1);
});

s.test('a repeat of the same tag in the same section is refused, case and space insensitively', () => {
  const state = createPromptState();
  assert.ok(state.add({ section: 'genre', tag: 'Deep House', source: 'manual' }));
  assert.strictEqual(state.add({ section: 'genre', tag: 'deep house', source: 'manual' }), null);
  assert.strictEqual(state.add({ section: 'genre', tag: '  DEEP   HOUSE  ', source: 'scene' }), null);
  assert.strictEqual(state.counts().total, 1, 'a duplicate must not grow the set');

  // The SAME word in a different section is a different ingredient.
  assert.ok(state.add({ section: 'mood', tag: 'deep house', source: 'manual' }));
  assert.strictEqual(state.counts().total, 2);

  // Whitespace inside a stored tag is collapsed, not preserved verbatim.
  const state2 = createPromptState();
  state2.add({ section: 'genre', tag: '  warm   analog  ', source: 'manual' });
  assert.strictEqual(state2.list()[0].tag, 'warm analog');
});

s.test('malformed entries are refused without throwing and without a partial write', () => {
  const state = createPromptState();
  const rejects = [
    undefined,
    null,
    'techno',
    42,
    {},
    { tag: 'techno', section: 'not-a-section' },
    { section: 'genre', tag: '' },
    { section: 'genre', tag: '   ' },
    { section: 'genre', tag: 7 },
    { section: 'genre', tag: 'techno', source: 'sneaky' },
  ];
  for (const entry of rejects) {
    assert.strictEqual(state.add(entry), null, `${JSON.stringify(entry)} must be refused`);
  }
  assert.strictEqual(state.counts().total, 0, 'a refused entry must leave nothing behind');
});

s.test('an entry with no section lands in the section its source owns', () => {
  const state = createPromptState();
  state.add({ tag: 'neon glow pad', source: 'scene' });
  state.add({ tag: 'hand written', source: 'manual' });
  assert.strictEqual(state.list('scene').length, 1);
  assert.strictEqual(state.list('custom').length, 1);
});

s.test('remove() drops one entry by id and reports whether there was one', () => {
  const state = createPromptState();
  const a = state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  const b = state.add({ section: 'genre', tag: 'house', source: 'manual' });
  assert.strictEqual(state.remove(a), true);
  assert.strictEqual(state.remove(a), false, 'removing twice is not a second removal');
  assert.strictEqual(state.remove('nope'), false);
  deepEqual(state.list().map((e) => e.id), [b]);

  // The freed (section, tag) can be claimed again — removal really releases it.
  assert.ok(state.add({ section: 'genre', tag: 'techno', source: 'manual' }));
});

s.test('clearSection() empties one section and leaves the others untouched', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  state.add({ section: 'genre', tag: 'house', source: 'manual' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'manual' });

  assert.strictEqual(state.clearSection('genre'), 2);
  assert.strictEqual(state.clearSection('genre'), 0, 'an empty section clears nothing');
  assert.strictEqual(state.clearSection('not-a-section'), 0);
  deepEqual(state.list().map((e) => e.tag), ['hypnotic']);
});

s.test('a slider move REPLACES that axis: 5 tags out, 5 tags in, never 10', () => {
  const state = createPromptState();
  state.setSource('slider-energy', sliderTags('energy', 95));
  deepEqual(state.list('slider').map((e) => e.tag), SPEC_ENERGY_HIGH);
  assert.strictEqual(state.counts().total, 5);

  state.setSource('slider-energy', sliderTags('energy', 5));
  deepEqual(
    state.list('slider').map((e) => e.tag),
    SPEC_ENERGY_LOW,
    'the previous contribution must be gone, not appended to'
  );
  assert.strictEqual(state.counts().total, 5, 'a slider drag must never accumulate');

  // Back to the neutral band: the axis contributes nothing at all.
  state.setSource('slider-energy', sliderTags('energy', 50));
  assert.strictEqual(state.counts().total, 0);
});

s.test('the three axes are independent sources sharing one section', () => {
  const state = createPromptState();
  state.setSource('slider-energy', sliderTags('energy', 90));
  state.setSource('slider-warmth', sliderTags('warmth', 10));
  state.setSource('slider-density', sliderTags('density', 90));
  assert.strictEqual(state.counts().total, 5 + 6 + 5);
  assert.strictEqual(state.counts().sections.slider, 16);

  // Moving one axis leaves the other two exactly where they were.
  state.setSource('slider-warmth', sliderTags('warmth', 50));
  assert.strictEqual(state.counts().total, 10);
  assert.strictEqual(state.counts().sources['slider-energy'], 5);
  assert.strictEqual(state.counts().sources['slider-density'], 5);
  assert.strictEqual(state.counts().sources['slider-warmth'], 0);
});

s.test('setSource is atomic: a subscriber never sees the old set beside the new', () => {
  const state = createPromptState();
  state.setSource('slider-energy', sliderTags('energy', 95));

  const observed = [];
  state.subscribe((entries) => observed.push(entries.map((e) => e.tag)));
  state.setSource('slider-energy', sliderTags('energy', 5));

  assert.strictEqual(observed.length, 1, 'the swap must be ONE notification, not a drop and an add');
  deepEqual(observed[0], SPEC_ENERGY_LOW, 'the observed set must be the new one, whole');
});

s.test('setSource refuses an unknown source and ignores unusable members', () => {
  const state = createPromptState();
  assert.strictEqual(state.setSource('slider-nope', ['x']), 0);
  assert.strictEqual(state.setSource(null, ['x']), 0);
  assert.strictEqual(state.counts().total, 0);

  assert.strictEqual(state.setSource('scene', ['rain ambience texture', '', null, 7, { tag: 'choral drone' }]), 2);
  deepEqual(state.list('scene').map((e) => e.tag), ['rain ambience texture', 'choral drone']);

  // An empty replacement is a legitimate "this source contributes nothing".
  assert.strictEqual(state.setSource('scene', []), 0);
  assert.strictEqual(state.counts().total, 0);
});

s.test('a cross-source collision is skipped, and the dedupe index never drifts', () => {
  // A tag one source already holds cannot be claimed by another in the same
  // section; and when the first source lets go, the second can claim it.
  const state = createPromptState();
  state.add({ section: 'slider', tag: 'wall of sound', source: 'manual' });
  assert.strictEqual(state.setSource('slider-density', ['wall of sound', 'dense arrangement']), 1);
  deepEqual(state.list('slider').map((e) => e.tag), ['wall of sound', 'dense arrangement']);
  assert.strictEqual(state.counts().total, 2, 'the collision must not produce a second copy');

  // Release the manual one; the slider source can now hold it after a resync.
  const manual = state.list('slider').filter((e) => e.source === 'manual')[0];
  state.remove(manual.id);
  assert.strictEqual(state.setSource('slider-density', ['wall of sound', 'dense arrangement']), 2);
  deepEqual(state.list('slider').map((e) => e.tag), ['wall of sound', 'dense arrangement']);
  assert.strictEqual(state.counts().sources['slider-density'], 2);

  // The freed key really is free: nothing is stuck in the dedupe index.
  state.setSource('slider-density', []);
  assert.strictEqual(state.counts().total, 0);
  assert.ok(state.add({ section: 'slider', tag: 'wall of sound', source: 'manual' }));
  assert.ok(state.add({ section: 'slider', tag: 'dense arrangement', source: 'manual' }));
  assert.strictEqual(state.counts().total, 2);
});

s.test('a slider-section tag from another source still reaches the draft, last', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  state.add({ section: 'slider', tag: 'hand-tuned feel', source: 'manual' });
  state.setSource('slider-energy', ['high energy']);
  assert.strictEqual(state.draftText(), 'techno, high energy, hand-tuned feel');
});

s.test('draftText groups by section order, then appends the sliders energy→warmth→density', () => {
  const state = createPromptState();
  // Deliberately added in the WRONG order: the draft's order is a property of
  // the sections, not of when the user happened to click.
  state.add({ section: 'era', tag: '1980s production', source: 'dissector' });
  state.add({ section: 'custom', tag: 'hand written', source: 'manual' });
  state.add({ section: 'scene', tag: 'neon rain', source: 'scene' });
  state.add({ section: 'instrument', tag: 'TR-909 kick', source: 'dissector' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });
  state.add({ section: 'genre', tag: 'techno', source: 'dissector' });
  state.add({ section: 'genre', tag: 'french electro', source: 'dissector' });

  state.setSource('slider-density', ['dense arrangement']);
  state.setSource('slider-energy', ['high energy']);
  state.setSource('slider-warmth', ['tape hiss']);

  assert.strictEqual(
    state.draftText(),
    'techno, french electro, hypnotic, TR-909 kick, neon rain, 1980s production, hand written, ' +
      'high energy, tape hiss, dense arrangement'
  );
  deepEqual(PROMPT_SECTION_ORDER, ['genre', 'mood', 'instrument', 'scene', 'era', 'custom']);
  deepEqual(PROMPT_SLIDER_SOURCES, ['slider-energy', 'slider-warmth', 'slider-density']);
});

s.test('draftText is deterministic and insertion-ordered inside a section', () => {
  const build = () => {
    const state = createPromptState();
    state.add({ section: 'genre', tag: 'zeta', source: 'manual' });
    state.add({ section: 'genre', tag: 'alpha', source: 'manual' });
    state.add({ section: 'genre', tag: 'mid', source: 'manual' });
    return state.draftText();
  };
  assert.strictEqual(build(), 'zeta, alpha, mid', 'a section must not re-sort what the user added');
  assert.strictEqual(build(), build());
});

s.test('counts() reports sizes only — a length, never a verdict', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  state.add({ section: 'mood', tag: 'hypnotic', source: 'manual' });

  const counts = state.counts();
  assert.strictEqual(counts.total, 2);
  assert.strictEqual(counts.length, 'techno, hypnotic'.length);
  assert.strictEqual(counts.length, state.draftText().length);
  assert.strictEqual(counts.sections.genre, 1);
  assert.strictEqual(counts.sections.mood, 1);
  assert.strictEqual(counts.sources.manual, 2);

  // No budget flag of any kind. The limiter has shipped, but it lives in the
  // compiler pipeline (buildFinalPrompt), not in the ingredient store: this
  // store's job is to hold what the user picked, and a verdict smuggled in
  // here would give the app two sources of truth for one number.
  for (const key of Object.keys(counts)) {
    assert.ok(
      ['total', 'length', 'sections', 'sources'].indexOf(key) !== -1,
      `counts() grew an unexpected key "${key}" — a budget verdict does not belong here yet`
    );
  }
});

s.test('a length of a long draft is the real character count, uncapped and untrimmed', () => {
  const state = createPromptState();
  // Well past 1,000 characters: nothing may truncate, flag or drop a tag yet.
  for (let i = 0; i < 120; i += 1) {
    state.add({ section: 'custom', tag: 'texture layer number ' + i, source: 'manual' });
  }
  const text = state.draftText();
  assert.ok(text.length > 1000, `expected an over-long draft, got ${text.length}`);
  assert.strictEqual(state.counts().length, text.length);
  assert.strictEqual(state.counts().total, 120, 'no tag may be dropped for length');
});

s.test('list() hands back copies, so a caller cannot edit the store behind its back', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  const first = state.list();
  first[0].tag = 'clobbered';
  first.push({ id: 'x', section: 'genre', tag: 'smuggled', source: 'manual' });
  deepEqual(state.list().map((e) => e.tag), ['techno']);
});

s.test('list(section) filters, and an unknown section is simply empty', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  state.add({ section: 'mood', tag: 'dark', source: 'manual' });
  assert.strictEqual(state.list('genre').length, 1);
  assert.strictEqual(state.list('mood').length, 1);
  assert.strictEqual(state.list('era').length, 0);
  assert.strictEqual(state.list('nonsense').length, 0);
  assert.strictEqual(state.list().length, 2);
});

s.test('subscribers fire once per real change and get the new state', () => {
  const state = createPromptState();
  const seen = [];
  state.subscribe((entries, counts) => seen.push({ tags: entries.map((e) => e.tag), total: counts.total }));

  const id = state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  state.add({ section: 'genre', tag: 'techno', source: 'manual' }); // duplicate: no change
  state.remove('missing'); // no change
  state.clearSection('mood'); // no change
  state.remove(id);

  assert.strictEqual(seen.length, 2, `expected 2 notifications, got ${seen.length}`);
  deepEqual(seen[0], { tags: ['techno'], total: 1 });
  deepEqual(seen[1], { tags: [], total: 0 });
});

s.test('batch() publishes one notification for many mutations', () => {
  const state = createPromptState();
  const seen = [];
  state.subscribe((entries) => seen.push(entries.length));

  const returned = state.batch(() => {
    state.add({ section: 'genre', tag: 'techno', source: 'manual' });
    state.add({ section: 'genre', tag: 'house', source: 'manual' });
    state.add({ section: 'mood', tag: 'dark', source: 'manual' });
    state.setSource('slider-energy', sliderTags('energy', 95));
    return 'done';
  });

  assert.strictEqual(returned, 'done', 'batch must hand back what the callback returned');
  deepEqual(seen, [8], 'expected exactly one notification carrying the finished state');
  assert.strictEqual(state.counts().total, 8);
});

s.test('a batch that changes nothing publishes nothing', () => {
  const state = createPromptState();
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  let calls = 0;
  state.subscribe(() => {
    calls += 1;
  });

  state.batch(() => {
    state.add({ section: 'genre', tag: 'techno', source: 'manual' }); // duplicate
    state.remove('nope');
    state.clearSection('era');
  });
  assert.strictEqual(calls, 0, 'a batch of no-ops must stay silent');

  state.batch(() => {});
  assert.strictEqual(calls, 0);
});

s.test('nested batches collapse into the outermost one', () => {
  const state = createPromptState();
  let calls = 0;
  state.subscribe(() => {
    calls += 1;
  });

  state.batch(() => {
    state.add({ section: 'genre', tag: 'techno', source: 'manual' });
    state.batch(() => {
      state.add({ section: 'genre', tag: 'house', source: 'manual' });
      state.batch(() => {
        state.add({ section: 'mood', tag: 'dark', source: 'manual' });
      });
      assert.strictEqual(calls, 0, 'an inner batch must not publish');
    });
    assert.strictEqual(calls, 0, 'a middle batch must not publish');
  });

  assert.strictEqual(calls, 1, 'only the outermost batch publishes');
  assert.strictEqual(state.counts().total, 3);
});

s.test('a batch that throws still publishes what it managed to do', () => {
  const state = createPromptState();
  const seen = [];
  state.subscribe((entries) => seen.push(entries.map((e) => e.tag)));

  assert.throws(() => {
    state.batch(() => {
      state.add({ section: 'genre', tag: 'techno', source: 'manual' });
      throw new Error('halfway');
    });
  }, /halfway/);

  deepEqual(seen, [['techno']], 'the committed half must not go unannounced');
  assert.strictEqual(state.counts().total, 1);

  // …and the store is not left stuck inside a batch.
  state.add({ section: 'genre', tag: 'house', source: 'manual' });
  assert.strictEqual(seen.length, 2, 'the next ordinary mutation must publish normally');
});

s.test('batch() ignores a non-function without breaking the store', () => {
  const state = createPromptState();
  let calls = 0;
  state.subscribe(() => {
    calls += 1;
  });
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.strictEqual(state.batch(bad), undefined);
  }
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  assert.strictEqual(calls, 1, 'the store must still publish after a refused batch');
});

s.test('unsubscribe stops the callbacks, and is safe to call twice', () => {
  const state = createPromptState();
  let calls = 0;
  const off = state.subscribe(() => {
    calls += 1;
  });
  state.add({ section: 'genre', tag: 'techno', source: 'manual' });
  assert.strictEqual(calls, 1);
  off();
  off();
  state.add({ section: 'genre', tag: 'house', source: 'manual' });
  assert.strictEqual(calls, 1, 'an unsubscribed listener must not be called again');
  assert.strictEqual(typeof state.subscribe('not a function'), 'function', 'subscribe must always return an unsubscribe');
});

s.test('a subscriber that throws breaks neither the store nor its peers', () => {
  const state = createPromptState();
  const order = [];
  state.subscribe(() => {
    order.push('first');
  });
  state.subscribe(() => {
    order.push('boom');
    throw new Error('subscriber exploded');
  });
  state.subscribe(() => {
    order.push('last');
  });

  assert.doesNotThrow(() => state.add({ section: 'genre', tag: 'techno', source: 'manual' }));
  deepEqual(order, ['first', 'boom', 'last'], 'a throwing subscriber must not stop the ones after it');
  assert.strictEqual(state.counts().total, 1, 'the mutation must have committed anyway');

  // And the store keeps working afterwards.
  order.length = 0;
  state.add({ section: 'genre', tag: 'house', source: 'manual' });
  deepEqual(order, ['first', 'boom', 'last']);
});

s.test('two stores are fully independent', () => {
  const a = createPromptState({ idPrefix: 'a' });
  const b = createPromptState({ idPrefix: 'b' });
  const idA = a.add({ section: 'genre', tag: 'techno', source: 'manual' });
  const idB = b.add({ section: 'genre', tag: 'techno', source: 'manual' });
  assert.notStrictEqual(idA, idB, 'the id prefix must reach the ids');
  assert.strictEqual(a.counts().total, 1);
  assert.strictEqual(b.counts().total, 1);
  a.clearSection('genre');
  assert.strictEqual(b.counts().total, 1);
});

/* -------------------------------------------------------------------------- */
/* C. matchScenes — the Cinematic Scene Generator (FDD #22)                    */
/* -------------------------------------------------------------------------- */

s.test('the KB carries at least 20 scenes, each with real production tokens', () => {
  assert.ok(MUSIC_KB.scenes.length >= 20, `only ${MUSIC_KB.scenes.length} scenes in MUSIC_KB`);
});

s.test('six scene phrases resolve to their expected token subsets', () => {
  const cases = [
    { text: 'neon rain', id: 'neon-rain', expect: ['neon rain', 'rain ambience texture'] },
    { text: 'a midnight drive', id: 'midnight-drive', expect: ['midnight drive', 'steady motorik pulse'] },
    { text: 'sunrise rooftop', id: 'sunrise-rooftop', expect: ['sunrise rooftop', 'shimmering rhodes chords'] },
    { text: 'inside an abandoned warehouse', id: 'abandoned-warehouse', expect: ['abandoned warehouse', 'cavernous concrete reverb'] },
    { text: 'an underwater cathedral', id: 'underwater-cathedral', expect: ['underwater cathedral', 'submerged reverb wash'] },
    { text: 'a neon arcade at night', id: 'neon-arcade', expect: ['neon arcade', 'chiptune square lead'] },
    { text: 'driving down a desert highway', id: 'desert-highway', expect: ['desert highway', 'dusty slide guitar'] },
  ];

  for (const testCase of cases) {
    const scenes = matchScenes(testCase.text);
    const hit = scenes.filter((scene) => scene.id === testCase.id)[0];
    assert.ok(hit, `"${testCase.text}" did not match scene ${testCase.id} (got ${scenes.map((x) => x.id).join(', ') || 'nothing'})`);
    const tags = hit.tokens.map((t) => t.tag);
    for (const expected of testCase.expect) {
      assert.ok(tags.indexOf(expected) !== -1, `${testCase.id} is missing the token "${expected}": ${tags.join(', ')}`);
    }
    for (const token of hit.tokens) {
      assert.ok(token.weight > 0 && token.weight <= 1, `${testCase.id}/${token.tag}: weight ${token.weight}`);
    }
  }
});

s.test('every phrase of every KB scene round-trips to non-empty tokens', () => {
  for (const scene of MUSIC_KB.scenes) {
    for (const phrase of scene.phrases) {
      const scenes = matchScenes(phrase);
      const hit = scenes.filter((s2) => s2.id === scene.id)[0];
      assert.ok(hit, `the scene trigger "${phrase}" no longer reaches ${scene.id}`);
      assert.ok(hit.tokens.length > 0, `${scene.id} matched "${phrase}" but produced no tokens`);
      assert.strictEqual(hit.label, scene.label);
    }
  }
});

s.test('unmatched text yields nothing at all — no invented scene', () => {
  for (const text of ['', '   ', 'qqqq zzzz wwww', 'xylophone quixotry blargh', null, undefined, 42]) {
    deepEqual(matchScenes(text), [], `"${String(text)}" must match no scene`);
  }
});

s.test('only scenes come back — a genre or a decade in the text is somebody else’s job', () => {
  const scenes = matchScenes('1980s french electro in the neon rain');
  deepEqual(scenes.map((sc) => sc.id), ['neon-rain']);
});

s.test('scene matching folds case and punctuation, and de-duplicates a repeat', () => {
  deepEqual(matchScenes('NEON RAIN!!').map((sc) => sc.id), ['neon-rain']);
  deepEqual(matchScenes('neon rain, more neon rain').map((sc) => sc.id), ['neon-rain']);
  const many = matchScenes('neon rain over a midnight drive to a haunted house');
  deepEqual(many.map((sc) => sc.id), ['neon-rain', 'midnight-drive', 'haunted-house']);
});

s.test('sceneTriggerList offers every scene, and every offered phrase matches back', () => {
  const triggers = sceneTriggerList();
  assert.strictEqual(triggers.length, MUSIC_KB.scenes.length, 'every scene must be offered');
  const ids = new Set(triggers.map((t) => t.id));
  assert.strictEqual(ids.size, triggers.length, 'the trigger list must not repeat a scene');
  for (const trigger of triggers) {
    assert.ok(trigger.label && trigger.phrase, `trigger ${trigger.id} is missing a label or phrase`);
    const scenes = matchScenes(trigger.phrase);
    assert.ok(
      scenes.some((sc) => sc.id === trigger.id),
      `the offered trigger "${trigger.phrase}" does not match its own scene ${trigger.id}`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* D. sanitizeSafeMode — the Safe-Mode guarantee (FDD #24)                     */
/* -------------------------------------------------------------------------- */

s.test('a name typed into the box never survives into the result', () => {
  const input = 'sounds like Daft Punk';
  // A result deliberately poisoned with the name, which is exactly what a
  // careless remote model would hand back.
  const poisoned = {
    genre_tokens: [
      { tag: 'french electro', weight: 1 },
      { tag: 'daft punk style filter disco', weight: 0.9 },
      { tag: 'Punk energy', weight: 0.5 },
      { tag: 'sidechain pumping', weight: 0.8 },
    ],
    bpm_range: [110, 125],
    instruments: ['talkbox vocal', 'Daft Punk vocoder'],
    mood: ['punk attitude', 'euphoric'],
    era: ['2000s French touch'],
    confidence: 0.8,
    source: 'cloud',
  };

  const safe = sanitizeSafeMode(input, poisoned);
  const all = tagsOf(safe).concat(safe.instruments, safe.mood, safe.era).join(' | ').toLowerCase();
  assert.ok(all.indexOf('daft') === -1, `"daft" survived: ${all}`);
  assert.ok(all.indexOf('punk') === -1, `"punk" survived: ${all}`);

  // …and the innocent tokens are still there.
  assert.ok(tagsOf(safe).indexOf('french electro') !== -1, tagsOf(safe).join(', '));
  assert.ok(tagsOf(safe).indexOf('sidechain pumping') !== -1, tagsOf(safe).join(', '));
  assert.ok(safe.instruments.indexOf('talkbox vocal') !== -1, safe.instruments.join(', '));
  assert.ok(safe.mood.indexOf('euphoric') !== -1, safe.mood.join(', '));
  deepEqual(safe.bpm_range, [110, 125], 'the tempo is not a name');
  assert.strictEqual(safe.source, 'cloud', 'the source stamp survives');
});

s.test('the real local dissection of an artist prompt is clean of the name', () => {
  const input = 'sounds like Daft Punk, french electro';
  const safe = sanitizeSafeMode(input, dissectLocal(input));
  const all = tagsOf(safe).concat(safe.instruments, safe.mood, safe.era).join(' | ').toLowerCase();
  assert.ok(all.indexOf('daft') === -1 && all.indexOf('punk') === -1, all);
  assert.ok(tagsOf(safe).indexOf('french electro') !== -1, 'the genre it actually names must survive');
});

s.test('“like Burna Boy afrobeats” keeps the genre and loses only the name', () => {
  const input = 'like Burna Boy afrobeats';
  const raw = dissectLocal(input);
  assert.ok(tagsOf(raw).indexOf('afrobeats') !== -1, 'precondition: the local engine finds afrobeats');

  const safe = sanitizeSafeMode(input, raw);
  deepEqual(tagsOf(safe), tagsOf(raw), 'no afrobeats token contains the name, so none may be dropped');
  deepEqual(safe.instruments, raw.instruments);
  deepEqual(safe.mood, raw.mood);

  const candidates = safeModeNameCandidates(input);
  assert.ok(candidates.indexOf('burna') !== -1, `"burna" must be seen as a name: ${candidates.join(', ')}`);
  assert.ok(candidates.indexOf('burna boy') !== -1, `the two-word name must be caught too: ${candidates.join(', ')}`);
  assert.ok(candidates.indexOf('afrobeats') === -1, 'a KB genre is not a name');
});

s.test('KB vocabulary is never treated as a name, however it is typed', () => {
  const input = 'dark techno with a warehouse reverb like Somebody Unknown';
  const candidates = safeModeNameCandidates(input);
  for (const word of ['techno', 'warehouse', 'reverb', 'dark']) {
    assert.ok(candidates.indexOf(word) === -1, `"${word}" is taxonomy, not a name: ${candidates.join(', ')}`);
  }

  const result = {
    genre_tokens: [
      { tag: 'techno', weight: 1 },
      { tag: 'warehouse reverb', weight: 0.6 },
    ],
    bpm_range: null,
    instruments: ['TR-909 kick'],
    mood: ['dark'],
    era: [],
    confidence: 0.7,
    source: 'local',
  };
  const safe = sanitizeSafeMode(input, result);
  deepEqual(tagsOf(safe), ['techno', 'warehouse reverb'], 'the taxonomy must survive intact');
  deepEqual(safe.mood, ['dark']);
});

s.test('the strip is case-insensitive in both directions', () => {
  const result = {
    genre_tokens: [{ tag: 'ZORBLAX disco stomp', weight: 1 }, { tag: 'disco stomp', weight: 0.8 }],
    bpm_range: null,
    instruments: ['Zorblax bass'],
    mood: [],
    era: [],
    confidence: 0.5,
    source: 'local',
  };
  for (const input of ['sounds like zorblax', 'SOUNDS LIKE ZORBLAX', 'Sounds Like ZoRbLaX']) {
    const safe = sanitizeSafeMode(input, result);
    deepEqual(tagsOf(safe), ['disco stomp'], `case variant "${input}" leaked`);
    deepEqual(safe.instruments, []);
  }
});

s.test('a multi-word name is caught as a phrase as well as word by word', () => {
  const candidates = safeModeNameCandidates('in the style of Zorblax Quintet');
  assert.ok(candidates.indexOf('zorblax quintet') !== -1, candidates.join(', '));
  assert.ok(candidates.indexOf('zorblax') !== -1, candidates.join(', '));
  // Grammar is not a name: a pair with a stopword half is never a candidate.
  assert.ok(candidates.indexOf('of zorblax') === -1, candidates.join(', '));
  assert.ok(candidates.indexOf('the style') === -1, candidates.join(', '));

  const stripped = sanitizeSafeMode('in the style of Zorblax Quintet', {
    genre_tokens: [{ tag: 'zorblax quintet swing', weight: 1 }, { tag: 'brushed snare swing', weight: 0.8 }],
    bpm_range: null,
    instruments: [],
    mood: [],
    era: [],
    confidence: 0.7,
    source: 'local',
  });
  deepEqual(tagsOf(stripped), ['brushed snare swing']);
});

s.test('the pair rule catches a name built from words too short to stand alone', () => {
  // Neither half clears the four-character floor, so ONLY the pair can catch
  // it — which is the whole reason the pair rule exists.
  const candidates = safeModeNameCandidates('in the style of Lil Nas X');
  assert.ok(candidates.indexOf('lil nas') !== -1, `the short-word name was missed: ${candidates.join(', ')}`);
  assert.ok(candidates.indexOf('lil') === -1, 'a three-letter word must not be a candidate on its own');
});

s.test('two known musical words side by side are language, not a name', () => {
  // The pair rule needs at least one word the taxonomy has never heard of, or
  // "warm pop vocal, deep house" would strip the tokens it is describing.
  deepEqual(safeModeNameCandidates('warm pop vocal, deep house'), []);
  const candidates = safeModeNameCandidates('dark techno in an abandoned warehouse');
  deepEqual(candidates, [], `every word here is taxonomy: ${candidates.join(', ')}`);
});

s.test('a candidate matches at word boundaries, not as a bare substring', () => {
  // "mood" typed in a description must not swallow the mood "moody".
  const result = {
    genre_tokens: [{ tag: 'moody', weight: 1 }, { tag: 'zorblax', weight: 0.9 }],
    bpm_range: null,
    instruments: ['moody rhodes'],
    mood: ['moody'],
    era: [],
    confidence: 0.6,
    source: 'local',
  };
  const safe = sanitizeSafeMode('a moody zorblax sound', result);
  deepEqual(tagsOf(safe), ['moody'], 'a longer word must not be strip-matched by a shorter one');
  deepEqual(safe.instruments, ['moody rhodes']);

  // …but a five-character-plus candidate still catches its own inflections,
  // which is how a fragmented accented name ("Beyoncé" -> "beyonc") is caught.
  const inflected = sanitizeSafeMode('sounds like zorblax', {
    genre_tokens: [{ tag: 'zorblaxian stomp', weight: 1 }, { tag: 'disco stomp', weight: 0.8 }],
    bpm_range: null,
    instruments: [],
    mood: [],
    era: [],
    confidence: 0.6,
    source: 'local',
  });
  deepEqual(tagsOf(inflected), ['disco stomp']);
});

s.test('words of three characters or fewer are below the floor, by design', () => {
  const candidates = safeModeNameCandidates('like the kid and his dog');
  for (const word of ['the', 'kid', 'and', 'his', 'dog']) {
    assert.ok(candidates.indexOf(word) === -1, `"${word}" is too short to be a safe candidate`);
  }
});

s.test('a real dissection of a plain description loses nothing at all', () => {
  // The regression this pins: a describing word ("mood") that is not in the
  // taxonomy must not quietly delete a token from an ordinary request.
  for (const input of [
    'french electro with a neon rain mood',
    'dark techno in an abandoned warehouse',
    'warm 1970s soul with a live band feel',
    'amapiano log drums and jazzy chords',
  ]) {
    const raw = dissectLocal(input);
    const safe = sanitizeSafeMode(input, raw);
    deepEqual(tagsOf(safe), tagsOf(raw), `"${input}" lost a genre token to a false positive`);
    deepEqual(safe.instruments, raw.instruments, `"${input}" lost an instrument`);
    deepEqual(safe.mood, raw.mood, `"${input}" lost a mood`);
    deepEqual(safe.era, raw.era, `"${input}" lost an era`);
    assert.strictEqual(safe.confidence, raw.confidence);
  }
});

s.test('sanitizeSafeMode is pure: the input result is never mutated', () => {
  const result = {
    genre_tokens: [{ tag: 'zorblax funk', weight: 1 }, { tag: 'funk', weight: 0.7 }],
    bpm_range: [100, 110],
    instruments: ['clavinet'],
    mood: ['groovy'],
    era: [],
    confidence: 0.6,
    source: 'local',
  };
  const before = JSON.stringify(result);
  const safe = sanitizeSafeMode('sounds like zorblax', result);
  assert.strictEqual(JSON.stringify(result), before, 'the original result was mutated');
  assert.notStrictEqual(safe, result, 'sanitizeSafeMode must return a NEW object');
  assert.notStrictEqual(safe.genre_tokens, result.genre_tokens);
  deepEqual(tagsOf(safe), ['funk']);
});

s.test('an empty or absent input strips nothing — there is no name to find', () => {
  const result = {
    genre_tokens: [{ tag: 'french electro', weight: 1 }],
    bpm_range: null,
    instruments: ['talkbox vocal'],
    mood: ['euphoric'],
    era: ['2000s French touch'],
    confidence: 0.9,
    source: 'local',
  };
  for (const input of ['', '   ', null, undefined, 42]) {
    const safe = sanitizeSafeMode(input, result);
    deepEqual(tagsOf(safe), ['french electro'], `input ${String(input)} stripped something`);
    deepEqual(safe.instruments, ['talkbox vocal']);
    assert.strictEqual(safe.confidence, 0.9);
  }
});

s.test('a missing or malformed result yields an honest empty result, not a throw', () => {
  for (const result of [null, undefined, 'nope', 42, {}]) {
    const safe = sanitizeSafeMode('sounds like zorblax', result);
    deepEqual(tagsOf(safe), []);
    deepEqual(safe.instruments, []);
    deepEqual(safe.mood, []);
    deepEqual(safe.era, []);
    assert.strictEqual(safe.confidence, 0);
    assert.strictEqual(safe.bpm_range, null);
  }
});

s.test('when everything is stripped, the confidence goes with it', () => {
  const result = {
    genre_tokens: [{ tag: 'zorblax stomp', weight: 1 }],
    bpm_range: [120, 130],
    instruments: ['zorblax bass'],
    mood: ['zorblax swagger'],
    era: ['zorblax era'],
    confidence: 0.91,
    source: 'cloud',
  };
  const safe = sanitizeSafeMode('sounds like zorblax', result);
  deepEqual(tagsOf(safe), []);
  assert.strictEqual(safe.confidence, 0, 'nothing survived, so there is no evidence to be confident about');
});

s.test('sanitising an already-safe result is a no-op (idempotent)', () => {
  const input = 'sounds like Daft Punk french electro';
  const once = sanitizeSafeMode(input, dissectLocal(input));
  const twice = sanitizeSafeMode(input, once);
  deepEqual(tagsOf(twice), tagsOf(once));
  deepEqual(twice.instruments, once.instruments);
  deepEqual(twice.mood, once.mood);
  deepEqual(twice.era, once.era);
  assert.strictEqual(twice.confidence, once.confidence);
});

/* -------------------------------------------------------------------------- */
/* Static markup + CSS contracts                                              */
/* -------------------------------------------------------------------------- */

s.test('all three translator cards and the draft panel live in the Editor view', () => {
  const editor = readEditorMarkup();
  for (const id of [
    'scene-input',
    'scene-options',
    'scene-quick',
    'scene-status',
    'btn-scene-add',
    'slider-energy',
    'slider-warmth',
    'slider-density',
    'slider-energy-value',
    'slider-warmth-value',
    'slider-density-value',
    'slider-energy-tags',
    'slider-warmth-tags',
    'slider-density-tags',
    'draft-groups',
    'draft-empty',
    'draft-text',
    'draft-counts',
    'btn-draft-copy',
    'dissect-add-row',
    'btn-add-genres',
    'btn-add-instruments',
    'btn-add-moods',
    'btn-add-era',
    'btn-add-all',
    'dissect-safe-note',
  ]) {
    assert.ok(editor.indexOf(`id="${id}"`) !== -1, `#${id} must live inside the Prompt Editor view`);
  }

  // Each card is a labelled region, not an anonymous div.
  for (const pair of [
    ['scene-heading', 'Scene to sound'],
    ['sliders-heading', 'Physical feel'],
    ['draft-heading', 'Prompt draft'],
  ]) {
    assert.ok(
      new RegExp(`aria-labelledby="${pair[0]}"`).test(editor),
      `no section is labelled by #${pair[0]}`
    );
    assert.ok(
      new RegExp(`id="${pair[0]}"[^>]*>\\s*${pair[1]}`).test(editor),
      `#${pair[0]} must read "${pair[1]}"`
    );
  }
});

s.test('every slider is a real labelled range with a starting aria-valuetext', () => {
  const editor = readEditorMarkup();
  for (const axis of ['energy', 'warmth', 'density']) {
    const rangeRe = new RegExp(
      `<input type="range" id="slider-${axis}"[^>]*min="0"[^>]*max="100"[^>]*value="50"[^>]*aria-valuetext="[^"]+"`
    );
    assert.ok(rangeRe.test(editor), `#slider-${axis} must be a 0-100 range defaulting to 50 with an aria-valuetext`);
    assert.ok(
      new RegExp(`<label class="slider-name" for="slider-${axis}">`).test(editor),
      `#slider-${axis} has no <label for> — it would announce as an unnamed slider`
    );
    assert.ok(
      new RegExp(`id="slider-${axis}"[\\s\\S]{0,240}aria-valuetext="50 of 100 — neutral`).test(editor),
      `#slider-${axis} must start in the neutral band and say so`
    );
  }
  const ranges = readIndex().match(/type="range"/g) || [];
  // Three physical sliders plus one alpha slider per themable colour row —
  // the colour rows are built in script, so the markup has exactly three.
  assert.strictEqual(ranges.length, 3, `expected exactly 3 static range inputs, found ${ranges.length}`);
});

s.test('the scene input is a labelled text field bound to its datalist', () => {
  const editor = readEditorMarkup();
  assert.ok(/<label class="field-label" for="scene-input">/.test(editor), '#scene-input has no label');
  assert.ok(/id="scene-input"[^>]*list="scene-options"/.test(editor), '#scene-input is not bound to #scene-options');
  assert.ok(/<datalist id="scene-options">/.test(editor), 'the scene datalist is missing');
  assert.ok(/id="scene-status"[^>]*role="status"/.test(editor), 'the scene result must be announced');
  assert.ok(/id="scene-quick"[^>]*role="group"/.test(editor), 'the quick-chip row must be a labelled group');
});

s.test('the draft panel states its empty case and announces its counts', () => {
  const editor = readEditorMarkup();
  assert.ok(/id="draft-empty"[\s\S]{0,200}Nothing added yet/.test(editor), 'the empty state must say so plainly');
  assert.ok(/id="draft-counts"[^>]*role="status"/.test(editor), 'the counts must be a live region');
  assert.ok(/id="draft-counts"[^>]*aria-live="polite"/.test(editor));
  /*
   * Honesty check, still. The 1,000-character budget now EXISTS, but it is not
   * this card's: the draft is the ingredients list, and the gauge that counts,
   * colours and enforces the ceiling lives in the Style prompt card
   * (tests/compiler.test.js owns that contract). So the draft card must still
   * not claim a budget — it is a plain tag count, and a user reading a number
   * here must not think it is the one Suno will reject them for.
   *
   * The slice runs from the draft heading to the END OF THE CARD, not to the
   * end of the view: the Style prompt card that follows is entitled to say
   * "1,000" on every other line, and it does.
   */
  const draftStart = editor.indexOf('id="draft-heading"');
  const draftEnd = editor.indexOf('</section>', draftStart);
  assert.ok(draftEnd > draftStart, 'the draft card is not a closed <section>');
  const draftMarkup = editor.slice(draftStart, draftEnd);
  assert.ok(
    !/1,?000/.test(draftMarkup),
    'the draft card must not mention a 1,000-character budget — it counts ingredients, ' +
      'not the compiled style prompt the gauge enforces'
  );
});

s.test('the new cards are token-only: no colour literal escaped into their CSS', () => {
  const css = readStyle();
  const selectors = [
    '.vibe-card {',
    '.chip {',
    '.slider-input {',
    '.draft-text {',
    '.genre-badge.is-unsafe {',
    '.dissect-safe-note {',
  ];
  for (const selector of selectors) {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `the stylesheet is missing a rule for ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(body),
      `${selector} hard-codes a colour, which no theme or Code Mode can reach:\n${body}`
    );
  }
});

s.test('the vibe grid reflows on @container, never on @media', () => {
  const css = readStyle();
  const rule = /@container\s+editor-view\s*\(min-width:\s*880px\)\s*\{([\s\S]*?)\n  \}/.exec(css);
  assert.ok(rule, 'no @container editor-view rule found');
  assert.ok(/\.vibe-grid\s*\{[^}]*grid-template-columns/.test(rule[1]), '.vibe-grid never becomes two columns');

  const mediaPreludes = css.match(/@media[^{]*/g) || [];
  for (const prelude of mediaPreludes) {
    assert.ok(
      /prefers-/.test(prelude),
      `@media is reserved for prefers-* user preferences, found: ${prelude.trim()}`
    );
  }
});

s.test('Code Mode flattens the new translucent chips too', () => {
  const css = readStyle();
  const start = css.indexOf('.high-contrast');
  const contrast = css.slice(start);
  assert.ok(
    /\.high-contrast \.slider-chip/.test(contrast),
    'the slider chips carry a tinted wash; Code Mode must flatten it like the badges'
  );
});

s.finish();
