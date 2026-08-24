'use strict';
/*
 * tests/structure-builder.test.js — the Song Structure Builder
 * (docs/FDD.md Domain D: #39 drag-and-drop song flow canvas, #40 undo/redo
 * history stack, #42 official Suno v5.5 metatag library, #50 auto-chorus
 * refrain) over docs/FEATURE-MECHANICS.md §2.3 and §3.1-§3.2.
 *
 * WHAT IS COVERED
 *   - SUNO_METATAGS against a SECOND, INDEPENDENTLY TYPED copy of the §3.1
 *     taxonomy. Comparing index.html against itself would prove nothing about
 *     whether it matches the spec, so both lists are written out again here.
 *   - validateMetatag / sanitizeStructureTag: the whole alias table including
 *     §3.1's own worked example ("[Epic Solo Part 2]" -> "[Guitar Solo]"),
 *     numbered variants, and the [Interlude] fallback for anything else.
 *   - formatStructureTag: the §3.2 three-level hierarchy, exact strings, and
 *     the four-modifier ceiling with its "discard the rest" rule.
 *   - createStructureState: add/remove/move semantics, the numbering rule,
 *     subscriber isolation, toJSON/fromJSON round-trip identity, and compile()
 *     including every branch of the §2.3 auto-chorus refrain.
 *   - createHistoryStack: push/undo/redo sequences, the redo branch being
 *     cleared by a new push, oldest-first eviction at the limit, and the
 *     canUndo/canRedo edges.
 *   - The pure keybinding predicates (isTextEntryTarget, structureShortcut,
 *     structureMoveShortcut) and the static markup/CSS contracts of the card.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Real drag-and-drop gestures and real focus movement. HTML5 DnD needs a
 *     browser with a live layout (the insertion point is decided from
 *     getBoundingClientRect), so the drop path is verified by hand against a
 *     served localhost build; what CAN be tested without one — the index
 *     arithmetic in moveBlock, the keyboard reorder predicate and the
 *     stable-focus-key markup — is tested here.
 *   - Any character budget. compile() measures and reports; nothing trims.
 *     tests/limiter-eval.js owns that contract and is still honestly all-todo.
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
    RegExp,
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
  SUNO_METATAGS,
  STRUCTURE_MAX_MODIFIERS,
  STRUCTURE_FALLBACK_TAG,
  STRUCTURE_SOLO_TAG,
  validateMetatag,
  sanitizeStructureTag,
  splitStructureTag,
  formatStructureTag,
  parseModifierList,
  clampModifiers,
  createStructureState,
  createHistoryStack,
  isTextEntryTarget,
  structureShortcut,
  structureMoveShortcut,
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

/*
 * Values built inside the vm carry THAT realm's intrinsics, so deepStrictEqual
 * against a literal written here fails on prototype identity even when every
 * value matches. Round-tripping through JSON rebuilds them with this realm's
 * — and asserts in passing that everything the store hands out is plain,
 * serialisable data.
 */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(host(actual), host(expected), message);
}

/** The compiled tag of every block, in flow order — the shape of a song. */
function flowOf(state) {
  return state.blocks().map((b) => formatStructureTag(b.section, b.number, b.modifiers));
}

/* -------------------------------------------------------------------------- */
/* The §3.1 taxonomy, typed out again from docs/FEATURE-MECHANICS.md          */
/* -------------------------------------------------------------------------- */

/*
 * Transcribed by hand from FEATURE-MECHANICS.md §3.1. A SECOND source of
 * truth on purpose: a typo in index.html must fail a test rather than quietly
 * redefine the taxonomy.
 */
const SPEC_CORE_TAGS = [
  'Intro',
  'Verse',
  'Pre-Chorus',
  'Chorus',
  'Post-Chorus',
  'Bridge',
  'Outro',
  'End',
];
const SPEC_ACTION_TAGS = ['Instrumental', 'Interlude', 'Break', 'Drop', 'Build', 'Hook'];

const s = suite('structure-builder (FDD Domain D #39/#40/#42/#50)');

/* -------------------------------------------------------------------------- */
/* Module surface                                                             */
/* -------------------------------------------------------------------------- */

s.test('#app-main still evaluates with no DOM and the boot IIFE stays inert', () => {
  const fresh = loadAppSandbox();
  assert.strictEqual(fresh.evaluate('typeof createStructureState'), 'function');
  assert.strictEqual(fresh.evaluate('typeof document'), 'undefined');
});

s.test('every structure factory is a reachable top-level function declaration', () => {
  for (const name of [
    'validateMetatag',
    'sanitizeStructureTag',
    'splitStructureTag',
    'formatStructureTag',
    'parseModifierList',
    'clampModifiers',
    'createStructureState',
    'createHistoryStack',
    'isTextEntryTarget',
    'structureShortcut',
    'structureMoveShortcut',
  ]) {
    assert.strictEqual(
      app.evaluate(`typeof ${name}`),
      'function',
      `${name} must be a top-level function declaration in #app-main`
    );
  }
  assert.strictEqual(app.evaluate('typeof SUNO_METATAGS'), 'object');
  assert.strictEqual(app.evaluate('STRUCTURE_MAX_MODIFIERS'), 4);
});

/* -------------------------------------------------------------------------- */
/* A. Taxonomy — FEATURE-MECHANICS.md §3.1                                    */
/* -------------------------------------------------------------------------- */

s.test('SUNO_METATAGS reproduces §3.1 exactly, element for element', () => {
  deepEqual(SUNO_METATAGS.core, SPEC_CORE_TAGS, 'the Core Base Tags drifted from §3.1');
  deepEqual(SUNO_METATAGS.action, SPEC_ACTION_TAGS, 'the Special Action Tags drifted from §3.1');
  assert.strictEqual(SUNO_METATAGS.core.length, 8);
  assert.strictEqual(SUNO_METATAGS.action.length, 6);
});

s.test('every §3.1 tag validates and comes back in the taxonomy casing', () => {
  for (const tag of SPEC_CORE_TAGS.concat(SPEC_ACTION_TAGS)) {
    deepEqual(validateMetatag(tag), { valid: true, tag }, `${tag} must validate`);
  }
});

s.test('validation folds case and tolerates the brackets a tag is pasted with', () => {
  const cases = [
    ['chorus', 'Chorus'],
    ['CHORUS', 'Chorus'],
    ['ChOrUs', 'Chorus'],
    ['pre-chorus', 'Pre-Chorus'],
    ['POST-CHORUS', 'Post-Chorus'],
    ['[Verse]', 'Verse'],
    ['[ instrumental ]', 'Instrumental'],
    ['  Bridge  ', 'Bridge'],
    ['Beat\tDrop'.replace('Beat\t', ''), 'Drop'],
  ];
  for (const [input, expected] of cases) {
    deepEqual(validateMetatag(input), { valid: true, tag: expected }, `validateMetatag(${input})`);
  }
});

