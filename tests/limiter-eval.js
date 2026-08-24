'use strict';

/*
 * tests/limiter-eval.js — the prompt character budget (SunoPrompt Studio,
 * Suno v5.5 compiled STYLE prompt).
 *
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------
 * The fifteen contracts below were declared as todos in the release before
 * the limiter existed. They are now all REAL tests, run against the real
 * functions in index.html — `limitPrompt`, `compileStylePrompt` and
 * `buildFinalPrompt` — pulled out of the single-file bundle and evaluated in
 * a node:vm sandbox. Nothing here re-implements the limiter locally and
 * nothing is stubbed: a fake local copy would prove only that the copy works.
 *
 * The contracts come from:
 *   - CLAUDE.md, "Strict 1,000-Character Ceiling: Suno v5.5 prompt limits
 *     must never be exceeded under any input configuration";
 *   - docs/FDD.md #67 (Strict 1,000-Character Gauge) and the FDD header;
 *   - docs/FEATURE-MECHANICS.md §3.3 — the `[Exclude: ...]` block must be
 *     "a single bracketed block at the very end of the prompt string";
 *   - docs/PHP-SQLITE-QUALITY-CHECKLIST.md — "checked on every state change
 *     and trim at word boundaries".
 *
 * WHAT IS SOMEBODY ELSE'S FILE
 * ---------------------------------------------------------------------
 * The weighting order (#73), the conflict rules table (#68), the shield's own
 * store (#30) and the gauge's markup live in tests/compiler.test.js. This file
 * is only about the CEILING and what trimming to it is allowed to do.
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
  return { sandbox, source };
}

const app = loadAppSandbox();
const {
  createPromptState,
  sliderTags,
  compileStylePrompt,
  limitPrompt,
  buildFinalPrompt,
  normalizeExclusion,
  MUSIC_KB,
  PROMPT_CHAR_LIMIT,
  EXCLUDE_OPEN,
  EXCLUSION_MAX_LEN,
  SLIDER_AXES,
} = app.sandbox;

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/*
 * Values built inside the vm carry THAT realm's %Array.prototype%, so
 * deepStrictEqual against a literal written here fails on prototype identity
 * even when every element matches. Round-tripping through JSON rebuilds them
 * with this realm's intrinsics — and asserts in passing that everything the
 * pipeline hands out is plain, serialisable data.
 */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(host(actual), host(expected), message);
}

/* -------------------------------------------------------------------------- */
/* Fixtures — real state, built the way the UI builds it                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything the app can offer, all at once: every genre token, instrument,
 * mood and era in the knowledge base, every scene's production tokens, and all
 * three physical sliders pinned hard over. This is the "maximal tag selection"
 * the first contract asks for — and it is built through the real store, so the
 * store's own de-duplication applies exactly as it would on screen.
 *
 * @returns {object} a live prompt store
 */
function maximalState() {
  const state = createPromptState();
  state.batch(function () {
    for (const genre of MUSIC_KB.genres) {
      for (const token of genre.tokens) {
        state.add({ section: 'genre', tag: token.tag, weight: token.weight, source: 'dissector' });
      }
      for (const instrument of genre.instruments) {
        state.add({ section: 'instrument', tag: instrument, source: 'dissector' });
      }
      for (const mood of genre.moods) state.add({ section: 'mood', tag: mood, source: 'dissector' });
      for (const era of genre.eras) state.add({ section: 'era', tag: era, source: 'dissector' });
    }
    for (const scene of MUSIC_KB.scenes) {
      for (const token of scene.tokens) {
        state.add({ section: 'scene', tag: token.tag, weight: token.weight, source: 'scene' });
      }
    }
    for (const era of MUSIC_KB.eras) {
      for (const token of era.tokens) {
        state.add({ section: 'era', tag: token.tag, weight: token.weight, source: 'dissector' });
      }
    }
    // A full slider sweep: every axis parked at an extreme, which is the most
    // words the three of them can contribute at once.
    state.setSource('slider-energy', sliderTags('energy', 100));
    state.setSource('slider-warmth', sliderTags('warmth', 0));
    state.setSource('slider-density', sliderTags('density', 100));
  });
  return state;
}

