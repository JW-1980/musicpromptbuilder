'use strict';
/*
 * tests/prompt-diff.test.js — FDD #57 Prompt Diff Viewer, #76 Batch Variation
 * Matrix, #82 Suno Credit Cost Estimator.
 *
 * vm-loaded like tests/model-deeplink.test.js: #app-main is one inline
 * script with every testable factory as a top-level `function` declaration,
 * reachable in a DOM-free node:vm context (function/var bindings become
 * sandbox properties; top-level const/let do not — see index.html's own
 * layout comment above #app-main). tokenizeForDiff, diffTokenKey, wordDiff,
 * dissectionOutputText, findAnchorGenre, spinBatchVariations and
 * estimateBatchCreditCost are all such declarations, exercised directly
 * below with no fakes needed.
 *
 * renderDiffOps() is the one exception: it genuinely touches a DOM, but only
 * through `container.ownerDocument` — never a bare global `document` — so a
 * plain object carrying that shape (fakeDoc()/fakeContainer() below) drives
 * it with no `document` global in the sandbox at all.
 *
 * buildHistoryRow(), showHistoryCompare() and renderDissectDiff() live
 * inside the boot IIFE, which is guarded by `typeof document === 'undefined'`
 * and never runs here — the same reason instruments-inspire.test.js reads
 * renderInspireStrip() as SOURCE TEXT rather than calling it (see
 * functionBody() below, copied from that suite).
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');
const { cssBlock, stripCssComments } = require('./ui-layout.test.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

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
  tokenizeForDiff,
  diffTokenKey,
  wordDiff,
  renderDiffOps,
  dissectionOutputText,
  findAnchorGenre,
  spinBatchVariations,
  estimateBatchCreditCost,
  SUNO_CREDITS_PER_GENERATION,
  createSeededRng,
  createPromptState,
  MUSIC_KB,
} = app.sandbox;

/* -------------------------------------------------------------------------- */
/* Fakes (test-only)                                                          */
/* -------------------------------------------------------------------------- */

/** The smallest ownerDocument-shaped object renderDiffOps needs. */
function fakeDoc() {
  const doc = {};
  doc.createTextNode = function (data) {
    return { nodeType: 3, data: String(data), textContent: String(data), parentNode: null };
  };
  doc.createElement = function (tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      className: '',
      childNodes: [],
      parentNode: null,
      ownerDocument: doc,
      appendChild(child) {
        child.parentNode = el;
        el.childNodes.push(child);
        return child;
      },
    };
    Object.defineProperty(el, 'textContent', {
      get() {
        return el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
      },
      set() {
        el.childNodes = [];
      },
    });
    return el;
  };
  return doc;
}

/** A container element renderDiffOps(container, ops) can be handed directly. */
function fakeContainer() {
  return fakeDoc().createElement('div');
}

/**
 * The body of a top-level-ish function declaration, brace-matched while
 * skipping quoted spans. Copied verbatim from
 * tests/instruments-inspire.test.js — the same idiom for reading DOM-bound
 * rendering logic this suite cannot call directly (no `document` here).
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

/** Round-trip a vm-realm value through this realm's own intrinsics. */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return stripCssComments(m[1]);
}