s.test('validateMetatag is the narrow question: anything else is {valid:false}', () => {
  // [Guitar Solo] is a legal OUTPUT of the sanitiser (§3.1's own replacement
  // example) but it is NOT one of the fourteen taxonomy tags, and saying so is
  // the honest answer.
  for (const input of [
    'Guitar Solo',
    'Epic Solo Part 2',
    'Verse 1',
    'refrain',
    'beat drop',
    '',
    '   ',
    '[]',
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    deepEqual(
      validateMetatag(input),
      { valid: false, tag: null },
      `validateMetatag(${JSON.stringify(input)}) must refuse`
    );
  }
});

s.test('the §3.1 rejection rule: "[Epic Solo Part 2]" becomes "[Guitar Solo]"', () => {
  // The spec's own worked example, in every form a user might type it.
  assert.strictEqual(sanitizeStructureTag('Epic Solo Part 2'), 'Guitar Solo');
  assert.strictEqual(sanitizeStructureTag('[Epic Solo Part 2]'), 'Guitar Solo');
  assert.strictEqual(sanitizeStructureTag('epic solo part 2'), 'Guitar Solo');
  assert.strictEqual(sanitizeStructureTag('Blistering Guitar Solo'), 'Guitar Solo');
  assert.strictEqual(STRUCTURE_SOLO_TAG, 'Guitar Solo');
});

s.test('the alias table maps every recognised phrasing onto a standard tag', () => {
  const table = [
    ['refrain', 'Chorus'],
    ['Refrains', 'Chorus'],
    ['the big refrain', 'Chorus'],
    ['drop', 'Drop'],
    ['beat drop', 'Drop'],
    ['Beat-Drop', 'Drop'],
    ['bass drop', 'Drop'],
    ['build-up', 'Build'],
    ['buildup', 'Build'],
    ['build up', 'Build'],
    ['riser', 'Build'],
    ['breakdown', 'Break'],
    ['break-down', 'Break'],
    ['hook', 'Hook'],
    ['catchy hook', 'Hook'],
    ['verse', 'Verse'],
    ['second verse', 'Verse'],
    ['prechorus', 'Pre-Chorus'],
    ['pre chorus', 'Pre-Chorus'],
    ['postchorus', 'Post-Chorus'],
    ['introduction', 'Intro'],
    ['middle eight', 'Bridge'],
    ['ending', 'End'],
    ['finale', 'End'],
    ['fade out', 'End'],
    ['guitar solo', 'Guitar Solo'],
    ['sax solo', 'Guitar Solo'],
  ];
  for (const [input, expected] of table) {
    assert.strictEqual(
      sanitizeStructureTag(input),
      expected,
      `sanitizeStructureTag(${JSON.stringify(input)}) should be ${expected}`
    );
  }
});

s.test('a compound alias beats its own suffix — "breakdown" is never "[Break]"', () => {
  assert.strictEqual(sanitizeStructureTag('breakdown'), 'Break');
  assert.strictEqual(sanitizeStructureTag('break'), 'Break');
  assert.strictEqual(sanitizeStructureTag('build up'), 'Build');
  assert.strictEqual(sanitizeStructureTag('build'), 'Build');
  assert.strictEqual(sanitizeStructureTag('pre-chorus'), 'Pre-Chorus');
  assert.strictEqual(sanitizeStructureTag('chorus'), 'Chorus');
  // Word boundaries, not bare substrings: "bend" must not read as "end".
  assert.strictEqual(sanitizeStructureTag('bend the note'), STRUCTURE_FALLBACK_TAG);
});

s.test('a numbered variant keeps its number — but only when it names a section', () => {
  assert.strictEqual(sanitizeStructureTag('Verse 2'), 'Verse 2');
  assert.strictEqual(sanitizeStructureTag('verse 2'), 'Verse 2');
  assert.strictEqual(sanitizeStructureTag('[Chorus 3]'), 'Chorus 3');
  assert.strictEqual(sanitizeStructureTag('refrain 2'), 'Chorus 2');
  assert.strictEqual(sanitizeStructureTag('pre chorus 2'), 'Pre-Chorus 2');
  assert.strictEqual(sanitizeStructureTag('Verse-3'), 'Verse 3');
  assert.strictEqual(sanitizeStructureTag('Verse 02'), 'Verse 2');
  // Zero is not a section number, and a hallucinated tag that merely ends in a
  // digit loses the digit with the rest of it.
  assert.strictEqual(sanitizeStructureTag('Verse 0'), 'Verse');
  assert.strictEqual(sanitizeStructureTag('Epic Solo Part 2'), 'Guitar Solo');
});

s.test('anything unrecognisable falls back to [Interlude] — never a guess', () => {
  for (const input of [
    'asdkjhasd',
    'Epic Space Battle',
    '!!!',
    '',
    '   ',
    '[]',
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    assert.strictEqual(
      sanitizeStructureTag(input),
      'Interlude',
      `sanitizeStructureTag(${JSON.stringify(input)}) must fall back`
    );
  }
  assert.strictEqual(STRUCTURE_FALLBACK_TAG, 'Interlude');
});

s.test('sanitizing an already-standard tag is a no-op (idempotent)', () => {
  for (const tag of SPEC_CORE_TAGS.concat(SPEC_ACTION_TAGS).concat(['Guitar Solo'])) {
    assert.strictEqual(sanitizeStructureTag(tag), tag);
    assert.strictEqual(sanitizeStructureTag(sanitizeStructureTag(tag)), tag);
  }
  assert.strictEqual(sanitizeStructureTag(sanitizeStructureTag('Epic Solo Part 2')), 'Guitar Solo');
});

s.test('splitStructureTag separates the section from a number written into it', () => {
  deepEqual(splitStructureTag('Verse 2'), { section: 'Verse', number: 2 });
  deepEqual(splitStructureTag('Chorus'), { section: 'Chorus', number: null });
  deepEqual(splitStructureTag('refrain 3'), { section: 'Chorus', number: 3 });
  deepEqual(splitStructureTag('nonsense'), { section: 'Interlude', number: null });
});

/* -------------------------------------------------------------------------- */
/* A2. The three-level hierarchy — FEATURE-MECHANICS.md §3.2                   */
/* -------------------------------------------------------------------------- */

s.test('§3.2 compiles exactly: [Verse 1 - intimate, sparse]', () => {
  assert.strictEqual(
    formatStructureTag('Verse', 1, ['intimate', 'sparse']),
    '[Verse 1 - intimate, sparse]'
  );
});

s.test('zero modifiers, and no number, each drop their whole segment', () => {
  assert.strictEqual(formatStructureTag('Verse', 1, []), '[Verse 1]');
  assert.strictEqual(formatStructureTag('Verse', 1), '[Verse 1]');
  assert.strictEqual(formatStructureTag('Bridge', null, ['dark']), '[Bridge - dark]');
  assert.strictEqual(formatStructureTag('Bridge', null, []), '[Bridge]');
  assert.strictEqual(formatStructureTag('Chorus'), '[Chorus]');
});

s.test('the fourth modifier is the last one: a fifth is discarded, in given order', () => {
  assert.strictEqual(
    formatStructureTag('Verse', 1, ['one', 'two', 'three', 'four', 'five']),
    '[Verse 1 - one, two, three, four]'
  );
  assert.strictEqual(
    formatStructureTag('Chorus', null, ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    '[Chorus - a, b, c, d]'
  );
  deepEqual(clampModifiers(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  assert.strictEqual(clampModifiers(['a', 'b', 'c', 'd', 'e']).length, STRUCTURE_MAX_MODIFIERS);
});

s.test('blank and non-string modifiers are dropped without consuming a slot', () => {
  deepEqual(clampModifiers(['a', '', '   ', 'b', null, 7, 'c', {}, 'd', 'e']), [
    'a',
    'b',
    'c',
    'd',
  ]);
  deepEqual(clampModifiers(null), []);
  deepEqual(clampModifiers('intimate, sparse'), []);
  assert.strictEqual(formatStructureTag('Verse', 1, ['  intimate  ', '', 'sparse']), '[Verse 1 - intimate, sparse]');
});

s.test('a comma or bracket inside a term cannot smuggle a fifth trait past the ceiling', () => {
  assert.strictEqual(
    formatStructureTag('Verse', 1, ['a, b', 'c', 'd', 'e']),
    '[Verse 1 - a b, c, d, e]'
  );
  assert.strictEqual(formatStructureTag('Verse', 1, ['[loud]']), '[Verse 1 - loud]');
});

s.test('the section is sanitised on the way through, so no invalid tag can compile', () => {
  assert.strictEqual(formatStructureTag('Epic Solo Part 2', null, ['wild']), '[Guitar Solo - wild]');
  assert.strictEqual(formatStructureTag('total nonsense'), '[Interlude]');
  // A number already written into the section is honoured when none is given,
  // and an explicit number wins when there is one.
  assert.strictEqual(formatStructureTag('Verse 2'), '[Verse 2]');
  assert.strictEqual(formatStructureTag('Verse 2', 5), '[Verse 5]');
});

s.test('parseModifierList splits on commas and is UNCLAMPED, so the UI can count the loss', () => {
  deepEqual(parseModifierList('intimate, sparse'), ['intimate', 'sparse']);
  deepEqual(parseModifierList(' a , b ,, c , '), ['a', 'b', 'c']);
  deepEqual(parseModifierList('a,b,c,d,e'), ['a', 'b', 'c', 'd', 'e']);
  deepEqual(parseModifierList(''), []);
  deepEqual(parseModifierList(null), []);
});

/* -------------------------------------------------------------------------- */
/* B. Structure state                                                         */
/* -------------------------------------------------------------------------- */

s.test('a fresh store is empty, and compiles to nothing at all', () => {
  const state = createStructureState();
  deepEqual(state.blocks(), []);
  assert.strictEqual(state.compile(), '');
  assert.strictEqual(state.autoChorus().applied, false);
  deepEqual(state.toJSON(), { version: 1, blocks: [] });
});

s.test('addBlock appends, returns a stable unique id, and sanitises the section', () => {
  const state = createStructureState();
  const a = state.addBlock('Intro');
  const b = state.addBlock('Epic Solo Part 2');
  const c = state.addBlock('total nonsense');
  assert.ok(a && b && c, 'every add must return an id');
  assert.strictEqual(new Set([a, b, c]).size, 3, 'ids must be unique');
  deepEqual(
    state.blocks().map((x) => x.section),
    ['Intro', 'Guitar Solo', 'Interlude']
  );
  deepEqual(state.blocks()[0], {
    id: a,
    section: 'Intro',
    number: null,
    modifiers: [],
    lyrics: '',
  });
});

s.test('addBlock(section, index) inserts, and an out-of-range index is clamped', () => {
  const state = createStructureState();
  state.addBlock('Intro');
  state.addBlock('Outro');
  state.addBlock('Chorus', 1);
  deepEqual(flowOf(state), ['[Intro]', '[Chorus]', '[Outro]']);

  state.addBlock('Hook', -50);
  state.addBlock('End', 900);
  deepEqual(flowOf(state), ['[Hook]', '[Intro]', '[Chorus]', '[Outro]', '[End]']);

  state.addBlock('Break', NaN);
  assert.strictEqual(state.blocks()[state.blocks().length - 1].section, 'Break');
});

s.test('removeBlock drops exactly one block and reports whether there was one', () => {
  const state = createStructureState();
  const a = state.addBlock('Intro');
  const b = state.addBlock('Chorus');
  assert.strictEqual(state.removeBlock(a), true);
  assert.strictEqual(state.removeBlock(a), false, 'a second removal has nothing to do');
  assert.strictEqual(state.removeBlock('block-nope'), false);
  deepEqual(
    state.blocks().map((x) => x.id),
    [b]
  );
});

s.test('moveBlock repositions, clamps out of range, and no-ops on the same index', () => {
  const state = createStructureState();
  const intro = state.addBlock('Intro');
  const verse = state.addBlock('Verse');
  const chorus = state.addBlock('Chorus');
  const outro = state.addBlock('Outro');

  assert.strictEqual(state.moveBlock(chorus, 1), true);
  deepEqual(flowOf(state), ['[Intro]', '[Chorus]', '[Verse]', '[Outro]']);

  assert.strictEqual(state.moveBlock(chorus, 1), false, 'moving where it already is changes nothing');

  assert.strictEqual(state.moveBlock(intro, 99), true, 'past the end clamps to the end');
  deepEqual(flowOf(state), ['[Chorus]', '[Verse]', '[Outro]', '[Intro]']);

  assert.strictEqual(state.moveBlock(outro, -12), true, 'before the start clamps to the start');
  deepEqual(flowOf(state), ['[Outro]', '[Chorus]', '[Verse]', '[Intro]']);

  assert.strictEqual(state.moveBlock('block-nope', 0), false);
  assert.strictEqual(state.moveBlock(verse, 2), false, 'index 2 is where it already sits');
});

/* -- the numbering rule -- */

s.test('one of a section is unnumbered; two or more are numbered from 1', () => {
  const state = createStructureState();
  state.addBlock('Verse');
  deepEqual(flowOf(state), ['[Verse]'], 'a lone verse must NOT claim to be the first of several');

  state.addBlock('Verse');
  deepEqual(flowOf(state), ['[Verse 1]', '[Verse 2]']);

  state.addBlock('Verse');
  deepEqual(flowOf(state), ['[Verse 1]', '[Verse 2]', '[Verse 3]']);
});

s.test('removing a block renumbers the rest, back to unnumbered at one', () => {
  const state = createStructureState();
  const first = state.addBlock('Verse');
  const second = state.addBlock('Verse');
  const third = state.addBlock('Verse');
  deepEqual(flowOf(state), ['[Verse 1]', '[Verse 2]', '[Verse 3]']);

  state.removeBlock(first);
  deepEqual(flowOf(state), ['[Verse 1]', '[Verse 2]'], 'the survivors renumber from 1');
  deepEqual(
    state.blocks().map((b) => b.id),
    [second, third],
    'ids are stable across a renumber'
  );

  state.removeBlock(second);
  deepEqual(flowOf(state), ['[Verse]'], 'the last one of its kind loses its number again');
});

s.test('numbering follows FLOW ORDER, so a move renumbers too', () => {
  const state = createStructureState();
  const a = state.addBlock('Verse');
  state.addBlock('Chorus');
  const b = state.addBlock('Verse');
  deepEqual(flowOf(state), ['[Verse 1]', '[Chorus]', '[Verse 2]']);

  state.moveBlock(b, 0);
  deepEqual(flowOf(state), ['[Verse 1]', '[Verse 2]', '[Chorus]']);
  assert.strictEqual(state.blocks()[0].id, b, 'the block that moved is the one now numbered 1');
  assert.strictEqual(state.blocks()[1].id, a);
});

s.test('sections are counted independently of one another', () => {
  const state = createStructureState();
  state.addBlock('Intro');
  state.addBlock('Verse');
  state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Chorus');
  state.addBlock('Bridge');
  state.addBlock('Outro');
  deepEqual(flowOf(state), [
    '[Intro]',
    '[Verse 1]',
    '[Chorus 1]',
    '[Verse 2]',
    '[Chorus 2]',
    '[Bridge]',
    '[Outro]',
  ]);
});

/* -- modifiers and lyrics -- */

s.test('setModifiers clamps to four and hands back a copy of what is held', () => {
  const state = createStructureState();
  const id = state.addBlock('Verse');
  deepEqual(state.setModifiers(id, ['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  deepEqual(state.blocks()[0].modifiers, ['a', 'b', 'c', 'd']);
  assert.strictEqual(state.setModifiers('block-nope', ['x']), null);

  const held = state.setModifiers(id, ['x']);
  held.push('mutated');
  deepEqual(state.blocks()[0].modifiers, ['x'], 'the caller cannot edit the store through it');

  deepEqual(state.setModifiers(id, []), []);
  deepEqual(state.blocks()[0].modifiers, []);
});

s.test('setLyrics stores the text, normalises line endings, and reports real change', () => {
  const state = createStructureState();
  const id = state.addBlock('Chorus');
  assert.strictEqual(state.setLyrics(id, 'one\r\ntwo\rthree'), true);
  assert.strictEqual(state.blocks()[0].lyrics, 'one\ntwo\nthree');
  assert.strictEqual(state.setLyrics(id, 'one\ntwo\nthree'), false, 'the same text is not a change');
  assert.strictEqual(state.setLyrics('block-nope', 'x'), false);
  assert.strictEqual(state.setLyrics(id, 42), true);
  assert.strictEqual(state.blocks()[0].lyrics, '', 'a non-string is no lyrics, not "42"');
});

s.test('blocks() hands back copies, so a caller cannot edit the store behind its back', () => {
  const state = createStructureState();
  const id = state.addBlock('Verse');
  state.setModifiers(id, ['soft']);
  const snapshot = state.blocks();
  snapshot[0].section = 'HACKED';
  snapshot[0].modifiers.push('loud');
  deepEqual(state.blocks()[0].section, 'Verse');
  deepEqual(state.blocks()[0].modifiers, ['soft']);
});

/* -- subscribers -- */

s.test('subscribers fire once per real change and get the new flow', () => {
  const state = createStructureState();
  const seen = [];
  const off = state.subscribe(function (blocks) {
    seen.push(blocks.length);
  });

  const id = state.addBlock('Verse');
  state.setLyrics(id, 'hello');
  state.setLyrics(id, 'hello'); // no change -> no notification
  state.setModifiers(id, ['soft']);
  state.setModifiers(id, ['soft']); // no change -> no notification
  state.moveBlock(id, 0); // already there -> no notification
  state.removeBlock(id);
  state.removeBlock(id); // gone -> no notification

  deepEqual(seen, [1, 1, 1, 0]);
  off();
  state.addBlock('Chorus');
  deepEqual(seen, [1, 1, 1, 0], 'unsubscribe stops the callbacks');
  off(); // idempotent
});

s.test('a subscriber that throws breaks neither the store nor its peers', () => {
  const state = createStructureState();
  let peer = 0;
  state.subscribe(function () {
    throw new Error('boom');
  });
  state.subscribe(function () {
    peer += 1;
  });
  const id = state.addBlock('Verse');
  assert.strictEqual(peer, 1);
  assert.strictEqual(state.blocks().length, 1);
  state.removeBlock(id);
  assert.strictEqual(peer, 2);
});

s.test('subscribe survives being handed something that is not a function', () => {
  const state = createStructureState();
  const off = state.subscribe(null);
  assert.strictEqual(typeof off, 'function');
  off();
  assert.ok(state.addBlock('Verse'));
});

s.test('two stores are fully independent', () => {
  const a = createStructureState({ idPrefix: 'a' });
  const b = createStructureState({ idPrefix: 'b' });
  a.addBlock('Verse');
  assert.strictEqual(b.blocks().length, 0);
  assert.ok(/^a-/.test(a.blocks()[0].id));
  b.addBlock('Chorus');
  assert.ok(/^b-/.test(b.blocks()[0].id));
});

/* -- serialisation -- */

s.test('toJSON / fromJSON round-trip to an identical snapshot, ids and all', () => {
  const state = createStructureState();
  const verse = state.addBlock('Verse');
  state.addBlock('Chorus');
  state.addBlock('Verse');
  state.setModifiers(verse, ['intimate', 'sparse']);
  state.setLyrics(verse, 'first line\nsecond line');

  const snapshot = state.toJSON();
  const restored = createStructureState();
  assert.strictEqual(restored.fromJSON(snapshot), true);
  deepEqual(restored.toJSON(), snapshot, 'a restored store must serialise identically');
  assert.strictEqual(restored.compile(), state.compile());

  // And back into the same store, which is what an undo does.
  state.removeBlock(verse);
  assert.strictEqual(state.fromJSON(snapshot), true);
  deepEqual(state.toJSON(), snapshot);
});

s.test('a restored store never reuses an id it just took back', () => {
  const state = createStructureState();
  state.addBlock('Verse');
  state.addBlock('Chorus');
  const snapshot = state.toJSON();

  const fresh = createStructureState();
  fresh.fromJSON(snapshot);
  const added = fresh.addBlock('Outro');
  const ids = fresh.blocks().map((b) => b.id);
  assert.strictEqual(new Set(ids).size, ids.length, `ids collided after a restore: ${ids}`);
  assert.ok(ids.indexOf(added) !== -1);
});

s.test('fromJSON sanitises what it is given and never throws', () => {
  const state = createStructureState();
  assert.strictEqual(state.fromJSON(null), false);
  assert.strictEqual(state.fromJSON('nope'), false);
  assert.strictEqual(state.fromJSON({}), false);
  assert.strictEqual(state.fromJSON({ blocks: 'nope' }), false);

  assert.strictEqual(
    state.fromJSON({
      version: 1,
      blocks: [
        null,
        'nope',
        { section: 'Epic Solo Part 2', modifiers: ['a', 'b', 'c', 'd', 'e'], lyrics: 'x\r\ny' },
        { section: 'chorus', id: 'dup' },
        { section: 'verse', id: 'dup' },
        { nothing: true },
      ],
    }),
    true
  );
  const blocks = state.blocks();
  assert.strictEqual(blocks.length, 4, 'the two unusable members are dropped, the rest kept');
  assert.strictEqual(blocks[0].section, 'Guitar Solo');
  deepEqual(blocks[0].modifiers, ['a', 'b', 'c', 'd']);
  assert.strictEqual(blocks[0].lyrics, 'x\ny');
  assert.strictEqual(blocks[1].section, 'Chorus');
  assert.strictEqual(blocks[2].section, 'Verse');
  assert.strictEqual(blocks[3].section, 'Interlude', 'a member with no section still lands standard');
  const ids = blocks.map((b) => b.id);
  assert.strictEqual(new Set(ids).size, ids.length, `a duplicated id must be reissued: ${ids}`);
});

s.test('fromJSON re-derives the numbering rather than trusting the payload', () => {
  const state = createStructureState();
  state.fromJSON({
    version: 1,
    blocks: [
      { id: 'x-1', section: 'Verse', number: 9 },
      { id: 'x-2', section: 'Chorus', number: 7 },
    ],
  });
  deepEqual(flowOf(state), ['[Verse]', '[Chorus]']);
});

/* -------------------------------------------------------------------------- */
/* B2. compile() and the §2.3 auto-chorus refrain                              */
/* -------------------------------------------------------------------------- */

s.test('compile lays out one tag line per block, lyrics under it, a blank line between', () => {
  const state = createStructureState();
  const intro = state.addBlock('Intro');
  const verse = state.addBlock('Verse');
  const bridge = state.addBlock('Bridge');
  state.setModifiers(intro, ['sparse']);
  state.setModifiers(verse, ['intimate', 'sparse']);
  state.setLyrics(verse, 'a line\nanother line');
  state.setModifiers(bridge, ['dark']);

  assert.strictEqual(
    state.compile(),
    ['[Intro - sparse]', '', '[Verse - intimate, sparse]', 'a line', 'another line', '', '[Bridge - dark]'].join('\n')
  );
});

s.test('a block whose lyrics are only whitespace compiles as a bare tag line', () => {
  const state = createStructureState();
  const id = state.addBlock('Verse');
  state.setLyrics(id, '   \n\n  ');
  assert.strictEqual(state.compile(), '[Verse]');
});

s.test('§2.3: a chorus with lyrics is repeated BEFORE a closing [Outro]', () => {
  const state = createStructureState();
  state.addBlock('Intro');
  const chorus = state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Outro');
  state.setLyrics(chorus, 'we run through neon rain');

  assert.strictEqual(
    state.compile(),
    [
      '[Intro]',
      '',
      '[Chorus]',
      'we run through neon rain',
      '',
      '[Verse]',
      '',
      '[Chorus]',
      'we run through neon rain',
      '',
      '[Outro]',
    ].join('\n')
  );
  const info = state.autoChorus();
  assert.strictEqual(info.applied, true);
  assert.strictEqual(info.sourceId, chorus);
  assert.strictEqual(info.lyrics, 'we run through neon rain');
});

s.test('§2.3: with [Outro] then [End], the refrain still goes before the [Outro]', () => {
  const state = createStructureState();
  const chorus = state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Outro');
  state.addBlock('End');
  state.setLyrics(chorus, 'hold the line');

  const lines = state.compile().split('\n');
  const outroAt = lines.indexOf('[Outro]');
  const endAt = lines.indexOf('[End]');
  const lastChorusAt = lines.lastIndexOf('[Chorus]');
  assert.ok(lastChorusAt < outroAt, 'the refrain must precede the outro');
  assert.ok(outroAt < endAt, 'the outro still precedes the end');
  assert.strictEqual(lines[lastChorusAt + 1], 'hold the line');
});

s.test('§2.3: with only an [End] and no outro, the refrain goes before the [End]', () => {
  const state = createStructureState();
  const chorus = state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('End');
  state.setLyrics(chorus, 'hold the line');
  const lines = state.compile().split('\n');
  assert.ok(lines.lastIndexOf('[Chorus]') < lines.indexOf('[End]'));
});

s.test('§2.3: with no outro and no end, the refrain is appended at the very end', () => {
  const state = createStructureState();
  const chorus = state.addBlock('Chorus');
  state.addBlock('Verse');
  state.setLyrics(chorus, 'hold the line');
  assert.strictEqual(
    state.compile(),
    ['[Chorus]', 'hold the line', '', '[Verse]', '', '[Chorus]', 'hold the line'].join('\n')
  );
  assert.strictEqual(state.autoChorus().index, 2);
});

s.test('§2.3: a flow that already ENDS on a chorus is never duplicated', () => {
  const state = createStructureState();
  state.addBlock('Verse');
  const chorus = state.addBlock('Chorus');
  state.setLyrics(chorus, 'hold the line');
  assert.strictEqual(state.compile(), ['[Verse]', '', '[Chorus]', 'hold the line'].join('\n'));
  assert.strictEqual(state.autoChorus().applied, false);

  // …and still not when the closing outro/end frame sits behind it.
  state.addBlock('Outro');
  state.addBlock('End');
  assert.strictEqual(state.autoChorus().applied, false, 'the outro/end frame is not the ending');
  assert.strictEqual((state.compile().match(/\[Chorus\]/g) || []).length, 1);
});

s.test('§2.3: a chorus with NO lyrics stored triggers nothing', () => {
  const state = createStructureState();
  state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Outro');
  assert.strictEqual(state.autoChorus().applied, false);
  assert.strictEqual(state.compile(), ['[Chorus]', '', '[Verse]', '', '[Outro]'].join('\n'));
});

s.test('§2.3: a flow with no chorus at all triggers nothing', () => {
  const state = createStructureState();
  const verse = state.addBlock('Verse');
  state.setLyrics(verse, 'a line');
  state.addBlock('Outro');
  assert.strictEqual(state.autoChorus().applied, false);
  assert.strictEqual(state.compile(), ['[Verse]', 'a line', '', '[Outro]'].join('\n'));
});

s.test('§2.3: with several choruses, the FIRST one with lyrics is the refrain', () => {
  const state = createStructureState();
  const empty = state.addBlock('Chorus');
  const first = state.addBlock('Chorus');
  const second = state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Outro');
  state.setLyrics(first, 'the first melody');
  state.setLyrics(second, 'a later variation');

  const info = state.autoChorus();
  assert.strictEqual(info.sourceId, first, 'the empty chorus cannot be the source');
  assert.notStrictEqual(info.sourceId, empty);
  assert.strictEqual(info.lyrics, 'the first melody');
  const lines = state.compile().split('\n');
  assert.strictEqual(lines[lines.lastIndexOf('[Chorus]') + 1], 'the first melody');
});

s.test('§2.3: the refrain carries the tag [Chorus] plainly, modifiers and number aside', () => {
  const state = createStructureState();
  const chorus = state.addBlock('Chorus');
  state.addBlock('Chorus');
  state.addBlock('Verse');
  state.addBlock('Outro');
  state.setModifiers(chorus, ['huge', 'wide']);
  state.setLyrics(chorus, 'the melody');

  const sheet = state.compile();
  assert.ok(sheet.indexOf('[Chorus 1 - huge, wide]') !== -1, 'the source block keeps its own tag');
  const lines = sheet.split('\n');
  assert.strictEqual(lines[lines.length - 4], '[Chorus]', 'the refrain is a bare [Chorus]');
  assert.strictEqual(lines[lines.length - 3], 'the melody');
  assert.strictEqual(lines[lines.length - 2], '', 'blocks stay separated by a blank line');
  assert.strictEqual(lines[lines.length - 1], '[Outro]');
});

s.test('the refrain follows the flow: reordering the outro moves it too', () => {
  const state = createStructureState();
  const chorus = state.addBlock('Chorus');
  const verse = state.addBlock('Verse');
  const outro = state.addBlock('Outro');
  state.setLyrics(chorus, 'the melody');
  assert.strictEqual(state.autoChorus().index, 2);

  state.moveBlock(outro, 0);
  // The outro is no longer the closing frame, so there is nothing to precede.
  assert.strictEqual(state.autoChorus().index, 3);
  const lines = state.compile().split('\n');
  assert.strictEqual(lines[0], '[Outro]');
  assert.strictEqual(lines[lines.length - 2], '[Chorus]');
  assert.strictEqual(lines[lines.length - 1], 'the melody');

  state.moveBlock(verse, 2);
  assert.strictEqual(state.blocks()[2].id, verse);
});

/* -------------------------------------------------------------------------- */
/* C. Undo / redo — FDD #40                                                   */
/* -------------------------------------------------------------------------- */

s.test('a fresh stack can neither undo nor redo, and holds nothing', () => {
  const stack = createHistoryStack();
  assert.strictEqual(stack.size(), 0);
  assert.strictEqual(stack.canUndo(), false);
  assert.strictEqual(stack.canRedo(), false);
  assert.strictEqual(stack.undo(), null);
  assert.strictEqual(stack.redo(), null);
  assert.strictEqual(stack.current(), null);
  assert.strictEqual(stack.limit(), 100);
});

s.test('one entry is a floor, not a step: there is still nothing to undo', () => {
  const stack = createHistoryStack();
  stack.push('a');
  assert.strictEqual(stack.size(), 1);
  assert.strictEqual(stack.canUndo(), false, 'the first state is where undo stops');
  assert.strictEqual(stack.canRedo(), false);
  assert.strictEqual(stack.undo(), null);
  assert.strictEqual(stack.current(), 'a');
});

s.test('undo and redo walk the same sequence in both directions', () => {
  const stack = createHistoryStack();
  ['a', 'b', 'c', 'd'].forEach((v) => stack.push(v));
  assert.strictEqual(stack.current(), 'd');

  assert.strictEqual(stack.undo(), 'c');
  assert.strictEqual(stack.undo(), 'b');
  assert.strictEqual(stack.undo(), 'a');
  assert.strictEqual(stack.canUndo(), false);
  assert.strictEqual(stack.undo(), null, 'the oldest state is the floor');

  assert.strictEqual(stack.redo(), 'b');
  assert.strictEqual(stack.redo(), 'c');
  assert.strictEqual(stack.redo(), 'd');
  assert.strictEqual(stack.canRedo(), false);
  assert.strictEqual(stack.redo(), null, 'the newest state is the ceiling');
  assert.strictEqual(stack.size(), 4, 'walking the stack never changes its size');
});

s.test('a push after an undo CLEARS the redo branch', () => {
  const stack = createHistoryStack();
  ['a', 'b', 'c'].forEach((v) => stack.push(v));
  stack.undo();
  stack.undo();
  assert.strictEqual(stack.current(), 'a');
  assert.strictEqual(stack.canRedo(), true);

  stack.push('x');
  assert.strictEqual(stack.canRedo(), false, 'the abandoned future must be gone');
  assert.strictEqual(stack.redo(), null);
  assert.strictEqual(stack.size(), 2, 'b and c were dropped, a and x remain');
  assert.strictEqual(stack.undo(), 'a');
  assert.strictEqual(stack.redo(), 'x');
});

s.test('at the limit the OLDEST entry is evicted and the cursor stays on the newest', () => {
  const stack = createHistoryStack(3);
  assert.strictEqual(stack.limit(), 3);
  ['a', 'b', 'c'].forEach((v) => stack.push(v));
  assert.strictEqual(stack.size(), 3);

  stack.push('d');
  assert.strictEqual(stack.size(), 3, 'the stack never grows past its limit');
  assert.strictEqual(stack.current(), 'd');
  assert.strictEqual(stack.undo(), 'c');
  assert.strictEqual(stack.undo(), 'b');
  assert.strictEqual(stack.undo(), null, 'a fell off the bottom');

  stack.push('e');
  stack.push('f');
  assert.strictEqual(stack.size(), 3);
  assert.strictEqual(stack.current(), 'f');
});

s.test('an unusable limit falls back to the default rather than to zero depth', () => {
  for (const bad of [0, -5, NaN, Infinity, null, undefined, 'ten', {}]) {
    assert.strictEqual(createHistoryStack(bad).limit(), 100, `limit ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(createHistoryStack(1).limit(), 1);
  assert.strictEqual(createHistoryStack(7.9).limit(), 7);
});

s.test('a limit of one keeps only the present, and undo has nowhere to go', () => {
  const stack = createHistoryStack(1);
  stack.push('a');
  stack.push('b');
  assert.strictEqual(stack.size(), 1);
  assert.strictEqual(stack.current(), 'b');
  assert.strictEqual(stack.canUndo(), false);
});

s.test('the stack carries structure snapshots end to end', () => {
  const state = createStructureState();
  const stack = createHistoryStack();
  stack.push(state.toJSON());

  state.addBlock('Intro');
  stack.push(state.toJSON());
  const chorus = state.addBlock('Chorus');
  state.setLyrics(chorus, 'the melody');
  stack.push(state.toJSON());
  assert.strictEqual(state.blocks().length, 2);

  state.fromJSON(stack.undo());
  deepEqual(flowOf(state), ['[Intro]']);
  state.fromJSON(stack.undo());
  deepEqual(flowOf(state), []);
  assert.strictEqual(stack.canUndo(), false);

  state.fromJSON(stack.redo());
  deepEqual(flowOf(state), ['[Intro]']);
  state.fromJSON(stack.redo());
  deepEqual(flowOf(state), ['[Intro]', '[Chorus]']);
  assert.strictEqual(state.blocks()[1].lyrics, 'the melody');
});

/* -------------------------------------------------------------------------- */
/* C2. The keybinding predicates                                              */
/* -------------------------------------------------------------------------- */

s.test('isTextEntryTarget guards every place text is really being edited', () => {
  assert.strictEqual(isTextEntryTarget({ tagName: 'TEXTAREA' }), true);
  assert.strictEqual(isTextEntryTarget({ tagName: 'textarea' }), true);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT', type: 'PASSWORD' }), true);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT' }), true, 'a type-less input is a text input');
  assert.strictEqual(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true }), true);
});

s.test('isTextEntryTarget does NOT stand aside for controls with no text to undo', () => {
  assert.strictEqual(isTextEntryTarget({ tagName: 'BUTTON' }), false);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.strictEqual(isTextEntryTarget({ tagName: 'INPUT', type: 'color' }), false);
  assert.strictEqual(isTextEntryTarget({ tagName: 'SELECT' }), false);
  assert.strictEqual(isTextEntryTarget({ tagName: 'DIV' }), false);
  assert.strictEqual(isTextEntryTarget(null), false);
  assert.strictEqual(isTextEntryTarget(undefined), false);
  assert.strictEqual(isTextEntryTarget('TEXTAREA'), false);
});

s.test('structureShortcut implements the FDD #40 keys, and only those', () => {
  assert.strictEqual(structureShortcut({ ctrlKey: true, key: 'z' }), 'undo');
  assert.strictEqual(structureShortcut({ ctrlKey: true, key: 'Z' }), 'undo');
  assert.strictEqual(structureShortcut({ metaKey: true, key: 'z' }), 'undo');
  assert.strictEqual(structureShortcut({ ctrlKey: true, key: 'y' }), 'redo');
  assert.strictEqual(structureShortcut({ ctrlKey: true, shiftKey: true, key: 'z' }), 'redo');
  assert.strictEqual(structureShortcut({ ctrlKey: true, shiftKey: true, key: 'Z' }), 'redo');

  assert.strictEqual(structureShortcut({ key: 'z' }), null, 'a bare z is a letter being typed');
  assert.strictEqual(structureShortcut({ ctrlKey: true, key: 'x' }), null);
  assert.strictEqual(structureShortcut({ ctrlKey: true, altKey: true, key: 'z' }), null);
  assert.strictEqual(structureShortcut({ ctrlKey: true, shiftKey: true, key: 'y' }), null);
  assert.strictEqual(structureShortcut(null), null);
  assert.strictEqual(structureShortcut({}), null);
});

s.test('structureMoveShortcut is Alt+Arrow, and never collides with undo/redo', () => {
  assert.strictEqual(structureMoveShortcut({ altKey: true, key: 'ArrowUp' }), -1);
  assert.strictEqual(structureMoveShortcut({ altKey: true, key: 'ArrowDown' }), 1);
  assert.strictEqual(structureMoveShortcut({ key: 'ArrowUp' }), 0);
  assert.strictEqual(structureMoveShortcut({ altKey: true, ctrlKey: true, key: 'ArrowUp' }), 0);
  assert.strictEqual(structureMoveShortcut({ altKey: true, shiftKey: true, key: 'ArrowDown' }), 0);
  assert.strictEqual(structureMoveShortcut({ altKey: true, key: 'ArrowLeft' }), 0);
  assert.strictEqual(structureMoveShortcut({ altKey: true, key: 'z' }), 0);
  assert.strictEqual(structureMoveShortcut(null), 0);
  // The two predicates are disjoint by construction.
  const altZ = { altKey: true, ctrlKey: true, key: 'z' };
  assert.strictEqual(structureShortcut(altZ), null);
  assert.strictEqual(structureMoveShortcut(altZ), 0);
});

/* -------------------------------------------------------------------------- */
/* D. Static markup and CSS contracts                                         */
/* -------------------------------------------------------------------------- */

s.test('the structure card lives in the Editor view, above the prompt draft', () => {
  const editor = readEditorMarkup();
  const structureAt = editor.indexOf('id="structure-heading"');
  const draftAt = editor.indexOf('id="draft-heading"');
  assert.ok(structureAt !== -1, 'the Song structure card is missing from the Editor view');
  assert.ok(draftAt !== -1, 'the Prompt draft card is missing from the Editor view');
  assert.ok(structureAt < draftAt, 'the structure card must come before the prompt draft');
  assert.ok(
    /aria-labelledby="structure-heading"/.test(editor),
    'the card must be labelled by its own heading'
  );
});

s.test('the metatag library is a labelled group with a row per §3.1 list', () => {
  const editor = readEditorMarkup();
  assert.ok(
    /class="structure-palette"[^>]*role="group"[^>]*aria-label="Suno v5\.5 metatag library"/.test(editor),
    'the palette must be a labelled group'
  );
  for (const id of ['structure-core', 'structure-action']) {
    assert.ok(editor.indexOf(`id="${id}"`) !== -1, `#${id} is missing`);
  }
  assert.ok(/id="structure-core"[^>]*aria-labelledby="structure-core-label"/.test(editor));
  assert.ok(/id="structure-action"[^>]*aria-labelledby="structure-action-label"/.test(editor));
});

s.test('undo and redo are real disabled-at-rest buttons that announce their keys', () => {
  const editor = readEditorMarkup();
  const undo = /<button[^>]*id="btn-undo"[^>]*>/.exec(editor);
  const redo = /<button[^>]*id="btn-redo"[^>]*>/.exec(editor);
  assert.ok(undo, '#btn-undo is missing');
  assert.ok(redo, '#btn-redo is missing');
  assert.ok(/\bdisabled\b/.test(undo[0]), 'undo must start disabled — there is nothing to undo yet');
  assert.ok(/\bdisabled\b/.test(redo[0]), 'redo must start disabled');
  assert.ok(/aria-keyshortcuts="Control\+Z"/.test(undo[0]), 'undo must announce Ctrl+Z (FDD #40)');
  assert.ok(
    /aria-keyshortcuts="Control\+Y Control\+Shift\+Z"/.test(redo[0]),
    'redo must announce Ctrl+Y and the Ctrl+Shift+Z alias'
  );
});

s.test('the card states its empty case, its live region and its plain counts', () => {
  const editor = readEditorMarkup();
  assert.ok(
    /id="structure-empty"[\s\S]{0,200}No blocks yet/.test(editor),
    'the empty state must say so plainly'
  );
  assert.ok(
    /id="structure-status"[^>]*role="status"[^>]*aria-live="polite"/.test(editor),
    'the discrete actions must be announced'
  );
  assert.ok(editor.indexOf('id="structure-counts"') !== -1, 'the character count is missing');

  const cardStart = editor.indexOf('id="structure-heading"');
  const cardEnd = editor.indexOf('id="draft-heading"');
  const card = editor.slice(cardStart, cardEnd);
  // Honesty check: nothing here enforces a budget, so nothing here may claim one.
  assert.ok(
    !/1,?000/.test(card),
    'the structure card must not mention a 1,000-character budget — nothing enforces one yet'
  );
});

s.test('the compiled sheet is a labelled read-only region with its own copy button', () => {
  const editor = readEditorMarkup();
  assert.ok(
    /<pre id="structure-preview"[^>]*aria-labelledby="structure-preview-heading"/.test(editor),
    'the preview must be labelled by its heading'
  );
  assert.ok(/<pre id="structure-preview"/.test(editor), 'the preview must be a <pre>');
  assert.ok(
    editor.indexOf('id="btn-structure-copy"') !== -1,
    'the structure sheet needs its own copy button (FDD #70)'
  );
  assert.ok(
    editor.indexOf('id="structure-refrain-note"') !== -1,
    'the auto-chorus refrain must be explained where it appears'
  );
});

s.test('the block list is an ordered list — a song flow is an order', () => {
  const editor = readEditorMarkup();
  assert.ok(
    /<ol id="structure-blocks"[^>]*aria-label="Song flow blocks"/.test(editor),
    'the flow must be a labelled <ol>'
  );
});

s.test('every rendered block ships a drag handle, both move buttons and a focus key', () => {
  const source = extractScriptById(INDEX, 'app-main');
  const start = source.indexOf('function buildBlock(');
  assert.ok(start !== -1, 'buildBlock is missing from the boot code');
  const body = source.slice(start, start + 6000);

  assert.ok(/className = 'structure-handle'/.test(body), 'no drag handle is built');
  assert.ok(/li\.draggable = true/.test(body), 'the row never becomes draggable');
  assert.ok(/'dragstart'/.test(body), 'no dragstart listener on a block');
  assert.ok(/textContent = 'Move up'/.test(body), 'no Move up button');
  assert.ok(/textContent = 'Move down'/.test(body), 'no Move down button');
  assert.ok(/textContent = 'Remove'/.test(body), 'no Remove button');
  // Every control carries the stable focus key the rebuild restores focus by.
  for (const key of ['handle:', 'up:', 'down:', 'remove:', 'mods:', 'lyrics:']) {
    assert.ok(
      body.indexOf(`FOCUS_KEY_ATTR, '${key}'`) !== -1,
      `the ${key} control carries no stable focus key`
    );
  }
});

s.test('the drop path commits through moveBlock, and the list marks the insertion point', () => {
  const source = extractScriptById(INDEX, 'app-main');
  assert.ok(/addEventListener\('dragover'/.test(source), 'no dragover handler');
  assert.ok(/addEventListener\('drop'/.test(source), 'no drop handler');
  assert.ok(/is-drop-before/.test(source) && /is-drop-after/.test(source), 'no insertion indicator');
  const drop = source.slice(source.indexOf("addEventListener('drop'"));
  assert.ok(
    /asOneStep\(function \(\) \{\s*moved = structure\.moveBlock\(id, to\);/.test(drop),
    'a drop must commit exactly one undo step through moveBlock'
  );
});

s.test('THE GUARD: the undo keys stand aside for any text field', () => {
  const source = extractScriptById(INDEX, 'app-main');
  const start = source.indexOf('const action = structureShortcut(event);');
  assert.ok(start !== -1, 'the keydown handler never consults structureShortcut');
  const body = source.slice(start, start + 500);
  assert.ok(
    body.indexOf('if (isTextEntryTarget(event.target)) return;') !== -1,
    'the keydown handler must return early for a text input/textarea/contenteditable, ' +
      'so the browser keeps its own undo while lyrics are being typed'
  );
  assert.ok(
    source.indexOf("viewManager.current() !== 'editor'") !== -1,
    'the shortcuts must only be live while the Prompt Editor is the showing view'
  );
});

s.test('the structure card is token-only: no colour literal escaped into its CSS', () => {
  const css = readStyle();
  const selectors = [
    '.structure-block {',
    '.structure-handle {',
    '.structure-tag {',
    '.structure-lyrics {',
    '.structure-preview {',
    '.structure-mods-note {',
    '.btn-mini[disabled] {',
    'kbd {',
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

s.test('the disabled Undo is dimmed with tokens, never with opacity', () => {
  const css = readStyle();
  const start = css.indexOf('.btn-mini[disabled] {');
  const body = css.slice(start, css.indexOf('}', start));
  assert.ok(
    !/opacity/.test(body),
    'a faded control is the first thing Code Mode would lose; use colour and border style'
  );
  assert.ok(/border-style:\s*dashed/.test(body), 'the disabled state needs a non-colour signal too');
});

s.test('the structure card is container-query aware, like every other panel', () => {
  const css = readStyle();
  assert.ok(
    /\.structure-panel,?[\s\S]{0,80}container-name:\s*dissector/.test(css),
    '.structure-panel must join the dissector container so it reflows on its own width'
  );
  const narrow = /@container\s+dissector\s*\(max-width:\s*520px\)\s*\{([\s\S]*?)\n  \}/.exec(css);
  assert.ok(narrow, 'no narrow @container dissector rule');
  assert.ok(
    /\.structure-block-head\s*\{[^}]*flex-direction:\s*column/.test(narrow[1]),
    'a narrow block must stack its head rather than squeezing four controls onto one line'
  );

  const media = css.match(/@media[^{]+/g) || [];
  for (const rule of media) {
    assert.ok(/prefers-/.test(rule), `@media is reserved for user preferences; found: ${rule.trim()}`);
  }
});

s.test('Code Mode flattens the structure card too', () => {
  const css = readStyle();
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(
    /\.high-contrast \.structure-block/.test(contrast),
    'the block surface is a translucent wash; Code Mode must flatten it'
  );
  assert.ok(
    /\.high-contrast \.structure-lyrics/.test(contrast),
    'the lyric box is a translucent wash; Code Mode must flatten it'
  );
});

s.finish();

module.exports = { loadAppSandbox, readEditorMarkup, readStyle, SPEC_CORE_TAGS, SPEC_ACTION_TAGS };