/** A small, obviously-under-budget selection. */
function smallState() {
  const state = createPromptState();
  state.batch(function () {
    state.add({ section: 'genre', tag: 'french electro', weight: 0.9, source: 'dissector' });
    state.add({ section: 'genre', tag: 'techno', weight: 0.6, source: 'dissector' });
    state.add({ section: 'mood', tag: 'hypnotic', source: 'dissector' });
    state.add({ section: 'instrument', tag: 'TR-909 kick', source: 'dissector' });
  });
  return state;
}

/** A store whose descriptive tags alone run far past the ceiling. */
function overStuffedState(count) {
  const state = createPromptState();
  state.batch(function () {
    for (let i = 0; i < (count || 200); i += 1) {
      state.add({ section: 'custom', tag: 'atmospheric texture layer number ' + i, source: 'manual' });
    }
  });
  return state;
}

/** Words of a compiled prompt, as the contract defines them: the pieces left
 *  when the string is split on whitespace and commas. */
function wordsOf(text) {
  return String(text)
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Build a string of EXACTLY `n` characters that looks like a compiled prompt:
 * comma-separated tags, no leading or trailing whitespace, the last tag padded
 * so the total lands on the boundary being tested rather than near it.
 */
function exactLengthPrompt(n) {
  const parts = [];
  let length = 0;
  let i = 0;
  for (;;) {
    const tag = 'texture' + i;
    const cost = (length ? 2 : 0) + tag.length;
    if (length + cost > n) break;
    parts.push(tag);
    length += cost;
    i += 1;
  }
  let text = parts.join(', ');
  if (text.length < n) text += 'x'.repeat(n - text.length);
  assert.strictEqual(text.length, n, 'the fixture itself must be exactly n characters');
  return text;
}

const s = suite('limiter-eval (prompt character budget)');

/* -------------------------------------------------------------------------- */
/* Reachability                                                               */
/* -------------------------------------------------------------------------- */

s.test('the whole compiler pipeline is reachable as top-level functions', () => {
  for (const name of [
    'weightTokens',
    'resolveConflicts',
    'compileStylePrompt',
    'limitPrompt',
    'buildFinalPrompt',
    'promptBudgetZone',
    'normalizeExclusion',
    'normalizeExclusionList',
    'createExclusionState',
  ]) {
    assert.strictEqual(
      vm.runInContext(`typeof ${name}`, app.sandbox, { filename: 'app-main#probe' }),
      'function',
      `${name} must be a top-level function declaration, before the boot IIFE`
    );
  }
  assert.strictEqual(PROMPT_CHAR_LIMIT, 1000, 'the Suno v5.5 style ceiling is 1,000 characters');
});

/* -------------------------------------------------------------------------- */
/* 1. The ceiling itself                                                      */
/* -------------------------------------------------------------------------- */

s.test('compiled prompt length never exceeds 1000 chars for a maximal tag selection', () => {
  const state = maximalState();
  const untrimmed = compileStylePrompt(state, []);

  // Precondition: this really is a selection that BLOWS the budget. Without
  // it a limiter that did nothing at all would pass.
  assert.ok(
    untrimmed.text.length > PROMPT_CHAR_LIMIT * 3,
    `the fixture must be far over budget to be a real test; it is ${untrimmed.text.length}`
  );

  const final = buildFinalPrompt(state, []);
  assert.ok(
    final.text.length <= PROMPT_CHAR_LIMIT,
    `maximal selection compiled to ${final.text.length} characters`
  );
  assert.strictEqual(final.length, final.text.length, 'the reported length must be the real one');
  assert.strictEqual(final.trimmed, true, 'a trim this large must be reported as a trim');
  assert.ok(final.droppedTags.length > 0, 'the dropped tags must be named, not silently vanish');

  // …and again with the shield on, which is the configuration that actually
  // ships: "never exceeded under ANY input configuration" (CLAUDE.md).
  const shielded = buildFinalPrompt(state, ['harsh noise', 'male vocals', 'autotune']);
  assert.ok(
    shielded.text.length <= PROMPT_CHAR_LIMIT,
    `maximal selection + shield compiled to ${shielded.text.length} characters`
  );
});

/* -------------------------------------------------------------------------- */
/* 2-4. Recomputed on EVERY state change                                      */
/* -------------------------------------------------------------------------- */

s.test('budget is recomputed and enforced on every state change (add tag)', () => {
  const state = smallState();
  const before = buildFinalPrompt(state, []);
  assert.strictEqual(before.trimmed, false);

  // A single added tag has to move the compiled string AND its length.
  state.add({ section: 'mood', tag: 'euphoric', source: 'manual' });
  const after = buildFinalPrompt(state, []);
  assert.notStrictEqual(after.text, before.text, 'adding a tag must change the compiled prompt');
  assert.strictEqual(after.length, after.text.length);
  assert.strictEqual(after.length, before.length + ', euphoric'.length);
  assert.ok(after.text.indexOf('euphoric') !== -1);

  // Adding enough to blow the budget must ENFORCE it, not merely report it.
  state.batch(function () {
    for (let i = 0; i < 200; i += 1) {
      state.add({ section: 'custom', tag: 'atmospheric texture layer number ' + i, source: 'manual' });
    }
  });
  const over = buildFinalPrompt(state, []);
  assert.ok(over.text.length <= PROMPT_CHAR_LIMIT, `${over.text.length} characters after the adds`);
  assert.strictEqual(over.trimmed, true);

  // The UI is wired to that recomputation rather than to a one-off compile.
  const html = readIndex();
  assert.ok(
    html.indexOf('promptState.subscribe(renderStylePrompt)') !== -1,
    'the style-prompt panel must SUBSCRIBE to the prompt store, or it would only ever compile once'
  );
});

s.test('budget is recomputed and enforced on every state change (remove tag)', () => {
  const state = overStuffedState(200);
  const trimmed = buildFinalPrompt(state, []);
  assert.strictEqual(trimmed.trimmed, true, 'precondition: the fixture is over budget');
  const droppedWhileFull = trimmed.droppedTags.length;
  assert.ok(droppedWhileFull > 0);

  // Take almost everything back out; the prompt must be allowed to GROW BACK
  // into the space, not stay stuck at whatever it was trimmed to.
  const entries = state.list();
  state.batch(function () {
    for (let i = 5; i < entries.length; i += 1) state.remove(entries[i].id);
  });

  const after = buildFinalPrompt(state, []);
  assert.strictEqual(after.trimmed, false, 'a prompt back under budget must stop being trimmed');
  deepEqual(after.droppedTags, [], 'nothing is dropped once everything fits');
  assert.strictEqual(after.length, after.text.length);
  assert.ok(after.length < trimmed.length, 'the shorter selection must compile shorter');
  assert.strictEqual(after.text, state.list().map((e) => e.tag).join(', '));

  // Removing one more tag moves it again — the recompute is per change.
  const one = state.list()[0];
  const beforeOne = buildFinalPrompt(state, []).length;
  state.remove(one.id);
  assert.strictEqual(buildFinalPrompt(state, []).length, beforeOne - (one.tag.length + 2));
});

s.test('budget is recomputed and enforced on every state change (slider move)', () => {
  const state = smallState();
  const neutral = buildFinalPrompt(state, []);

  // Hard over: the §4.1 high set joins the prompt and the count moves with it.
  state.setSource('slider-energy', sliderTags('energy', 95));
  const hot = buildFinalPrompt(state, []);
  assert.ok(hot.length > neutral.length, 'a slider at an extreme must lengthen the prompt');
  assert.ok(hot.text.indexOf('high energy') !== -1, hot.text);

  // Back to the neutral band: the axis contributes nothing and the count
  // returns to exactly where it started.
  state.setSource('slider-energy', sliderTags('energy', 50));
  const back = buildFinalPrompt(state, []);
  assert.strictEqual(back.text, neutral.text, 'a slider returned to neutral must undo itself');
  assert.strictEqual(back.length, neutral.length);

  // A full sweep on all three axes on top of an over-budget selection still
  // lands inside the ceiling.
  const big = overStuffedState(200);
  for (const axis of SLIDER_AXES) big.setSource('slider-' + axis, sliderTags(axis, 100));
  const swept = buildFinalPrompt(big, []);
  assert.ok(swept.text.length <= PROMPT_CHAR_LIMIT, `${swept.text.length} characters after the sweep`);

  // The three range inputs drive that same store, and the panel repaints from
  // the store — so a drag really does re-run the limiter.
  const html = readIndex();
  assert.ok(
    html.indexOf('promptState.setSource(source, tags)') !== -1,
    'a slider must write into the prompt store'
  );
  assert.ok(
    html.indexOf('promptState.subscribe(renderStylePrompt)') !== -1,
    'and the gauge must repaint from that store'
  );
});

/* -------------------------------------------------------------------------- */
/* 5-8. What trimming may and may not do to the string                        */
/* -------------------------------------------------------------------------- */

s.test('a prompt already under the 1000-char budget is returned byte-identical (no gratuitous trimming)', () => {
  const compiled = compileStylePrompt(smallState(), ['harsh noise']);
  assert.ok(compiled.text.length < PROMPT_CHAR_LIMIT, 'precondition: the fixture is under budget');

  const limited = limitPrompt(compiled.text);
  // Identity, not equality of length: not one character may be rewritten.
  assert.strictEqual(limited.text, compiled.text);
  assert.strictEqual(limited.trimmed, false);
  deepEqual(limited.droppedTags, []);

  // Including the exact boundary, and including a string with no commas at all.
  for (const text of [exactLengthPrompt(999), exactLengthPrompt(1000), 'one solitary tag']) {
    assert.strictEqual(limitPrompt(text).text, text, `"${text.slice(0, 30)}…" was rewritten`);
  }
});

s.test('trimming never splits a word: every word remaining in the output is a whole word from the input', () => {
  const input = compileStylePrompt(overStuffedState(200), ['harsh noise', 'male vocals']).text;
  assert.ok(input.length > PROMPT_CHAR_LIMIT, 'precondition: over budget');

  const output = limitPrompt(input).text;
  const inputWords = new Set(wordsOf(input));
  const outputWords = wordsOf(output);
  assert.ok(outputWords.length > 0, 'the trim must not empty the prompt');
  for (const word of outputWords) {
    assert.ok(
      inputWords.has(word),
      `"${word}" is not a whole word from the input — the cut split something`
    );
  }

  // Fragments are the failure mode this is really guarding: the last surviving
  // word must be one the input actually contained, not a prefix of one.
  const last = outputWords[outputWords.length - 1];
  assert.ok(inputWords.has(last), `the final word "${last}" is a fragment`);

  // Repeat at a range of ceilings so the assertion is not an accident of 1000.
  for (const max of [37, 120, 501, 999]) {
    const cut = limitPrompt(input, max);
    assert.ok(cut.text.length <= max, `${cut.text.length} > ${max}`);
    for (const word of wordsOf(cut.text)) {
      assert.ok(inputWords.has(word), `max=${max}: "${word}" is a fragment`);
    }
  }
});

s.test('trimming removes any orphaned separator (dangling ", " or trailing comma) left behind by the cut', () => {
  const inputs = [
    compileStylePrompt(overStuffedState(200), []).text,
    compileStylePrompt(overStuffedState(200), ['harsh noise']).text,
    exactLengthPrompt(1400),
  ];
  for (const input of inputs) {
    for (const max of [40, 137, 500, 1000]) {
      const out = limitPrompt(input, max).text;
      assert.ok(!/,\s*$/.test(out), `max=${max}: a dangling separator survived: …${out.slice(-24)}`);
      assert.strictEqual(out.indexOf(', ,'), -1, `max=${max}: a doubled separator at the cut`);
      assert.strictEqual(out.indexOf(',,'), -1, `max=${max}: a doubled comma at the cut`);
      assert.ok(!/,\s*\]/.test(out), `max=${max}: an orphaned comma inside the exclusion block`);
    }
  }
});