/** Every `var(--token)` reference in a CSS block body, deduplicated. */
function varTokens(body) {
  const out = new Set();
  const re = /var\((--[a-zA-Z0-9-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return Array.from(out);
}

const s = suite('prompt-diff (FDD #57 Diff Viewer, #76 Batch Variation Matrix, #82 Credit Estimator)');

/* -------------------------------------------------------------------------- */
/* B1. tokenizeForDiff / diffTokenKey                                        */
/* -------------------------------------------------------------------------- */

s.test('tokenizeForDiff splits on whitespace only, keeping punctuation on the word', () => {
  assert.deepStrictEqual(host(tokenizeForDiff('lo-fi dream, warm tape')), ['lo-fi', 'dream,', 'warm', 'tape']);
  assert.deepStrictEqual(host(tokenizeForDiff('  a   b  ')), ['a', 'b']);
  assert.deepStrictEqual(host(tokenizeForDiff('')), []);
  assert.deepStrictEqual(host(tokenizeForDiff('   ')), []);
  assert.deepStrictEqual(host(tokenizeForDiff(null)), []);
  assert.deepStrictEqual(host(tokenizeForDiff(undefined)), []);
});

s.test('"lo-fi" is one token; "lo fi" is two — the R2 example, literally', () => {
  assert.strictEqual(tokenizeForDiff('lo-fi').length, 1);
  assert.strictEqual(tokenizeForDiff('lo fi').length, 2);
});

s.test('diffTokenKey lowercases and strips only LEADING/TRAILING punctuation', () => {
  assert.strictEqual(diffTokenKey('Lo-Fi,'), 'lo-fi');
  assert.strictEqual(diffTokenKey('"warehouse"'), 'warehouse');
  assert.strictEqual(diffTokenKey('...glitch!!!'), 'glitch');
  assert.strictEqual(diffTokenKey(''), '');
  assert.strictEqual(diffTokenKey(42), '');
});

s.test('R2: diffTokenKey must NOT reuse normalizePromptTag — internal punctuation stays significant', () => {
  // normalizePromptTag only folds whitespace/case; it would leave the comma
  // in place. diffTokenKey strips it. If diffTokenKey ever delegated to
  // normalizePromptTag this would collapse to the same string.
  const normalized = app.evaluate("normalizePromptTag('lo-fi,')");
  assert.strictEqual(normalized, 'lo-fi,', 'normalizePromptTag is not expected to touch punctuation at all');
  assert.notStrictEqual(diffTokenKey('lo-fi,'), normalized);
  assert.strictEqual(diffTokenKey('lo-fi,'), 'lo-fi');
});

s.test('R2, source-level: diffTokenKey never calls normalizePromptTag', () => {
  const body = functionBody(app.source, 'function diffTokenKey(word)');
  assert.ok(!/normalizePromptTag/.test(body), 'diffTokenKey must not delegate to normalizePromptTag');
});

/* -------------------------------------------------------------------------- */
/* B1. wordDiff                                                              */
/* -------------------------------------------------------------------------- */

s.test('wordDiff: identical strings are all equal', () => {
  const { ops, truncated } = wordDiff('hello brave world', 'hello brave world');
  assert.strictEqual(truncated, false);
  assert.deepStrictEqual(
    host(ops),
    ['hello', 'brave', 'world'].map((text) => ({ type: 'equal', text }))
  );
});

s.test('wordDiff: an inserted word is a single added op between two equals', () => {
  const { ops } = wordDiff('hello world', 'hello brave world');
  assert.deepStrictEqual(host(ops), [
    { type: 'equal', text: 'hello' },
    { type: 'added', text: 'brave' },
    { type: 'equal', text: 'world' },
  ]);
});

s.test('wordDiff: a dropped word is a single removed op', () => {
  const { ops } = wordDiff('hello brave world', 'hello world');
  assert.deepStrictEqual(host(ops), [
    { type: 'equal', text: 'hello' },
    { type: 'removed', text: 'brave' },
    { type: 'equal', text: 'world' },
  ]);
});

s.test('wordDiff: matching is case-insensitive via diffTokenKey', () => {
  const { ops } = wordDiff('Hello World', 'hello world');
  assert.deepStrictEqual(host(ops), [
    { type: 'equal', text: 'hello' },
    { type: 'equal', text: 'world' },
  ]);
});

s.test('wordDiff: "lo-fi" vs "lo fi" is a real difference, not a silent match', () => {
  const { ops } = wordDiff('a lo-fi track', 'a lo fi track');
  const types = ops.map((op) => op.type);
  assert.ok(types.indexOf('added') !== -1 || types.indexOf('removed') !== -1, `no diff at all: ${JSON.stringify(host(ops))}`);
});

s.test('wordDiff: empty vs empty is zero ops, not truncated', () => {
  const { ops, truncated } = wordDiff('', '');
  assert.deepStrictEqual(host(ops), []);
  assert.strictEqual(truncated, false);
});

s.test('wordDiff: past the 250,000-cell cap, a two-block fallback with truncated:true', () => {
  // 501 * 501 = 251,001 > 250,000.
  const a = new Array(501).fill('aa').join(' ');
  const b = new Array(501).fill('bb').join(' ');
  const { ops, truncated } = wordDiff(a, b);
  assert.strictEqual(truncated, true);
  assert.deepStrictEqual(host(ops), [
    { type: 'removed', text: a },
    { type: 'added', text: b },
  ]);
});

s.test('wordDiff: right at the cap (500*500 = 250,000) the real DP still runs', () => {
  const a = new Array(500).fill('x').join(' ');
  const { truncated } = wordDiff(a, a);
  assert.strictEqual(truncated, false);
});

/* -------------------------------------------------------------------------- */
/* B1. renderDiffOps                                                         */
/* -------------------------------------------------------------------------- */

s.test('renderDiffOps: a plain equal run is a bare text node — no span', () => {
  const container = fakeContainer();
  renderDiffOps(container, [{ type: 'equal', text: 'hello' }]);
  assert.strictEqual(container.childNodes.length, 1);
  assert.strictEqual(container.childNodes[0].nodeType, 3);
  assert.strictEqual(container.childNodes[0].data, 'hello');
});

s.test('renderDiffOps: removed/added runs are a span with ONE text child, real +/− glyph', () => {
  const container = fakeContainer();
  renderDiffOps(container, [
    { type: 'removed', text: 'brave' },
    { type: 'added', text: 'timid' },
  ]);
  const spans = container.childNodes.filter((n) => n.nodeType === 1);
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(spans[0].tagName, 'SPAN');
  assert.strictEqual(spans[0].className, 'diff-removed');
  assert.strictEqual(spans[0].childNodes.length, 1);
  assert.strictEqual(spans[0].childNodes[0].nodeType, 3);
  assert.strictEqual(spans[0].childNodes[0].data, '− brave');
  assert.strictEqual(spans[1].className, 'diff-added');
  assert.strictEqual(spans[1].childNodes[0].data, '+ timid');
});

s.test('renderDiffOps: clears whatever the container held before', () => {
  const container = fakeContainer();
  container.appendChild(container.ownerDocument.createTextNode('stale'));
  renderDiffOps(container, [{ type: 'equal', text: 'fresh' }]);
  assert.strictEqual(container.childNodes.length, 1);
  assert.strictEqual(container.childNodes[0].data, 'fresh');
});

s.test('renderDiffOps: unsafe added carries BOTH classes; unsafe equal carries is-unsafe alone', () => {
  const container = fakeContainer();
  renderDiffOps(container, [
    { type: 'added', text: 'bob', unsafe: true },
    { type: 'equal', text: 'jones', unsafe: true },
  ]);
  const spans = container.childNodes.filter((n) => n.nodeType === 1);
  assert.strictEqual(spans.length, 2);
  assert.strictEqual(spans[0].className, 'diff-added is-unsafe');
  assert.strictEqual(spans[1].className, 'is-unsafe');
});

s.test('renderDiffOps: hostile input never becomes a non-text, non-span child (XSS)', () => {
  const container = fakeContainer();
  const payload = '<img src=x onerror=alert(1)>';
  renderDiffOps(container, [
    { type: 'equal', text: 'before' },
    { type: 'added', text: payload },
    { type: 'removed', text: payload },
  ]);

  function walk(nodes, out) {
    for (const n of nodes) {
      out.push(n);
      if (n.childNodes) walk(n.childNodes, out);
    }
  }
  const all = [];
  walk(container.childNodes, all);
  for (const n of all) {
    assert.ok(
      n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'SPAN'),
      `non-text, non-span node in the diff tree: ${JSON.stringify({ nodeType: n.nodeType, tagName: n.tagName })}`
    );
  }
  // The payload survived as INERT TEXT — present, but never parsed as markup.
  assert.ok(container.textContent.indexOf(payload) !== -1);
  assert.strictEqual(all.filter((n) => n.nodeType === 1 && n.tagName !== 'SPAN').length, 0);
});

s.test('renderDiffOps: a hostile or absent container never throws', () => {
  for (const bad of [null, undefined, {}, { appendChild: 1 }, fakeContainer.call(null)]) {
    assert.doesNotThrow(() => renderDiffOps(bad, [{ type: 'equal', text: 'x' }]));
  }
  const noDoc = { appendChild() {} };
  assert.doesNotThrow(() => renderDiffOps(noDoc, [{ type: 'equal', text: 'x' }]));
});

s.test('renderDiffOps: never reads a bare global `document` — only container.ownerDocument', () => {
  const body = functionBody(app.source, 'function renderDiffOps(container, ops)');
  assert.ok(!/(?<!\.)\bdocument\.(createElement|createTextNode)\(/.test(body), 'must not touch a bare `document`');
  assert.ok(/container\.ownerDocument/.test(body));
});

/* -------------------------------------------------------------------------- */
/* B3. dissectionOutputText                                                  */
/* -------------------------------------------------------------------------- */

s.test('dissectionOutputText joins genre tags, instruments, mood, era — never bpm_range', () => {
  const text = dissectionOutputText({
    genre_tokens: [{ tag: 'techno', weight: 1 }, { tag: 'deep house', weight: 0.5 }],
    instruments: ['909 kick'],
    mood: ['dark'],
    era: ['1990s'],
    bpm_range: [120, 130],
    confidence: 0.8,
  });
  assert.strictEqual(text, 'techno, deep house, 909 kick, dark, 1990s');
  assert.ok(text.indexOf('120') === -1 && text.indexOf('130') === -1, 'bpm_range must not appear as prose');
});

s.test('dissectionOutputText survives junk without throwing', () => {
  assert.strictEqual(dissectionOutputText(null), '');
  assert.strictEqual(dissectionOutputText(undefined), '');
  assert.strictEqual(dissectionOutputText({}), '');
  assert.strictEqual(dissectionOutputText({ genre_tokens: 'nope' }), '');
});

/* -------------------------------------------------------------------------- */
/* B5. findAnchorGenre                                                       */
/* -------------------------------------------------------------------------- */

s.test('findAnchorGenre: an empty draft is disabled with a reason, never a guess', () => {
  const store = createPromptState();
  const anchor = findAnchorGenre(store, MUSIC_KB);
  assert.strictEqual(anchor.genreId, null);
  assert.ok(/no genre tag yet/.test(anchor.reason));
});

s.test('findAnchorGenre: genre tags that match nothing in the taxonomy are also disabled', () => {
  const store = createPromptState();
  store.add({ section: 'genre', tag: 'a genre nobody wrote down', source: 'manual' });
  const anchor = findAnchorGenre(store, MUSIC_KB);
  assert.strictEqual(anchor.genreId, null);
  assert.ok(/None of the draft.s 1 genre tag/.test(anchor.reason));
});

s.test('findAnchorGenre: a real overlap names the anchor and its score', () => {
  const store = createPromptState();
  store.add({ section: 'genre', tag: 'techno', source: 'manual' });
  store.add({ section: 'genre', tag: 'hypnotic loop', source: 'manual' });
  const anchor = findAnchorGenre(store, MUSIC_KB);
  assert.strictEqual(anchor.genreId, 'techno');
  assert.ok(anchor.score >= 2);
  assert.ok(anchor.reason.indexOf('Techno') !== -1);
  assert.ok(anchor.reason.indexOf(String(anchor.score)) !== -1);
});

s.test('findAnchorGenre: a tie says "tied: X and Y — using X", X first by kb.genres order', () => {
  const kb = {
    genres: [
      { id: 'alpha', label: 'Alpha', tokens: [{ tag: 'foo', weight: 1 }] },
      { id: 'beta', label: 'Beta', tokens: [{ tag: 'foo', weight: 1 }] },
    ],
  };
  const draft = [{ section: 'genre', tag: 'foo' }];
  const anchor = findAnchorGenre(draft, kb);
  assert.strictEqual(anchor.genreId, 'alpha');
  assert.deepStrictEqual(host(anchor.tied), ['Alpha', 'Beta']);
  assert.strictEqual(anchor.reason.indexOf('tied: Alpha and Beta — using Alpha'), 0);
});

s.test('findAnchorGenre accepts a plain array of entries, not only a live store', () => {
  const anchor = findAnchorGenre([{ section: 'genre', tag: 'techno' }], MUSIC_KB);
  assert.strictEqual(anchor.genreId, 'techno');
});

/* -------------------------------------------------------------------------- */
/* B5/B6. spinBatchVariations + estimateBatchCreditCost                      */
/* -------------------------------------------------------------------------- */

function seededDraft() {
  const store = createPromptState();
  store.add({ section: 'genre', tag: 'techno', source: 'manual' });
  store.add({ section: 'genre', tag: 'hypnotic loop', source: 'manual' });
  return store;
}

s.test('spinBatchVariations: no anchor -> {ok:false}, the anchor\'s own reason, never a spin', () => {
  const outcome = spinBatchVariations(createPromptState(), MUSIC_KB, 1);
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.anchor.genreId, null);
  assert.strictEqual(outcome.reason, outcome.anchor.reason);
  assert.strictEqual(outcome.rows, undefined);
});

s.test('spinBatchVariations: five rows, every one within its own model ceiling, same-family anchor', () => {
  const outcome = spinBatchVariations(seededDraft(), MUSIC_KB, 7);
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.anchor.genreId, 'techno');
  assert.strictEqual(outcome.rows.length, 5);
  for (const row of outcome.rows) {
    assert.ok(row.length <= row.limit, `row over its own limit: ${row.length}/${row.limit}`);
    assert.ok(row.length <= 1000, 'the default Suno v5.5 ceiling is 1000');
    assert.strictEqual(typeof row.caption, 'string');
    assert.ok(row.caption.length > 0);
    assert.ok(Array.isArray(row.droppedTags));
    assert.ok(Array.isArray(row.droppedExclusions));
    assert.ok(Array.isArray(row.conflicts));
  }
});

s.test('spinBatchVariations: the base draft survives untouched (a pure function, not a writer)', () => {
  const store = seededDraft();
  const before = host(store.list());
  spinBatchVariations(store, MUSIC_KB, 3);
  assert.deepStrictEqual(host(store.list()), before);
});

s.test('spinBatchVariations: a duplicate row still counts, and says so', () => {
  // Not every seed produces a duplicate; scan a range and require the FIELD
  // is always well-formed, and that at least one duplicate turns up somewhere
  // in 200 tries (SPIN_SEEDS, instruments-inspire.test.js:106) — proving the
  // path is real rather than dead code.
  let sawDuplicate = false;
  for (let seed = 0; seed < 200; seed += 1) {
    const outcome = spinBatchVariations(seededDraft(), MUSIC_KB, seed);
    for (let i = 0; i < outcome.rows.length; i += 1) {
      const row = outcome.rows[i];
      assert.ok(row.duplicateOfIndex === -1 || (row.duplicateOfIndex >= 0 && row.duplicateOfIndex < i));
      if (row.duplicateOfIndex !== -1) {
        sawDuplicate = true;
        assert.ok(/duplicate of variation/.test(row.caption));
        assert.strictEqual(row.text, outcome.rows[row.duplicateOfIndex].text);
      }
    }
  }
  assert.ok(sawDuplicate, 'no duplicate row ever appeared across 200 seeds — that path is untested');
});

const SPIN_SEEDS = 200;

s.test(`spinBatchVariations: deterministic over ${SPIN_SEEDS} seeds — same seed, same five rows`, () => {
  for (let seed = 0; seed < SPIN_SEEDS; seed += 1) {
    const a = spinBatchVariations(seededDraft(), MUSIC_KB, seed);
    const b = spinBatchVariations(seededDraft(), MUSIC_KB, seed);
    assert.deepStrictEqual(host(a.rows), host(b.rows), `seed ${seed} was not reproducible`);
  }
});

s.test('spinBatchVariations: another seed changes at least one row', () => {
  const base = spinBatchVariations(seededDraft(), MUSIC_KB, 0);
  let sawChange = false;
  for (let seed = 1; seed < SPIN_SEEDS; seed += 1) {
    const other = spinBatchVariations(seededDraft(), MUSIC_KB, seed);
    if (JSON.stringify(host(other.rows)) !== JSON.stringify(host(base.rows))) {
      sawChange = true;
      break;
    }
  }
  assert.ok(sawChange, `no seed in 1..${SPIN_SEEDS - 1} ever differed from seed 0`);
});

s.test('spinBatchVariations: exclusions are actually compiled in, not silently dropped', () => {
  const store = seededDraft();
  const withExclusion = spinBatchVariations(seededDraft(), MUSIC_KB, 11, { exclusions: ['saxophone'] });
  assert.strictEqual(withExclusion.ok, true);
  for (const row of withExclusion.rows) {
    assert.ok(row.text.indexOf('[Exclude:') !== -1, 'the shield block must survive into a batch row');
  }
});

s.test('estimateBatchCreditCost(5) === 25, the §5.2 worked example', () => {
  assert.strictEqual(estimateBatchCreditCost(5), 25);
  assert.strictEqual(SUNO_CREDITS_PER_GENERATION, 5);
  assert.strictEqual(estimateBatchCreditCost(1), 5);
  assert.strictEqual(estimateBatchCreditCost(0), 0);
  assert.strictEqual(estimateBatchCreditCost(-3), 0);
  assert.strictEqual(estimateBatchCreditCost(NaN), 0);
  assert.strictEqual(estimateBatchCreditCost('5'), 0);
});

s.test('estimateBatchCreditCost’s docstring quotes §5.2 verbatim', () => {
  const at = app.source.indexOf('function estimateBatchCreditCost(n)');
  assert.ok(at !== -1);
  const commentStart = app.source.lastIndexOf('/**', at);
  const docblock = app.source.slice(commentStart, at);
  assert.ok(
    docblock.indexOf('Estimated Cost: 25 Credits') !== -1,
    'the docstring must quote FEATURE-MECHANICS.md §5.2’s own example verbatim'
  );
  assert.ok(docblock.indexOf('§5.2') !== -1);
});

/* -------------------------------------------------------------------------- */
/* CSS — R1 / the AMENDED track list                                        */
/* -------------------------------------------------------------------------- */

s.test('.diff-removed and .diff-added use ONLY --danger-crimson / --accent-cyan, and no transition', () => {
  const css = readStyle();
  const removed = cssBlock(css, '.diff-removed {');
  const added = cssBlock(css, '.diff-added {');
  assert.ok(removed, '.diff-removed { … } is missing');
  assert.ok(added, '.diff-added { … } is missing');

  assert.deepStrictEqual(varTokens(removed.body), ['--danger-crimson']);
  assert.deepStrictEqual(varTokens(added.body), ['--accent-cyan']);

  assert.ok(!/transition/.test(removed.body), '.diff-removed must carry no transition');
  assert.ok(!/transition/.test(added.body), '.diff-added must carry no transition');

  // R1: no new --diff-* custom property exists anywhere in the sheet.
  assert.ok(!/--diff-/.test(css), 'R1 rejected a new --diff-added/--diff-removed token');
});

s.test('the diff rules carry no raw hex — token-only CSS, same rule every other block follows', () => {
  const css = readStyle();
  const removed = cssBlock(css, '.diff-removed {');
  const added = cssBlock(css, '.diff-added {');
  const unsafe = cssBlock(css, '.diff-added.is-unsafe {');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(removed.body));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(added.body));
  assert.ok(unsafe && !/#[0-9a-fA-F]{3,8}\b/.test(unsafe.body));
});