s.test('compiled result has no leading or trailing whitespace', () => {
  const cases = [
    compileStylePrompt(smallState(), []).text,
    compileStylePrompt(smallState(), ['harsh noise']).text,
    compileStylePrompt(overStuffedState(200), ['harsh noise']).text,
    exactLengthPrompt(1000),
    exactLengthPrompt(1001),
    '   padded on both ends   ',
    '  ' + exactLengthPrompt(1200) + '  ',
  ];
  for (const text of cases) {
    for (const max of [1000, 250, 41]) {
      const out = limitPrompt(text, max).text;
      assert.strictEqual(out.length, out.trim().length, `max=${max}: "${out.slice(0, 20)}…" is padded`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 9-12. The Negative Tag Shield through the limiter (§3.3)                   */
/* -------------------------------------------------------------------------- */

s.test('[Exclude: ...] block is the final element of the compiled prompt when exclusions are present', () => {
  const compiled = compileStylePrompt(smallState(), ['harsh noise', 'male vocals', 'acoustic guitars']);
  const text = compiled.text;

  assert.ok(text.endsWith(']'), `the prompt must end with the block: …${text.slice(-40)}`);
  const start = text.lastIndexOf(EXCLUDE_OPEN);
  assert.ok(start > 0, 'the block must exist and must not be the whole prompt');
  assert.strictEqual(
    text.slice(start),
    '[Exclude: harsh noise, male vocals, acoustic guitars]',
    'the shield must be ONE bracketed, comma-separated block (FEATURE-MECHANICS.md §3.3)'
  );

  // One block, never one per term.
  assert.strictEqual(text.split(EXCLUDE_OPEN).length - 1, 1, 'more than one [Exclude: block');
  // …and every descriptive tag really is in front of it.
  for (const tag of compiled.meta.tags) {
    assert.ok(text.indexOf(tag) < start, `"${tag}" is inside or behind the exclusion block`);
  }
});

s.test('[Exclude: ...] block survives trimming of an over-budget prompt and remains the last element', () => {
  const terms = ['harsh noise', 'male vocals', 'acoustic guitars', 'autotune'];
  const state = overStuffedState(200);
  const compiled = compileStylePrompt(state, terms);
  assert.ok(compiled.text.length > PROMPT_CHAR_LIMIT * 3, 'precondition: the tags alone blow the budget');

  const limited = limitPrompt(compiled.text);
  assert.ok(limited.text.length <= PROMPT_CHAR_LIMIT, `${limited.text.length} characters`);
  assert.ok(limited.text.endsWith(']'), 'the block must still close the prompt');
  assert.strictEqual(
    limited.text.slice(limited.text.lastIndexOf(EXCLUDE_OPEN)),
    '[Exclude: ' + terms.join(', ') + ']',
    'the shield must survive intact — descriptive tags are sacrificed first'
  );
  deepEqual(limited.droppedExclusions, [], 'no exclusion needed to go');
  assert.ok(limited.droppedTags.length > 100, 'the descriptive tags are what paid for it');

  // A descriptive tag DID survive in front of it — the shield did not eat the
  // whole prompt.
  const head = limited.text.slice(0, limited.text.lastIndexOf(EXCLUDE_OPEN)).trim();
  assert.ok(head.length > 0, 'every descriptive tag was sacrificed unnecessarily');
  assert.ok(head.indexOf('atmospheric texture layer number 0') === 0, head.slice(0, 60));
});

s.test('the exclusion block itself remains syntactically well-formed if it must be shortened', () => {
  // The pathological case: forty maximum-length exclusions, whose block alone
  // is well past the ceiling, so the shield cannot survive whole.
  const terms = [];
  for (let i = 0; i < 40; i += 1) {
    // Short enough to survive the EXCLUSION_MAX_LEN cap intact — a term that
    // was truncated would lose the digits that make it distinct, and forty
    // exclusions would silently de-duplicate down to four.
    terms.push('unwanted production trait ' + String(i).padStart(3, '0'));
  }
  const compiled = compileStylePrompt(overStuffedState(50), terms);
  assert.ok(
    compiled.meta.excludeBlock.length > PROMPT_CHAR_LIMIT,
    `precondition: the block alone must exceed the ceiling; it is ${compiled.meta.excludeBlock.length}`
  );

  const limited = limitPrompt(compiled.text);
  const text = limited.text;
  assert.ok(text.length <= PROMPT_CHAR_LIMIT, `${text.length} characters`);
  assert.ok(text.indexOf(EXCLUDE_OPEN) === 0, `the block must open the result: ${text.slice(0, 24)}`);
  assert.ok(text.endsWith(']'), 'the block must still be closed');
  assert.strictEqual(text.indexOf(']'), text.length - 1, 'the only ] must be the closing one');
  assert.notStrictEqual(text, '[Exclude: ]', 'an empty block is not a well-formed one');

  // No half-written term inside: every surviving term is one of the originals,
  // whole, and the ones that went are reported.
  const inner = text.slice(EXCLUDE_OPEN.length, text.length - 1);
  const kept = inner.split(', ');
  const original = terms.map((t) => normalizeExclusion(t));
  for (const term of kept) {
    assert.ok(original.indexOf(term) !== -1, `"${term}" is a fragment of an exclusion, not one`);
  }
  assert.ok(kept.length > 0, 'at least one term must survive');
  assert.strictEqual(
    kept.length + limited.droppedExclusions.length,
    original.length,
    'every exclusion must be either kept or reported as dropped'
  );
  // Trimmed from the END, never re-ordered to squeeze a short one in.
  deepEqual(kept, original.slice(0, kept.length));
  deepEqual(limited.droppedExclusions, original.slice(kept.length));
});

s.test('a prompt with no exclusions produces no empty "[Exclude: ]" artefact', () => {
  for (const exclusions of [[], undefined, null, ['', '   '], ['[]', ',,,']]) {
    const compiled = compileStylePrompt(smallState(), exclusions);
    assert.strictEqual(
      compiled.text.indexOf('[Exclude:'),
      -1,
      `zero usable exclusions still produced a block: ${compiled.text}`
    );
    assert.strictEqual(compiled.meta.excludeBlock, '');
    assert.strictEqual(compiled.text.indexOf('['), -1, 'no stray bracket at all');
  }

  // And the same after a trim: an over-budget prompt with no shield must not
  // grow one on the way through the limiter.
  const big = compileStylePrompt(overStuffedState(200), []);
  const limited = limitPrompt(big.text);
  assert.strictEqual(limited.text.indexOf('[Exclude:'), -1, limited.text.slice(-40));
  assert.ok(limited.text.length <= PROMPT_CHAR_LIMIT);
});

/* -------------------------------------------------------------------------- */
/* 13-14. The boundary, from both sides                                       */
/* -------------------------------------------------------------------------- */

s.test('boundary: a compiled prompt of exactly 1000 chars is accepted unmodified', () => {
  const text = exactLengthPrompt(PROMPT_CHAR_LIMIT);
  assert.strictEqual(text.length, 1000);

  const limited = limitPrompt(text);
  // Equality, not just "<= 1000": 1000 is inside the budget, not over it.
  assert.strictEqual(limited.text, text, 'an exactly-full prompt was modified');
  assert.strictEqual(limited.text.length, 1000);
  assert.strictEqual(limited.trimmed, false);
  deepEqual(limited.droppedTags, []);

  // The same at the boundary WITH a shield, where the block must not be
  // re-flowed either.
  const shield = ' [Exclude: harsh noise, autotune]';
  const withShield = exactLengthPrompt(PROMPT_CHAR_LIMIT - shield.length) + shield;
  assert.strictEqual(withShield.length, 1000);
  assert.strictEqual(limitPrompt(withShield).text, withShield);
  assert.strictEqual(limitPrompt(withShield).trimmed, false);
});

s.test('boundary: a compiled prompt of 1001 chars is trimmed to <= 1000', () => {
  const text = exactLengthPrompt(PROMPT_CHAR_LIMIT + 1);
  assert.strictEqual(text.length, 1001);

  const limited = limitPrompt(text);
  assert.ok(limited.text.length <= PROMPT_CHAR_LIMIT, `${limited.text.length} characters`);
  assert.strictEqual(limited.trimmed, true, 'one character over is still over');

  // The cut lands on a word boundary: the surviving text is a prefix of the
  // input, and the character immediately after it is a separator — so nothing
  // was cut through the middle of a word.
  assert.strictEqual(text.indexOf(limited.text), 0, 'the output must be a prefix of the input');
  const next = text.charAt(limited.text.length);
  assert.ok(/[\s,]/.test(next), `the cut landed mid-word, on "${next}"`);
  const words = new Set(wordsOf(text));
  for (const word of wordsOf(limited.text)) assert.ok(words.has(word), `"${word}" is a fragment`);
  assert.ok(limited.droppedTags.length > 0, 'whatever went must be named');
});

/* -------------------------------------------------------------------------- */
/* 15. Unicode                                                                */
/* -------------------------------------------------------------------------- */

s.test('unicode / multi-byte characters are counted as JS UTF-16 string length units consistently', () => {
  // café  — an accented letter, 1 UTF-16 unit
  // 東京   — CJK, 1 unit each
  // 🎧    — outside the BMP, a SURROGATE PAIR, 2 units
  const state = createPromptState();
  state.batch(function () {
    for (let i = 0; i < 140; i += 1) {
      state.add({ section: 'custom', tag: 'café 東京 🎧 texture ' + i, source: 'manual' });
    }
  });

  const compiled = compileStylePrompt(state, ['🎤 harsh noise', 'café vocals']);
  assert.ok(compiled.text.length > PROMPT_CHAR_LIMIT, 'precondition: over budget');

  const limited = limitPrompt(compiled.text);
  // The budget is .length — UTF-16 code units — for multi-byte text exactly as
  // it is for ASCII. An emoji costs 2 and is budgeted as 2.
  assert.ok(limited.text.length <= PROMPT_CHAR_LIMIT, `${limited.text.length} code units`);
  assert.ok(limited.text.length > PROMPT_CHAR_LIMIT - 60, 'the budget must be spent, not abandoned');
  assert.strictEqual('🎧'.length, 2, 'sanity: the fixture really does carry a surrogate pair');

  // NO OFF-BY-SURROGATE-PAIR ERROR. Two independent checks:
  //   1. the engine's own well-formedness test — a lone surrogate fails it;
  assert.ok(limited.text.isWellFormed(), 'the cut split a surrogate pair');
  //   2. manual code-unit inspection, so this holds even without isWellFormed.
  for (let i = 0; i < limited.text.length; i += 1) {
    const unit = limited.text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = limited.text.charCodeAt(i + 1);
      assert.ok(
        next >= 0xdc00 && next <= 0xdfff,
        `a high surrogate at ${i} is not followed by its low half`
      );
      i += 1;
    } else {
      assert.ok(!(unit >= 0xdc00 && unit <= 0xdfff), `an orphaned low surrogate at ${i}`);
    }
  }

  // The ASCII equivalent of the same shape budgets identically: same tag count
  // in, same arithmetic, and both land inside the ceiling.
  const ascii = createPromptState();
  ascii.batch(function () {
    for (let i = 0; i < 140; i += 1) {
      ascii.add({ section: 'custom', tag: 'cafe tokyo hp texture ' + i, source: 'manual' });
    }
  });
  const asciiLimited = limitPrompt(compileStylePrompt(ascii, ['mic harsh noise', 'cafe vocals']).text);
  assert.ok(asciiLimited.text.length <= PROMPT_CHAR_LIMIT);
  assert.ok(!/,\s*$/.test(limited.text) && !/,\s*$/.test(asciiLimited.text));
  assert.strictEqual(limited.text, limited.text.trim());

  // A surrogate pair straddling the cut point exactly: sweep every ceiling
  // across a run of emoji so at least one cut has to refuse a half-character.
  const emoji = 'tag 🎧🎧🎧🎧🎧🎧🎧🎧, second 🎼🎼🎼🎼🎼🎼, third 🥁🥁🥁🥁🥁';
  for (let max = 1; max <= emoji.length; max += 1) {
    const out = limitPrompt(emoji, max);
    assert.ok(out.text.length <= max, `max=${max}: ${out.text.length} code units`);
    assert.ok(out.text.isWellFormed(), `max=${max}: split a surrogate pair`);
  }

  // …and an exclusion term is capped in code units the same way, without
  // stranding half a pair at the cap.
  const long = normalizeExclusion('🎧'.repeat(40));
  assert.ok(long.length <= EXCLUSION_MAX_LEN, `${long.length} > ${EXCLUSION_MAX_LEN}`);
  assert.ok(long.isWellFormed(), 'the exclusion cap split a surrogate pair');
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