/* -------------------------------------------------------------------------- */
/* Markup — the three surfaces exist and are wired                          */
/* -------------------------------------------------------------------------- */

s.test('the dissector diff block is hidden by default, sibling to the confidence/source/raw blocks', () => {
  const html = readIndex();
  const block = /<div id="dissect-diff-block"[^>]*hidden[^>]*>/.exec(html);
  assert.ok(block, '#dissect-diff-block must exist and start hidden');
  const results = html.slice(html.indexOf('id="dissect-results"'), html.indexOf('</section>', html.indexOf('id="dissect-results"')));
  assert.ok(results.indexOf('id="dissect-diff-block"') !== -1);
  assert.ok(results.indexOf('id="dissect-confidence-meter"') !== -1);
  assert.ok(results.indexOf('id="dissect-json"') !== -1);
  // Read-only: no copy control inside this specific block.
  const blockMarkup = html.slice(html.indexOf('id="dissect-diff-block"'), html.indexOf('id="dissect-diff-block"') + 700);
  assert.ok(!/btn-mini/.test(blockMarkup.slice(0, blockMarkup.indexOf('</div>'))));
});

s.test('the history compare panel sits near #history-counts, hidden by default', () => {
  const html = readIndex();
  const historySection = html.slice(html.indexOf('id="history-heading"'), html.indexOf('id="presets-heading"'));
  assert.ok(historySection.indexOf('id="history-counts"') !== -1);
  assert.ok(historySection.indexOf('id="history-compare"') !== -1);
  assert.ok(/<div id="history-compare"[^>]*hidden[^>]*>/.test(historySection));
  assert.ok(historySection.indexOf('id="history-counts"') < historySection.indexOf('id="history-compare"'));
});

s.test('the batch variation matrix sits beside #btn-style-copy, behind an explicit Roll', () => {
  const html = readIndex();
  const styleSection = html.slice(html.indexOf('id="style-heading"'), html.indexOf('id="btn-batch-copy-all"') + 200);
  assert.ok(styleSection.indexOf('id="btn-batch-roll"') !== -1);
  assert.ok(styleSection.indexOf('id="btn-style-copy"') !== -1);
  assert.ok(styleSection.indexOf('id="btn-style-copy"') < styleSection.indexOf('id="btn-batch-roll"'), 'the batch matrix sits AFTER the copy button, beside it in the same card');
  assert.ok(/id="style-batch-rows"[^>]*hidden/.test(html));
  assert.ok(/id="btn-batch-copy-all"[^>]*hidden/.test(html));
});

s.test('buildHistoryRow carries a Compare button with data-focus-key=\'compare\', and the row height contract is untouched', () => {
  const body = functionBody(app.source, 'function buildHistoryRow(record)');
  assert.ok(/data-focus-key', 'compare'/.test(body), 'the Compare button must carry data-focus-key for the focus rescue');
  assert.ok(/showHistoryCompare\(record\.id\)/.test(body));
  assert.strictEqual(app.evaluate('VIRTUAL_ROW_HEIGHT'), 84, 'the 84px row-height contract must not move');
});

s.test('showHistoryCompare diffs against the SAME compile copyStylePrompt runs, and says "no differences" when equal', () => {
  const body = functionBody(app.source, 'function showHistoryCompare(id)');
  assert.ok(/buildFinalPrompt\(/.test(body));
  assert.ok(/activeModelOptions\(\)/.test(body));
  assert.ok(/instrumentalLock\.get\(\)/.test(body));
  assert.ok(/record\.text === final\.text/.test(body));
  assert.ok(/no differences/.test(body));
});

s.test('renderDissectDiff hides for a #58 batch, says "nothing to compare" when both sides are empty, and flags R3 unsafe tokens', () => {
  const body = functionBody(app.source, 'function renderDissectDiff()');
  assert.ok(/trackLines\(\)\.length > 1/.test(body), 'must hide for a multi-track batch dissection');
  assert.ok(/nothing to compare/.test(body));
  assert.ok(/dissectionOutputText\(lastResult\)/.test(body), 'must diff the RAW result per §7.4');
  assert.ok(/dissectionOutputText\(lastSafeResult\)/.test(body), 'must compare against the Safe-Mode result for R3');
  assert.ok(/unsafe: true/.test(body), 'a Safe-Mode-refused token must be flagged, not silently plain-added');
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
