'use strict';
/*
 * tests/ui-layout.test.js — the Obsidian Studio two-view shell.
 *
 * Two halves, both dependency-free:
 *
 *   1. BEHAVIOUR. `createViewManager` and `createThemePrefs` live in
 *      <script id="app-main"> and are exercised in a node:vm context with NO
 *      `document`, `window` or `localStorage`. Fake elements and a recording
 *      fake storage stand in for the DOM, which proves the shell is genuinely
 *      dependency-injected and that the boot IIFE stays inert outside a
 *      browser (see tests/lib/extract.js for why top-level `function`/`var`
 *      declarations are reachable here and `const`/`let` are not).
 *
 *   2. STATIC CONTRACTS. The layout promises of docs/ENGINEERING-STANDARD.md
 *      §2.2 (@container over @media), docs/FEATURE-MECHANICS.md §6.1 (native
 *      view transitions plus a reduced-motion escape hatch) and docs/FDD.md
 *      #17 (High-Contrast "Code" Mode) are CSS, not JavaScript, so they are
 *      asserted by scanning the <style> block and the markup directly.
 *
 * TOKEN POLICY (the last static test): the design tokens in :root, their light
 * twin in .theme-light and their overrides in .high-contrast are the single
 * source of truth for colour. A hex literal anywhere else in the stylesheet
 * means a rule has hard-coded a colour that neither a theme swap nor
 * high-contrast mode can swap — which is exactly how a legibility mode rots.
 * Every `#rrggbb` in the stylesheet must therefore sit on a custom-property
 * declaration line inside one of those three blocks. The companion suite
 * tests/theming.test.js extends the same policy to rgba() and proves the two
 * palettes are a name-for-name mirror.
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
/* The blocks allowed to hold a raw colour literal, in stylesheet order. Every
 * palette must come before the Code Mode override, which wins on equal
 * specificity purely by sitting last.
 *
 * CONSCIOUSLY UPDATED IN 0.16.0: was [':root {', '.theme-light {',
 * '.high-contrast {']. The theme suite added four more palette blocks, and a
 * palette block is by definition where colour literals live — so the whitelist
 * grows with the suite rather than the suite leaking hexes past a stale list.
 * The ORDER of this array is itself part of the contract: the same order is
 * asserted, block by block, in tests/theming.test.js. */
const TOKEN_BLOCK_SELECTORS = [
  ':root {',
  '.theme-light {',
  '.theme-studio-colorsafe {',
  '.theme-tape-deck {',
  '.theme-null-signal {',
  '.theme-abyssal-bloom {',
  '.high-contrast {',
];
/* This constant and the title of the test that reads it are the only two
 * things in this file a version bump may touch, and they move together.
 * Convention since the v1.1.0 release audit: per-task bumps between releases,
 * and the release commit aligns APP_VERSION, package.json and the git tag. */
const EXPECTED_VERSION = '1.1.0'; // CONSCIOUSLY UPDATED IN 1.1.0: release-audit version reconciliation — APP_VERSION, package.json and the git tag align at release time; per-task bumps continue between releases.
/* The Prompt Editor's four workflow zones, in the order they must be read. */
const EDITOR_ZONES = ['Describe', 'Shape', 'Compile', 'Library'];
/* Every card heading in the Prompt Editor. They are h4 under an h3 zone; see
 * the "outline" test below for why the level matters. */
const EDITOR_CARD_HEADINGS = [
  'dissect-heading',
  'inspire-heading',
  'scene-heading',
  'sliders-heading',
  'vocal-heading',
  'instrument-heading',
  'era-heading',
  'structure-heading',
  'draft-heading',
  'exclude-heading',
  'style-heading',
  'history-heading',
  'presets-heading',
];
/* The two halves of the zoned split, in reading order. SHAPE holds everything
 * that FEEDS the prompt; the COMPILE rail holds the three cards that produce
 * and carry the string that is actually pasted into Suno. Which card sits in
 * which wrapper is the whole point of the split — a card in the wrong one is
 * either a sticky input or a compiled output that scrolls away. */
const EDITOR_SHAPE_CARDS = [
  'scene-panel',
  'slider-panel',
  'vocal-panel',
  /* FDD #27's Modular Instrument "Lego Blocks" card, between the voice and the
   * room it was recorded in — which is also where its section sits in
   * PROMPT_SECTION_ORDER (genre > mood > vocal > instrument > scene > era). */
  'instrument-panel',
  /* FDD #66's Production Era & Signature card. It FEEDS the prompt, so it
   * belongs on this side of the split — parked in the sticky rail it would pin
   * a search box to the viewport. */
  'era-panel',
  'structure-panel',
];
const EDITOR_RAIL_CARDS = ['draft-panel', 'exclude-panel', 'style-panel'];
/* Every card in the view, in the order the single-column stack reads them. The
 * split must not reorder the document: below 1080px it IS that stack.
 * FDD #71's "Inspire me" card closes the DESCRIBE zone — it is neither a shape
 * card nor a rail card, because it sits outside the split entirely, beside the
 * dissector whose question it answers from the other end. */
const EDITOR_CARD_ORDER = ['dissector-panel', 'inspire-panel']
  .concat(EDITOR_SHAPE_CARDS, EDITOR_RAIL_CARDS, ['history-panel', 'presets-panel']);
const PREFS_KEY = 'suno_ui_prefs';

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/** Evaluate #app-main in a DOM-free vm context. */
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

/* -------------------------------------------------------------------------- */
/* Fakes (test-only)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The smallest object createViewManager can drive: a `hidden` flag, a
 * classList and an attribute bag. Every write the manager makes is observable.
 */
function fakeEl(init) {
  const state = init || {};
  const el = {
    hidden: state.hidden === true,
    attrs: Object.create(null),
    classes: [],
  };
  el.classList = {
    add(name) {
      if (el.classes.indexOf(name) === -1) el.classes.push(name);
    },
    remove(name) {
      const i = el.classes.indexOf(name);
      if (i !== -1) el.classes.splice(i, 1);
    },
    contains(name) {
      return el.classes.indexOf(name) !== -1;
    },
  };
  el.setAttribute = function (name, value) {
    el.attrs[name] = String(value);
  };
  el.getAttribute = function (name) {
    return name in el.attrs ? el.attrs[name] : null;
  };
  return el;
}

/** A recording Storage stand-in: every read and write is captured. */
function fakeStorage(seed) {
  const data = Object.create(null);
  if (seed) {
    for (const key of Object.keys(seed)) data[key] = String(seed[key]);
  }
  return {
    reads: [],
    writes: [],
    removed: [],
    data,
    getItem(key) {
      this.reads.push(key);
      return key in data ? data[key] : null;
    },
    setItem(key, value) {
      this.writes.push({ key, value: String(value) });
      data[key] = String(value);
    },
    removeItem(key) {
      this.removed.push(key);
      delete data[key];
    },
    keysWritten() {
      return this.writes.map((w) => w.key);
    },
  };
}

/** A two-view shell wired up the way index.html wires it. */
function makeShell(app, deps) {
  const hum = fakeEl({ hidden: false });
  const editor = fakeEl({ hidden: true });
  const tabHum = fakeEl();
  const tabEditor = fakeEl();
  const manager = app.sandbox.createViewManager(deps || {});
  manager.register('hum', hum, tabHum);
  manager.register('editor', editor, tabEditor);
  return { manager, hum, editor, tabHum, tabEditor };
}

/* -------------------------------------------------------------------------- */
/* Stylesheet / markup helpers                                                */
/* -------------------------------------------------------------------------- */

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/**
 * Blank out CSS block comments while keeping every newline, so line numbers in
 * failure messages stay accurate. Without this, prose inside a comment is
 * indistinguishable from a rule: a comment that merely MENTIONS `@media` reads
 * as an at-rule whose prelude runs on to the next `{`, which silently swallows
 * the real rule that follows it.
 *
 * @param {string} css
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/** The contents of the single inline <style> block, comments blanked out. */
function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return stripCssComments(m[1]);
}

/**
 * Body of the first CSS block whose selector/at-rule prelude contains `needle`,
 * brace-matched so nested blocks (an @media or @container wrapper) come back
 * whole.
 *
 * @param {string} css
 * @param {string} needle
 * @param {number} [from] index to start searching at
 * @returns {{body: string, start: number, end: number}|null}
 */
function cssBlock(css, needle, from) {
  const at = css.indexOf(needle, from || 0);
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, i), start: at, end: i + 1 };
    }
  }
  return null;
}

/**
 * Every `#rrggbb`-shaped literal in the stylesheet, with its source line AND
 * its absolute index. The index is what lets a caller decide which block a hit
 * sits in without searching for its text — two token blocks can legitimately
 * hold byte-identical declaration lines, and a text search would attribute
 * both to whichever came first.
 */
function hexLiterals(css) {
  const lines = css.split(/\r\n|\r|\n/);
  const re = /#([0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])/g;
  const out = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    const lineNo = css.slice(0, m.index).split(/\r\n|\r|\n/).length;
    out.push({ hex: m[0], line: lineNo, index: m.index, text: (lines[lineNo - 1] || '').trim() });
  }
  return out;
}

/** The Prompt Editor view's markup, from its <section> to the end of <main>. */
function readEditorMarkup() {
  const html = readIndex();
  const start = html.indexOf('id="view-editor"');
  const end = html.indexOf('</main>');
  assert.ok(start !== -1 && end > start, 'could not locate the Prompt Editor view');
  return html.slice(start, end);
}

/**
 * For every `<h3 class="zone-heading">` in `markup`, the class attribute of the
 * element it is a DIRECT child of (`''` when that ancestor carries no class).
 *
 * A zone heading is only ever wrong in one specific way: dropped inside a
 * `.view-grid`, it becomes a grid ITEM, and the moment the 880px rule gives
 * that grid a second column the heading silently turns into a stray cell
 * beside a card. Nothing about the rendered page says so, and no other
 * assertion in this file would catch it — hence a real (small) tag scan rather
 * than a regex that guesses at nesting. `<div>`, `<section>` and `<nav>` are
 * the only containers the Editor view uses and none of them self-close here.
 *
 * @param {string} markup
 * @returns {string[]} one entry per zone heading, in document order
 */
function zoneHeadingParents(markup) {
  // Prose inside an HTML comment is not structure; a comment that merely names
  // a tag must not push anything onto the stack.
  const source = markup.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)(div|section|nav)\b([^>]*)>|<h3 class="zone-heading">/g;
  const stack = [];
  const parents = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m[2] === undefined) {
      parents.push(stack.length ? stack[stack.length - 1] : '');
      continue;
    }
    if (m[1] === '/') {
      stack.pop();
      continue;
    }
    const cls = /class="([^"]*)"/.exec(m[3] || '');
    stack.push(cls ? cls[1] : '');
  }
  return parents;
}

/**
 * The INNER markup of the first container in `markup` whose class list holds
 * `cls`, found by walking container depth rather than by regex.
 *
 * `.editor-shape` and `.editor-rail` are plain wrappers with no id, and what
 * matters about them is what is INSIDE each — which a flat regex cannot say,
 * because both wrappers are siblings inside one `.editor-split` and a lazy
 * match would happily run from the first `<div` to the first `</div>` nine
 * cards early. Same tag vocabulary and the same comment-stripping as
 * zoneHeadingParents() above.
 *
 * @param {string} markup
 * @param {string} cls exact class name to look for in a class attribute
 * @returns {string|null}
 */
function sliceByClass(markup, cls) {
  const source = markup.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)(div|section|nav)\b([^>]*)>/g;
  let depth = null;
  let start = -1;
  let m;
  while ((m = re.exec(source)) !== null) {
    const closing = m[1] === '/';
    if (depth === null) {
      if (closing) continue;
      const attr = /class="([^"]*)"/.exec(m[3] || '');
      if (attr && attr[1].trim().split(/\s+/).indexOf(cls) !== -1) {
        depth = 1;
        start = re.lastIndex;
      }
      continue;
    }
    depth += closing ? -1 : 1;
    if (depth === 0) return source.slice(start, m.index);
  }
  return null;
}

/**
 * The `*-panel` class of every `<section>` card in `markup`, in document order.
 * @param {string} markup
 * @returns {string[]}
 */
function cardOrder(markup) {
  const out = [];
  const re = /<section class="([^"]*)"/g;
  let m;
  while ((m = re.exec(markup)) !== null) {
    const panel = m[1].trim().split(/\s+/).filter((c) => /-panel$/.test(c));
    if (panel.length) out.push(panel[0]);
  }
  return out;
}

const s = suite('ui-layout (Obsidian Studio two-view shell)');

/* -------------------------------------------------------------------------- */
/* createViewManager                                                          */
/* -------------------------------------------------------------------------- */

s.test('createViewManager is reachable as a top-level function declaration', () => {
  const app = loadAppSandbox();
  assert.strictEqual(
    typeof app.sandbox.createViewManager,
    'function',
    'createViewManager must be a top-level `function` declaration, before the boot IIFE'
  );
});

s.test('register() adopts the view the static markup already shows', () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);
  assert.strictEqual(
    shell.manager.current(),
    'hum',
    'the un-hidden view at registration time is the starting view'
  );
  assert.deepStrictEqual(Array.from(shell.manager.ids()), ['hum', 'editor']);
});

s.test('switchTo() toggles [hidden] and aria-selected across both views', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);

  const result = await shell.manager.switchTo('editor');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.id, 'editor');
  assert.strictEqual(result.changed, true, 'a real view change must report changed:true');

  assert.strictEqual(shell.hum.hidden, true, 'the leaving view must carry [hidden]');
  assert.strictEqual(shell.editor.hidden, false, 'the entering view must lose [hidden]');
  assert.strictEqual(shell.tabHum.getAttribute('aria-selected'), 'false');
  assert.strictEqual(shell.tabEditor.getAttribute('aria-selected'), 'true');
  assert.strictEqual(shell.editor.classList.contains('is-active'), true);
  assert.strictEqual(shell.hum.classList.contains('is-active'), false);

  await shell.manager.switchTo('hum');
  assert.strictEqual(shell.hum.hidden, false, 'switching back must restore the first view');
  assert.strictEqual(shell.editor.hidden, true);
  assert.strictEqual(shell.tabHum.getAttribute('aria-selected'), 'true');
  assert.strictEqual(shell.tabEditor.getAttribute('aria-selected'), 'false');
});

s.test('the roving tabindex follows aria-selected so only one tab is tabbable', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);
  await shell.manager.switchTo('editor');
  assert.strictEqual(shell.tabEditor.getAttribute('tabindex'), '0', 'selected tab is tabbable');
  assert.strictEqual(shell.tabHum.getAttribute('tabindex'), '-1', 'unselected tab is skipped');
});

s.test('the injected startViewTransition is used, and the DOM mutation runs INSIDE its callback', async () => {
  const app = loadAppSandbox();
  const calls = [];
  let hiddenDuringCall = null;

  const shell = makeShell(app, {
    startViewTransition: function (update) {
      calls.push(typeof update);
      // Before the callback runs, nothing may have moved yet…
      hiddenDuringCall = { beforeCb: shell.editor.hidden };
      update();
      // …and after it runs, the swap must already be done.
      hiddenDuringCall.afterCb = shell.editor.hidden;
      return { finished: Promise.resolve() };
    },
  });

  const result = await shell.manager.switchTo('editor');
  assert.strictEqual(calls.length, 1, 'startViewTransition must be called exactly once');
  assert.strictEqual(calls[0], 'function', 'it must be handed a callback to run the update in');
  assert.strictEqual(
    hiddenDuringCall.beforeCb,
    true,
    'the DOM must NOT be mutated before the callback — the browser needs the old snapshot'
  );
  assert.strictEqual(
    hiddenDuringCall.afterCb,
    false,
    'the DOM mutation must happen inside the callback, not around it'
  );
  assert.strictEqual(result.transitioned, true, 'a real transition must report transitioned:true');
});

s.test('switchTo() waits for the transition to finish before resolving', async () => {
  const app = loadAppSandbox();
  let release = null;
  const shell = makeShell(app, {
    startViewTransition: function (update) {
      update();
      return {
        finished: new Promise(function (resolve) {
          release = resolve;
        }),
      };
    },
  });

  let settled = false;
  const pending = shell.manager.switchTo('editor').then(function (r) {
    settled = true;
    return r;
  });

  await Promise.resolve();
  assert.strictEqual(settled, false, 'must not resolve while the transition is still running');
  release();
  const result = await pending;
  assert.strictEqual(result.ok, true);
});

s.test('an interrupted (rejected) transition still resolves — a skipped animation is not a failed switch', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app, {
    startViewTransition: function (update) {
      update();
      return { finished: Promise.reject(new Error('transition was skipped')) };
    },
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await shell.manager.switchTo('editor');
  }, 'switchTo must never reject');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(shell.editor.hidden, false, 'the view still has to end up switched');
});

s.test('every promise a skipped transition rejects is observed, so none escapes unhandled', async () => {
  // A ViewTransition rejects ready / updateCallbackDone / finished together
  // when it is skipped — which a browser really does whenever the document is
  // not compositing (a background tab). switchTo() awaits only one of them, so
  // any of the others left unobserved surfaces as "Uncaught (in promise)".
  // Reproduced against the real API's shape: all three reject.
  const escaped = [];
  const collect = (reason) => escaped.push((reason && reason.message) || String(reason));
  process.on('unhandledRejection', collect);
  try {
    const app = loadAppSandbox();
    const rejections = [];
    const shell = makeShell(app, {
      startViewTransition: function (update) {
        update();
        const skipped = () => {
          const p = Promise.reject(new Error('Transition was aborted because of invalid state'));
          rejections.push(p);
          return p;
        };
        return { ready: skipped(), updateCallbackDone: skipped(), finished: skipped() };
      },
    });

    const result = await shell.manager.switchTo('editor');
    assert.strictEqual(result.ok, true, 'a skipped transition is still a completed switch');
    assert.strictEqual(shell.editor.hidden, false, 'the view still has to end up switched');

    // Give the microtask queue and the rejection check a few turns to fire.
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      escaped,
      [],
      `a skipped view transition leaked ${escaped.length} unhandled rejection(s): ${escaped.join(', ')}`
    );
  } finally {
    process.removeListener('unhandledRejection', collect);
  }
});

s.test('ignoreRejection only ever touches real promises', () => {
  const app = loadAppSandbox();
  assert.strictEqual(
    typeof app.sandbox.ignoreRejection,
    'function',
    'ignoreRejection must be a top-level function declaration'
  );
  for (const notAPromise of [undefined, null, 0, '', 'later', {}, { then: 1 }, { then: () => {} }, []]) {
    assert.doesNotThrow(
      () => app.sandbox.ignoreRejection(notAPromise),
      `ignoreRejection(${JSON.stringify(notAPromise)}) must be a no-op, not a throw`
    );
  }
  // It must not change the promise's outcome for anyone else who is waiting.
  const resolved = Promise.resolve('kept');
  app.sandbox.ignoreRejection(resolved);
  return resolved.then((value) => assert.strictEqual(value, 'kept', 'the promise value was altered'));
});

s.test('a startViewTransition that throws still swaps the view', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app, {
    startViewTransition: function () {
      throw new Error('view transitions unavailable in this context');
    },
  });

  const result = await shell.manager.switchTo('editor');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.transitioned, false, 'no transition actually ran');
  assert.strictEqual(shell.editor.hidden, false, 'the swap must still have happened');
  assert.strictEqual(shell.hum.hidden, true);
});

s.test('without startViewTransition the swap is direct and arms the CSS fallback class', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);

  const result = await shell.manager.switchTo('editor');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.transitioned, false, 'no API means no native transition');
  assert.strictEqual(shell.editor.hidden, false);
  assert.strictEqual(
    shell.editor.classList.contains('is-entering'),
    true,
    'the entering view must be stamped .is-entering so the fallback animation replays'
  );
  assert.strictEqual(
    shell.hum.classList.contains('is-entering'),
    false,
    '.is-entering must be cleared from the view being left'
  );

  await shell.manager.switchTo('hum');
  assert.strictEqual(
    shell.editor.classList.contains('is-entering'),
    false,
    '.is-entering must be cleared on every paint so it can be re-armed'
  );
  assert.strictEqual(shell.hum.classList.contains('is-entering'), true);
});

s.test('an unknown view id resolves to {ok:false} and never throws or mutates', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);

  let result;
  await assert.doesNotReject(async () => {
    result = await shell.manager.switchTo('does-not-exist');
  }, 'an unknown id must not reject');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unknown-view');
  assert.strictEqual(shell.manager.current(), 'hum', 'current() must be unchanged');
  assert.strictEqual(shell.hum.hidden, false, 'no view may be touched by a failed switch');
  assert.strictEqual(shell.editor.hidden, true);

  for (const bad of [null, undefined, 42, {}, '']) {
    const r = await shell.manager.switchTo(bad);
    assert.strictEqual(r.ok, false, `switchTo(${String(bad)}) must resolve to {ok:false}`);
  }
});

s.test('onViewChange fires once per real change, with the new and previous ids', async () => {
  const app = loadAppSandbox();
  const seen = [];
  const shell = makeShell(app, {
    onViewChange: function (id, previous) {
      seen.push([id, previous]);
    },
  });

  await shell.manager.switchTo('editor');
  assert.deepStrictEqual(seen, [['editor', 'hum']]);

  // Re-selecting the current view is not a change and must stay silent.
  const same = await shell.manager.switchTo('editor');
  assert.strictEqual(same.ok, true);
  assert.strictEqual(same.changed, false, 'switching to the current view reports changed:false');
  assert.deepStrictEqual(seen, [['editor', 'hum']], 'no event for a no-op switch');

  await shell.manager.switchTo('hum');
  assert.deepStrictEqual(seen, [['editor', 'hum'], ['hum', 'editor']]);

  // A rejected switch must not fire the hook either.
  await shell.manager.switchTo('nope');
  assert.strictEqual(seen.length, 2, 'an unknown id must not fire onViewChange');
});

s.test('current() tracks the visible view across every path', async () => {
  const app = loadAppSandbox();
  const shell = makeShell(app, {
    startViewTransition: function (update) {
      update();
      return { finished: Promise.resolve() };
    },
  });
  assert.strictEqual(shell.manager.current(), 'hum');
  await shell.manager.switchTo('editor');
  assert.strictEqual(shell.manager.current(), 'editor');
  await shell.manager.switchTo('hum');
  assert.strictEqual(shell.manager.current(), 'hum');
});

s.test('createViewManager survives being handed nothing at all', async () => {
  const app = loadAppSandbox();
  let manager;
  assert.doesNotThrow(() => {
    manager = app.sandbox.createViewManager();
  }, 'createViewManager() with no deps must not throw');
  assert.strictEqual(manager.current(), null);
  const result = await manager.switchTo('hum');
  assert.strictEqual(result.ok, false, 'nothing is registered, so nothing can be switched to');

  // A view registered without an element or a tab must not crash the paint.
  manager.register('hum');
  await assert.doesNotReject(async () => {
    await manager.switchTo('hum');
  }, 'painting an element-less view must not throw');
  assert.strictEqual(manager.current(), 'hum');
});

s.test('register() rejects a duplicate or malformed id', () => {
  const app = loadAppSandbox();
  const shell = makeShell(app);
  assert.strictEqual(shell.manager.register('hum', fakeEl()).ok, false, 'duplicate id');
  assert.strictEqual(shell.manager.register('').ok, false, 'empty id');
  assert.strictEqual(shell.manager.register(null).ok, false, 'null id');
  assert.deepStrictEqual(Array.from(shell.manager.ids()), ['hum', 'editor'], 'the registry is unchanged');
});

/* -------------------------------------------------------------------------- */
/* tabKeyTarget — the tablist keyboard model                                  */
/* -------------------------------------------------------------------------- */

s.test('tabKeyTarget implements the WAI-ARIA horizontal tablist keys, wrapping at both ends', () => {
  const app = loadAppSandbox();
  const tabKeyTarget = app.sandbox.tabKeyTarget;
  assert.strictEqual(typeof tabKeyTarget, 'function');

  assert.strictEqual(tabKeyTarget('ArrowRight', 0, 2), 1);
  assert.strictEqual(tabKeyTarget('ArrowRight', 1, 2), 0, 'ArrowRight wraps past the last tab');
  assert.strictEqual(tabKeyTarget('ArrowLeft', 1, 2), 0);
  assert.strictEqual(tabKeyTarget('ArrowLeft', 0, 2), 1, 'ArrowLeft wraps past the first tab');
  assert.strictEqual(tabKeyTarget('Home', 1, 2), 0);
  assert.strictEqual(tabKeyTarget('End', 0, 2), 1);

  for (const key of ['Enter', ' ', 'Tab', 'a', 'ArrowUp', 'ArrowDown', '', undefined]) {
    assert.strictEqual(
      tabKeyTarget(key, 0, 2),
      -1,
      `"${String(key)}" is not the tablist's key and must be left to the browser`
    );
  }

  assert.strictEqual(tabKeyTarget('ArrowRight', 0, 0), -1, 'no tabs, nowhere to go');
  assert.strictEqual(tabKeyTarget('ArrowRight', 99, 2), 1, 'an out-of-range index is clamped to 0');
});

/* -------------------------------------------------------------------------- */
/* createThemePrefs — High-Contrast "Code" Mode (FDD #17)                     */
/* -------------------------------------------------------------------------- */

s.test('createThemePrefs is reachable as a top-level function declaration', () => {
  const app = loadAppSandbox();
  assert.strictEqual(typeof app.sandbox.createThemePrefs, 'function');
});

s.test('the preference defaults to off and persists as a boolean under suno_ui_prefs', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  assert.strictEqual(prefs.isHighContrast(), false, 'glassmorphism is the default');
  assert.strictEqual(storage.writes.length, 0, 'reading a preference must not write one');

  assert.strictEqual(prefs.setHighContrast(true), true);
  assert.strictEqual(prefs.isHighContrast(), true);
  assert.strictEqual(storage.writes.length, 1);
  assert.strictEqual(storage.writes[0].key, PREFS_KEY);

  const stored = JSON.parse(storage.data[PREFS_KEY]);
  assert.strictEqual(
    stored.highContrast,
    true,
    'the stored value must be a real boolean, not a string or a number'
  );
  assert.strictEqual(typeof stored.highContrast, 'boolean');

  prefs.setHighContrast(false);
  assert.strictEqual(JSON.parse(storage.data[PREFS_KEY]).highContrast, false);
  assert.strictEqual(prefs.isHighContrast(), false);
});

s.test('nothing but suno_ui_prefs is ever written', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  prefs.load();
  prefs.setHighContrast(true);
  prefs.setHighContrast(false);
  prefs.setHighContrast(true);

  const keys = storage.keysWritten();
  assert.ok(keys.length > 0, 'the preference must actually be persisted');
  for (const key of keys) {
    assert.strictEqual(key, PREFS_KEY, `createThemePrefs wrote an unexpected key: "${key}"`);
  }
  assert.deepStrictEqual(
    Object.keys(storage.data),
    [PREFS_KEY],
    'localStorage is reserved for lightweight UI state (FEATURE-MECHANICS.md §6.4)'
  );
  assert.deepStrictEqual(storage.removed, [], 'nothing else may be removed either');
});

s.test('load() applies a stored preference', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage({ [PREFS_KEY]: JSON.stringify({ highContrast: true }) });
  const prefs = app.sandbox.createThemePrefs({ storage });

  assert.strictEqual(prefs.isHighContrast(), false, 'nothing is read until load() is called');
  assert.strictEqual(prefs.load(), true, 'load() returns the value it applied');
  assert.strictEqual(prefs.isHighContrast(), true);
  assert.strictEqual(storage.writes.length, 0, 'load() must not write anything back');
});

s.test('corrupt, truncated or foreign stored JSON degrades to the default without throwing', () => {
  const app = loadAppSandbox();
  const corrupt = [
    '{oops',
    '',
    'null',
    'true',
    '5',
    '"highContrast"',
    '[]',
    '{"highContrast":"yes"}',
    '{"highContrast":1}',
    '{"somethingElse":true}',
    ' ',
  ];

  for (const raw of corrupt) {
    const storage = fakeStorage({ [PREFS_KEY]: raw });
    const prefs = app.sandbox.createThemePrefs({ storage });
    let value;
    assert.doesNotThrow(() => {
      value = prefs.load();
    }, `load() threw on stored value ${JSON.stringify(raw)}`);
    assert.strictEqual(
      value,
      false,
      `stored value ${JSON.stringify(raw)} must degrade to the default, got ${String(value)}`
    );
    assert.strictEqual(prefs.isHighContrast(), false);
    assert.strictEqual(storage.writes.length, 0, 'a bad read must not trigger a repair write');
  }
});

s.test('a missing, hostile or absent storage never breaks the toggle', () => {
  const app = loadAppSandbox();

  // No storage at all — the toggle still works, it just does not persist.
  const noStorage = app.sandbox.createThemePrefs({});
  assert.strictEqual(noStorage.load(), false);
  assert.strictEqual(noStorage.setHighContrast(true), true, 'the in-memory state must still flip');
  assert.strictEqual(noStorage.isHighContrast(), true);

  assert.doesNotThrow(() => {
    const bare = app.sandbox.createThemePrefs();
    bare.load();
    bare.setHighContrast(true);
  }, 'createThemePrefs() with no deps at all must not throw');

  // A storage whose every method throws (quota exceeded, disabled origin).
  const hostile = {
    getItem() {
      throw new Error('SecurityError: storage is disabled');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  const prefs = app.sandbox.createThemePrefs({ storage: hostile });
  assert.doesNotThrow(() => {
    prefs.load();
    prefs.setHighContrast(true);
  }, 'a throwing storage must be swallowed, not propagated into boot');
  assert.strictEqual(prefs.isHighContrast(), true, 'the class still has to be applied');
});

s.test('setHighContrast coerces to a real boolean rather than storing whatever it is given', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  for (const truthy of [true, 1, 'on', {}]) {
    prefs.setHighContrast(truthy);
    assert.strictEqual(prefs.isHighContrast(), true, `${JSON.stringify(truthy)} must read as true`);
    assert.strictEqual(typeof JSON.parse(storage.data[PREFS_KEY]).highContrast, 'boolean');
  }
  for (const falsy of [false, 0, '', null, undefined]) {
    prefs.setHighContrast(falsy);
    assert.strictEqual(prefs.isHighContrast(), false, `${String(falsy)} must read as false`);
    assert.strictEqual(JSON.parse(storage.data[PREFS_KEY]).highContrast, false);
  }
});

/* -------------------------------------------------------------------------- */
/* Version                                                                    */
/* -------------------------------------------------------------------------- */

s.test(`APP_VERSION is ${EXPECTED_VERSION} — the studio-keyboard release (FDD #90's var STUDIO_KEYBINDS matched by the pure matchStudioKeybind behind ONE capture-phase dispatcher, plus FDD #16's Spotlight-style command palette over buildPaletteIndex / paletteMatch)`, () => {
  const app = loadAppSandbox();
  assert.strictEqual(app.evaluate('APP_VERSION'), EXPECTED_VERSION);
});

/* -------------------------------------------------------------------------- */
/* Static markup contracts                                                    */
/* -------------------------------------------------------------------------- */

s.test('the header ships a real ARIA tablist wired to both view panels', () => {
  const html = readIndex();

  assert.ok(/role="tablist"/.test(html), 'no role="tablist" in index.html');
  const tabs = html.match(/role="tab"/g) || [];
  assert.strictEqual(tabs.length, 2, `expected exactly 2 role="tab" buttons, found ${tabs.length}`);

  for (const id of ['tab-hum', 'tab-editor', 'view-hum', 'view-editor', 'btn-contrast']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }

  // Each tab must name the panel it drives, and each panel must name its tab.
  assert.ok(/aria-controls="view-hum"/.test(html), 'the Hum tab does not aria-control its panel');
  assert.ok(/aria-controls="view-editor"/.test(html), 'the Editor tab does not aria-control its panel');
  assert.ok(/id="tab-hum"[\s\S]{0,220}aria-selected="true"/.test(html), 'the default tab is not aria-selected');
  assert.ok(/id="tab-editor"[\s\S]{0,220}aria-selected="false"/.test(html), 'the inactive tab is missing aria-selected');

  const panels = html.match(/role="tabpanel"/g) || [];
  assert.strictEqual(panels.length, 2, 'both views must be role="tabpanel"');
  assert.ok(/id="view-hum"[\s\S]{0,200}aria-labelledby="tab-hum"/.test(html), '#view-hum is not labelled by its tab');
  assert.ok(/id="view-editor"[\s\S]{0,220}aria-labelledby="tab-editor"/.test(html), '#view-editor is not labelled by its tab');

  // Exactly one view starts hidden — the shell must boot with one view showing.
  assert.ok(/id="view-editor"[\s\S]{0,240}hidden>/.test(html), '#view-editor must start hidden');
  assert.ok(!/id="view-hum"[\s\S]{0,240}hidden>/.test(html), '#view-hum must start visible');
});

s.test('the high-contrast toggle is a real pressed-state control', () => {
  const html = readIndex();
  assert.ok(
    /id="btn-contrast"[\s\S]{0,240}aria-pressed="false"/.test(html),
    '#btn-contrast must expose aria-pressed so its state is announced'
  );
  assert.ok(
    /id="btn-contrast"[\s\S]{0,240}aria-label=/.test(html),
    '#btn-contrast must carry an aria-label'
  );
});

s.test('both feature panels survived the re-layout inside their views', () => {
  const html = readIndex();
  // The record control belongs to the Hum view; the dissector to the Editor.
  const humStart = html.indexOf('id="view-hum"');
  const editorStart = html.indexOf('id="view-editor"');
  const mainEnd = html.indexOf('</main>');
  assert.ok(humStart !== -1 && editorStart > humStart && mainEnd > editorStart, 'view order is wrong');

  const humMarkup = html.slice(humStart, editorStart);
  const editorMarkup = html.slice(editorStart, mainEnd);

  for (const id of ['btn-record', 'capture-readout', 'mic-help', 'capture-metrics', 'metric-pitch']) {
    assert.ok(humMarkup.indexOf(`id="${id}"`) !== -1, `#${id} must live inside the Hum view`);
  }
  for (const id of ['dissect-input', 'btn-dissect', 'dissect-results', 'dissect-json']) {
    assert.ok(editorMarkup.indexOf(`id="${id}"`) !== -1, `#${id} must live inside the Editor view`);
  }
});

/* -------------------------------------------------------------------------- */
/* Static CSS contracts                                                       */
/* -------------------------------------------------------------------------- */

s.test('each view is its own named container and is queried with @container', () => {
  const css = readStyle();

  assert.ok(/container-name:\s*hum-view/.test(css), '#view-hum declares no container-name');
  assert.ok(/container-name:\s*editor-view/.test(css), '#view-editor declares no container-name');
  assert.ok(
    /\.studio-view\s*\{[^}]*container-type:\s*inline-size/.test(css),
    '.studio-view must be container-type: inline-size or nothing can query it'
  );

  const hum = /@container\s+hum-view\s*\(min-width:\s*880px\)/.exec(css);
  const editor = /@container\s+editor-view\s*\(min-width:\s*880px\)/.exec(css);
  assert.ok(hum, 'no @container hum-view (min-width: 880px) rule');
  assert.ok(editor, 'no @container editor-view (min-width: 880px) rule');

  // Side-by-side above the threshold, single column below it.
  const humBlock = cssBlock(css, '@container hum-view (min-width: 880px)');
  assert.ok(
    /\.hum-grid\s*\{[^}]*grid-template-columns:\s*minmax\([^)]*\)\s+minmax/.test(humBlock.body),
    'the wide Hum layout must give .hum-grid two columns'
  );
  const editorBlock = cssBlock(css, '@container editor-view (min-width: 880px)');
  assert.ok(
    /\.editor-grid\s*\{[^}]*grid-template-columns:\s*minmax\([^)]*\)\s+minmax/.test(editorBlock.body),
    'the wide Editor layout must give .editor-grid two columns'
  );
  assert.ok(
    /\.view-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    'the default (narrow) layout must be a single column'
  );
});

s.test('layout responds to @container, not @media — @media is reserved for prefers-* only', () => {
  const css = readStyle();
  const media = css.match(/@media[^{]+/g) || [];
  assert.ok(media.length > 0, 'the reduced-motion guard is itself an @media rule');
  for (const rule of media) {
    assert.ok(
      /prefers-/.test(rule),
      `@media is reserved for user preferences (ENGINEERING-STANDARD.md §2.2); found: ${rule.trim()}`
    );
  }
  const containers = css.match(/@container[^{]+/g) || [];
  assert.ok(containers.length >= 4, `expected several @container rules, found ${containers.length}`);
});

s.test('the §6.1 motion contract is expressed as ::view-transition rules', () => {
  const css = readStyle();

  assert.ok(/view-transition-name:\s*hum-view/.test(css), '#view-hum has no view-transition-name');
  assert.ok(/view-transition-name:\s*editor-view/.test(css), '#view-editor has no view-transition-name');

  // Leaving Hum fades out; entering the Editor slides up from the bottom.
  const oldHum = /::view-transition-old\(hum-view\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(oldHum, 'no ::view-transition-old(hum-view) rule');
  assert.ok(/view-fade-out/.test(oldHum[1]), 'leaving the Hum view must fade out');

  const newEditor = /::view-transition-new\(editor-view\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(newEditor, 'no ::view-transition-new(editor-view) rule');
  assert.ok(/view-slide-up/.test(newEditor[1]), 'entering the Editor view must slide up');

  const slide = /@keyframes\s+view-slide-up\s*\{([\s\S]*?)\n\s*\}/.exec(css);
  assert.ok(slide, 'no @keyframes view-slide-up');
  assert.ok(
    /translateY\(\s*\d+(?:\.\d+)?px\s*\)/.test(slide[1]),
    'the slide-up keyframes must start displaced downward (translateY), not merely fade'
  );

  // The class-based fallback for browsers without the API.
  assert.ok(
    /\.studio-view\.is-entering\s*\{[^}]*animation:\s*view-slide-up/.test(css),
    'no .is-entering fallback animation for browsers without startViewTransition'
  );
});

s.test('prefers-reduced-motion disables the view transition, not just the toasts', () => {
  const css = readStyle();
  let from = 0;
  let guarded = false;
  for (;;) {
    const block = cssBlock(css, '@media (prefers-reduced-motion: reduce)', from);
    if (!block) break;
    if (/::view-transition/.test(block.body) && /animation:\s*none/.test(block.body)) {
      guarded = true;
      assert.ok(
        /\.is-entering[^{]*\{[^}]*animation:\s*none/.test(block.body),
        'the .is-entering fallback animation must be disabled too'
      );
    }
    from = block.end;
  }
  assert.ok(
    guarded,
    'no @media (prefers-reduced-motion: reduce) block disables the ::view-transition animations'
  );
});

s.test('.high-contrast overrides the design tokens and kills every backdrop blur', () => {
  const css = readStyle();
  const block = cssBlock(css, '.high-contrast {');
  assert.ok(block, 'no `.high-contrast { … }` token-override block');

  for (const token of ['--bg', '--surface', '--surface-2', '--field-bg', '--text', '--glass-blur']) {
    assert.ok(
      new RegExp(`${token}\\s*:`).test(block.body),
      `.high-contrast does not override ${token} — the mode would leak the glass palette`
    );
  }

  assert.ok(/--bg:\s*#000000/i.test(block.body), 'high-contrast --bg must be solid black');
  assert.ok(/--surface:\s*#000000/i.test(block.body), 'high-contrast --surface must be solid black');
  assert.ok(/--text:\s*#FFFFFF/i.test(block.body), 'high-contrast --text must be full white');
  assert.ok(/--glass-blur:\s*none/.test(block.body), 'high-contrast must resolve --glass-blur to none');

  // Borders at or above rgba(255,255,255,0.35).
  const border = /--surface-border:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/.exec(block.body);
  assert.ok(border, 'high-contrast must override --surface-border with an rgba white');
  assert.ok(
    parseFloat(border[1]) >= 0.35,
    `high-contrast border alpha must be >= 0.35, got ${border[1]}`
  );

  // Focus rings get thicker.
  const ring = /--focus-ring:\s*(\d+)px/.exec(block.body);
  const baseRing = /:root\s*\{[\s\S]*?--focus-ring:\s*(\d+)px/.exec(css);
  assert.ok(ring && baseRing, 'both :root and .high-contrast must declare --focus-ring');
  assert.ok(
    Number(ring[1]) > Number(baseRing[1]),
    `high-contrast focus ring (${ring[1]}px) must be thicker than the default (${baseRing[1]}px)`
  );

  // And no blur may survive anywhere under the class.
  const disables = css.match(/\.high-contrast[^{]*\{[^}]*backdrop-filter:\s*none/g) || [];
  assert.ok(
    disables.length > 0,
    '.high-contrast must explicitly set backdrop-filter: none on the glass surfaces'
  );
});

s.test('every backdrop-filter is token-driven so high-contrast can switch it off', () => {
  const css = readStyle();
  const rules = css.match(/backdrop-filter:\s*[^;]+;/g) || [];
  assert.ok(rules.length >= 2, 'expected the glass surfaces to declare backdrop-filter');
  for (const rule of rules) {
    assert.ok(
      /var\(--glass-blur\)|none/.test(rule),
      `hard-coded blur outside the token system: ${rule.trim()}`
    );
  }
});

s.test('the token blocks are the only place a hex colour appears', () => {
  const css = readStyle();
  const hits = hexLiterals(css);
  assert.ok(hits.length >= 7, `expected the palette plus the mono overrides, found ${hits.length}`);

  const strays = hits.filter((h) => !/^--[a-zA-Z0-9-]+\s*:/.test(h.text));
  assert.strictEqual(
    strays.length,
    0,
    'hex colour(s) outside a custom-property declaration — theming and high-contrast mode cannot swap these:\n' +
      strays.map((h) => `  line ${h.line}: ${h.hex}  in  ${h.text}`).join('\n')
  );

  // …and those declarations must actually live in one of the SEVEN token
  // blocks: the six palettes (:root = Studio Obsidian, .theme-light = Studio
  // Daylight, plus the four the 0.16.0 suite added) and the .high-contrast
  // override that beats all of them.
  const blocks = TOKEN_BLOCK_SELECTORS.map((selector) => {
    const found = cssBlock(css, selector);
    assert.ok(found, `token block \`${selector} { … }\` is missing`);
    return found;
  });

  for (const hit of hits) {
    const home = blocks.some((b) => hit.index >= b.start && hit.index <= b.end);
    assert.ok(
      home,
      `${hit.hex} on line ${hit.line} is declared outside ${TOKEN_BLOCK_SELECTORS.join(' / ')}`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The Prompt Editor workspace — four zones, a jump strip and a compile rail   */
/*                                                                            */
/* The Editor grew from a stack of nine equal cards into a zoned workspace.    */
/* Everything below is the part of that which is STRUCTURE rather than paint:  */
/* an outline a screen reader can navigate, a layout that reflows on the       */
/* container, and the two rules (scroll-margin, the rail's offset) that must   */
/* agree with a single published length or the whole thing lands under itself. */
/* -------------------------------------------------------------------------- */

s.test('the Editor outline is h2 view > h3 zones > h4 cards, in workflow order', () => {
  const editor = readEditorMarkup();

  // One h2 at the top of the view; the zones hang off it.
  const h2s = editor.match(/<h2\b/g) || [];
  assert.strictEqual(h2s.length, 1, `the Editor view must own exactly one h2, found ${h2s.length}`);
  assert.ok(/<h2 class="view-heading">Prompt Editor<\/h2>/.test(editor), 'the view heading is missing');

  // Four zone headings, in the order the work is done.
  const zones = (editor.match(/<h3 class="zone-heading">([^<]*)<\/h3>/g) || []).map(
    (tag) => /<h3 class="zone-heading">([^<]*)<\/h3>/.exec(tag)[1]
  );
  assert.deepStrictEqual(
    zones,
    EDITOR_ZONES,
    'the four workflow zones must read in order — describe it, shape it, compile it, keep it'
  );

  // Every card heading is one rung DOWN from its zone. Demoting these from h3
  // to h4 is what turns a flat run of ten labels into a navigable outline;
  // ids, classes and text are unchanged, so every aria-labelledby still binds.
  for (const id of EDITOR_CARD_HEADINGS) {
    assert.ok(
      new RegExp(`<h4 id="${id}" class="panel-heading">`).test(editor),
      `#${id} must be an <h4> under its zone heading, not a second h3`
    );
  }

  // …and nothing else in the view may re-enter at h3, or the outline flattens
  // again. The workspace-profile strip is the one allowed exception: it
  // configures the view rather than belonging to a zone.
  const h3s = editor.match(/<h3[^>]*>/g) || [];
  const strays = h3s.filter(
    (tag) => !/class="zone-heading"/.test(tag) && !/id="profile-heading"/.test(tag)
  );
  assert.deepStrictEqual(strays, [], `h3 outside the zone rung: ${strays.join(', ')}`);
});

s.test('no zone heading sits inside a .view-grid, where it would become a stray cell', () => {
  const editor = readEditorMarkup();
  const parents = zoneHeadingParents(editor);
  assert.strictEqual(
    parents.length,
    EDITOR_ZONES.length,
    `expected ${EDITOR_ZONES.length} zone headings, the scanner found ${parents.length}`
  );
  for (let i = 0; i < parents.length; i += 1) {
    assert.ok(
      !/\bview-grid\b/.test(parents[i]),
      `the "${EDITOR_ZONES[i]}" zone heading is a direct child of "${parents[i]}" — inside a ` +
        '.view-grid it becomes a grid item, and the 880px rule would park it beside a card'
    );
  }
  // The two middle zones head the split's own columns; the outer two are
  // view-level. The slice starts INSIDE the view's own <section …> tag, so
  // that element never reaches the stack — '' is "a direct child of the view".
  assert.deepStrictEqual(
    parents,
    ['', 'editor-shape', 'editor-rail', ''],
    'the zone headings are not where the split expects them: Describe and Library are ' +
      'view-level, Shape and Compile head the split’s two columns'
  );
});

s.test('the jump strip is a labelled nav over headings that already exist', () => {
  const editor = readEditorMarkup();
  const css = readStyle();

  const nav = /<nav class="jump-nav" aria-label="([^"]+)">([\s\S]*?)<\/nav>/.exec(editor);
  assert.ok(nav, 'the Prompt Editor has no <nav class="jump-nav"> with an aria-label');
  assert.ok(/\S/.test(nav[1]), 'the jump nav must be named — a landmark with no name is noise');
  assert.strictEqual(nav[1], 'Prompt editor sections');

  const links = nav[2].match(/<a class="chip" href="#([^"]+)">([^<]*)<\/a>/g) || [];
  assert.ok(links.length >= 4, `expected a chip per zone, found ${links.length}`);
  for (const link of links) {
    const target = /href="#([^"]+)"/.exec(link)[1];
    assert.ok(
      editor.indexOf(`id="${target}"`) !== -1,
      `the jump chip points at #${target}, which does not exist in the Editor view`
    );
  }

  // Sticky, and its height published once so two unrelated rules can agree.
  const strip = cssBlock(css, '.jump-nav {');
  assert.ok(strip, 'no .jump-nav rule');
  assert.ok(/position:\s*sticky/.test(strip.body), '.jump-nav must be position: sticky');
  assert.ok(/top:\s*0/.test(strip.body), '.jump-nav must stick to the top of the scrollport');
  assert.ok(
    /background:\s*var\(--bg\)/.test(strip.body),
    'a sticky strip needs an opaque ground or scrolling text reads through it'
  );
  assert.ok(
    /:root\s*\{[\s\S]*?--jumpnav-h:\s*\d+px/.test(css),
    '--jumpnav-h must be declared on :root — the rail offset and the scroll-margin both read it'
  );

  // A jump has to land ON the heading, not under the strip that is covering it.
  assert.ok(
    /\.zone-heading,\s*\.panel-heading\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--jumpnav-h\)/.test(css),
    'both heading levels must reserve scroll-margin-top for the sticky strip'
  );
});

s.test('the wide editor is a THIRD container block that also resets .vibe-grid', () => {
  const css = readStyle();

  const wide = cssBlock(css, '@container editor-view (min-width: 1080px)');
  assert.ok(wide, 'no @container editor-view (min-width: 1080px) block — the rail never appears');

  // It must come after BOTH 880px blocks, which cascade below it.
  const first880 = cssBlock(css, '@container editor-view (min-width: 880px)');
  const second880 = cssBlock(css, '@container editor-view (min-width: 880px)', first880.end);
  assert.ok(second880, 'the two 880px editor blocks are no longer both present');
  assert.ok(
    wide.start > second880.end,
    'the 1080px block must follow both 880px blocks or its resets lose the cascade'
  );

  // The 880px block stays FLAT: tests/vibe-translators.test.js reads it whole
  // with a `\n  }` terminator, which a nested at-rule would truncate.
  assert.ok(
    !/@container/.test(first880.body),
    'the first 880px block must stay flat — no nested at-rules'
  );

  assert.ok(
    /\.editor-split\s*\{[^}]*grid-template-columns:\s*minmax\([^)]*\)\s+minmax/.test(wide.body),
    'the wide layout must split the editor into two columns'
  );

  const rail = /\.editor-rail\s*\{([^}]*)\}/.exec(wide.body);
  assert.ok(rail, 'the 1080px block declares no .editor-rail rule');
  assert.ok(/position:\s*sticky/.test(rail[1]), 'the compile rail must be position: sticky');
  assert.ok(
    /top:\s*calc\(var\(--jumpnav-h\)/.test(rail[1]),
    'the rail must park below the jump strip using the published --jumpnav-h'
  );
  assert.ok(/overflow:\s*auto/.test(rail[1]), 'a capped rail must be able to scroll its own overflow');

  // The 880px rule queries the VIEW, not the column. Without this reset the
  // scene and slider cards get two ~290px cells inside the shape column.
  assert.ok(
    /\.vibe-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;?\s*\}/.test(wide.body),
    'the 1080px block must reset .vibe-grid to a single column inside the split'
  );
});

s.test('every editor card answers to the `dissector` container — exclusions and style included', () => {
  const css = readStyle();
  const selectors = [];
  const re = /([^{}]+)\{\s*container-name:\s*dissector\s*;?\s*\}/g;
  let m;
  while ((m = re.exec(css)) !== null) selectors.push(m[1]);
  const named = selectors.join(' ');
  assert.ok(named.length > 0, 'nothing declares container-name: dissector any more');

  for (const panel of [
    '.dissector-panel',
    '.editor-output',
    '.scene-panel',
    '.slider-panel',
    '.vocal-panel',
    '.structure-panel',
    '.draft-panel',
    // These two were missing, which made the 520px .exclude-row and .draft-foot
    // rules dead CSS — they never had a named container to match against.
    '.exclude-panel',
    '.style-panel',
  ]) {
    assert.ok(
      new RegExp(`\\${panel}(?![a-zA-Z0-9_-])`).test(named),
      `${panel} declares no container-name: dissector, so the 520px stacking rules never fire in it`
    );
  }

  // And the rules that depend on it are really there to fire.
  const narrow = cssBlock(css, '@container dissector (max-width: 520px)');
  assert.ok(narrow, 'no @container dissector (max-width: 520px) block');
  assert.ok(/\.exclude-row\s*\{[^}]*flex-direction:\s*column/.test(narrow.body));
  assert.ok(/\.draft-foot\s*\{[^}]*flex-direction:\s*column/.test(narrow.body));
});

s.test('the dissector is a card; its results column is one only when it HAS results', () => {
  const editor = readEditorMarkup();
  const css = readStyle();

  assert.ok(
    /<section class="view-col vibe-card dissector-panel"/.test(editor),
    'the dissector panel must be a .vibe-card like the eight boxes under it'
  );

  const gated = cssBlock(css, '.editor-output:has(#dissect-results:not([hidden]))');
  assert.ok(gated, 'the results column is not carded on a :has() gate');
  for (const decl of ['padding:', 'background:', 'border:', 'border-radius:']) {
    assert.ok(gated.body.indexOf(decl) !== -1, `the gated card is missing ${decl}`);
  }

  // Honest empty state: the column holds nothing but a [hidden] #dissect-results
  // until a dissection runs, so an UNCONDITIONAL card would paint an empty box.
  const bare = /\.editor-output\s*\{([^}]*)\}/.exec(css);
  if (bare) {
    assert.ok(
      !/background:|border:|padding:/.test(bare[1]),
      'an unconditional .editor-output card would print an empty box before the first dissection'
    );
  }
});

s.test('the Style prompt card carries primary weight in BOTH the glass and Code modes', () => {
  const css = readStyle();

  const style = cssBlock(css, '.style-panel {');
  assert.ok(style, 'no .style-panel rule');
  assert.ok(
    /box-shadow:\s*var\(--glow-cyan\)/.test(style.body),
    'the compiled-prompt card must borrow the shared "this element is live" glow'
  );
  assert.ok(
    /border-color:\s*var\(--tint-cyan-border\)/.test(style.body),
    'the card must take the accent border, not the neutral hairline of its feeders'
  );
  assert.ok(
    /background:\s*color-mix\(/.test(style.body),
    'the card must lift its ground off the shared card wash with a mixed token'
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(style.body),
    `the emphasis must be token-only, no literal: ${style.body.trim()}`
  );

  // The companion is not optional: Code Mode flattens every wash and kills
  // every glow, so without it this card quietly becomes a sibling again.
  const contrast = cssBlock(css, '.high-contrast .style-panel');
  assert.ok(
    contrast,
    'Code Mode has no .style-panel override — the emphasis silently vanishes in the legibility mode'
  );
  assert.ok(/background:\s*var\(--bg\)/.test(contrast.body), 'Code Mode must flatten the wash to --bg');
  assert.ok(
    /border:\s*1px solid var\(--accent-cyan\)/.test(contrast.body),
    'with the wash and the glow gone the accent border has to carry the whole signal'
  );
});

s.test('a finished dissection moves focus to its results', () => {
  const editor = readEditorMarkup();
  const source = extractScriptById(INDEX, 'app-main');

  const tag = /<div id="dissect-results"[^>]*>/.exec(editor);
  assert.ok(tag, '#dissect-results is missing');
  assert.ok(
    /tabindex="-1"/.test(tag[0]),
    '#dissect-results must be programmatically focusable without adding a tab stop'
  );
  assert.ok(/\bhidden\b/.test(tag[0]), 'the results must still start hidden — nothing has been dissected');

  // The focus move belongs where [hidden] comes off, not beside the click.
  assert.ok(
    /dissectResults\.hidden = false;[\s\S]{0,1400}?dissectResults\.focus\(\);/.test(source),
    'nothing focuses #dissect-results when it is unhidden — the next Tab walks the whole form'
  );
  // One live region for this action, not two: #dissect-status already speaks.
  const focusCalls = source.match(/dissectResults\.focus\(\)/g) || [];
  assert.strictEqual(focusCalls.length, 1, 'focus must move exactly once, where the panel is revealed');
});

s.test('the jump strip’s smooth scroll is motion, and the reduced-motion guard turns it off', () => {
  const css = readStyle();
  assert.ok(
    /\bhtml\s*\{[^}]*scroll-behavior:\s*smooth/.test(css),
    'the jump strip has no smooth scrolling to guard'
  );
  let from = 0;
  let guarded = false;
  for (;;) {
    const block = cssBlock(css, '@media (prefers-reduced-motion: reduce)', from);
    if (!block) break;
    if (/scroll-behavior:\s*auto/.test(block.body)) guarded = true;
    from = block.end;
  }
  assert.ok(guarded, 'no prefers-reduced-motion block resets scroll-behavior to auto');
});

s.test('the split puts the feeders in the shape column and the compiled output in the rail', () => {
  const editor = readEditorMarkup();

  const split = sliceByClass(editor, 'editor-split');
  assert.ok(split, 'there is no .editor-split wrapper — the zoned layout has been undone');
  const shape = sliceByClass(split, 'editor-shape');
  const rail = sliceByClass(split, 'editor-rail');
  assert.ok(shape, '.editor-split has no .editor-shape column');
  assert.ok(rail, '.editor-split has no .editor-rail column');

  // Which side a card lands on is not cosmetic: everything in the rail becomes
  // position: sticky at 1080px, so a feeder parked there would pin an INPUT to
  // the viewport, and a compiled card left behind in the shape column would go
  // on scrolling away from the controls that change it — the exact problem the
  // split exists to fix.
  for (const card of EDITOR_SHAPE_CARDS) {
    assert.ok(shape.indexOf(card) !== -1, `.${card} feeds the prompt and belongs in the shape column`);
    assert.ok(rail.indexOf(card) === -1, `.${card} is an input; the sticky rail must not hold it`);
  }
  for (const card of EDITOR_RAIL_CARDS) {
    assert.ok(rail.indexOf(card) !== -1, `.${card} is part of the compiled output and belongs in the rail`);
    assert.ok(shape.indexOf(card) === -1, `.${card} must not be left behind in the scrolling column`);
  }

  // The two full-width grids stay OUTSIDE the split. .editor-grid keeps its own
  // 880px two-column rule, and .persist-grid's two virtualised lists measure
  // their own height on view entry — which a clipped, sticky column breaks.
  for (const outside of ['editor-grid', 'persist-grid']) {
    assert.ok(editor.indexOf(outside) !== -1, `.${outside} has gone missing from the view`);
    assert.ok(
      split.indexOf(outside) === -1,
      `.${outside} has been pulled inside .editor-split; it must stay full width`
    );
  }

  // Below 1080px the split IS the old single-column stack, so wrapping the
  // cards must not have reordered a single one of them.
  assert.deepStrictEqual(
    cardOrder(editor),
    EDITOR_CARD_ORDER,
    'the split reordered the document — the stacked reading order must survive it byte for byte'
  );
});

s.test('.editor-split has no column rule below 1080px, so it stacks like it always did', () => {
  const css = readStyle();
  const first = cssBlock(css, '@container editor-view (min-width: 880px)');
  assert.ok(first, 'the first 880px editor block is gone');
  const second = cssBlock(css, '@container editor-view (min-width: 880px)', first.end);
  assert.ok(second, 'the second 880px editor block (the :has() collapse) is gone');
  for (const block of [first, second]) {
    assert.ok(
      block.body.indexOf('.editor-split') === -1,
      'an 880px rule mentions .editor-split — the rail would appear ~200px too early, ' +
        'inside a column too narrow for the exclusion row it carries'
    );
  }
  // …and the base rule is a plain .view-grid, i.e. one column until 1080.
  assert.ok(
    /<div class="view-grid editor-split">/.test(readEditorMarkup()),
    '.editor-split must ride the shared .view-grid base (one column, 24px/16px gap)'
  );
});

s.test('a zone heading really cancels the 24px margin under it, rather than tying and losing', () => {
  const css = readStyle();
  const editor = readEditorMarkup();

  // The one-class form is the trap: `.zone-heading + *` READS correct and does
  // nothing, because every margin it cancels is also a one-class rule and is
  // declared later in this sheet. Equal specificity, later wins, reset dead.
  assert.ok(
    !/\.zone-heading\s*\+\s*\*/.test(css),
    '`.zone-heading + *` ties at (0,1,0) with .vibe-grid / .persist-grid / .draft-panel ' +
      'and loses on source order — it would be dead CSS that looks right'
  );
  const reset = /\.zone-heading\s*\+\s*\.view-grid\s*,\s*\.zone-heading\s*\+\s*\.vibe-card\s*\{([^}]*)\}/.exec(css);
  assert.ok(reset, 'no two-class `.zone-heading + .view-grid, .zone-heading + .vibe-card` reset');
  assert.ok(/margin-top:\s*0/.test(reset[1]), 'the reset must zero the top margin');

  // Prove the trap is real rather than theoretical: each margin it cancels is
  // a single-class rule sitting AFTER the reset.
  for (const later of ['.vibe-grid', '.persist-grid', '.draft-panel']) {
    const rule = new RegExp(`\\${later}\\s*\\{[^}]*margin-top:\\s*24px`).exec(css);
    assert.ok(rule, `${later} no longer carries the 24px margin this reset exists to cancel`);
    assert.ok(
      rule.index > reset.index,
      `${later} is declared before the reset, so this test no longer proves anything — ` +
        're-check the specificity argument if the sheet has been reordered'
    );
  }

  // And every zone opens with an element the reset can actually reach.
  const openers = editor
    .split(/<h3 class="zone-heading">/)
    .slice(1)
    .map((rest) => {
      const tag = /<(?:div|section)\b[^>]*class="([^"]*)"/.exec(rest.replace(/<!--[\s\S]*?-->/g, ''));
      return tag ? tag[1] : '';
    });
  assert.strictEqual(openers.length, EDITOR_ZONES.length);
  for (let i = 0; i < openers.length; i += 1) {
    const classes = openers[i].trim().split(/\s+/);
    assert.ok(
      classes.indexOf('view-grid') !== -1 || classes.indexOf('vibe-card') !== -1,
      `the "${EDITOR_ZONES[i]}" zone opens with "${openers[i]}", which the two-class reset ` +
        'cannot match — its own 24px margin would double the gap under the heading'
    );
  }
});

s.test('the heading scale is a real outline: view > zone > card, on size as well as colour', () => {
  const css = readStyle();
  /* `.panel-heading {` also opens the shared scroll-margin rule a few hundred
   * lines earlier, so take the first block that actually SETS a size rather
   * than the first block whose prelude mentions the class. */
  const typeBlock = (selector, needle) => {
    let from = 0;
    for (;;) {
      const block = cssBlock(css, selector, from);
      assert.ok(block, `no ${selector} rule declaring ${needle}`);
      if (block.body.indexOf(needle) !== -1) return block;
      from = block.end;
    }
  };
  const rem = (selector) => parseFloat(/font-size:\s*([\d.]+)rem/.exec(typeBlock(selector, 'font-size:').body)[1]);
  const view = rem('.view-heading {');
  const zone = rem('.zone-heading {');
  const card = rem('.panel-heading {');

  assert.ok(view > zone, `.view-heading (${view}rem) must out-rank the zone headings (${zone}rem)`);
  // The rung that is easy to get wrong. .panel-heading is ALSO an uppercase,
  // tracked, small-caps label, so a zone heading set from .profile-heading's
  // 0.82rem lands BELOW the cards it gathers and the outline reads inverted —
  // an h3 printed smaller and lighter than the h4s under it.
  assert.ok(
    zone > card,
    `.zone-heading (${zone}rem) must out-rank .panel-heading (${card}rem); both are uppercase ` +
      'tracked labels, so size is what separates the rungs'
  );
  const zoneBlock = typeBlock('.zone-heading {', 'color:');
  const cardBlock = typeBlock('.panel-heading {', 'color:');
  assert.ok(
    /color:\s*var\(--text\)\s*;/.test(zoneBlock.body),
    'a zone heading takes the full-contrast foreground'
  );
  assert.ok(
    /color:\s*var\(--text-dim\)/.test(cardBlock.body),
    'the card headings stay dim under it — if this changed, the colour half of the rung is gone'
  );
});

s.test('the jump chips run in the same order as the headings they point at', () => {
  const editor = readEditorMarkup();
  const nav = /<nav class="jump-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(editor);
  assert.ok(nav, 'no jump nav');

  const targets = [];
  const re = /<a class="chip" href="#([^"]+)">/g;
  let m;
  while ((m = re.exec(nav[1])) !== null) targets.push(m[1]);
  assert.ok(targets.length >= 4, `expected a chip per zone, found ${targets.length}`);

  // A strip whose chips do not descend the page is a menu, not a map: the
  // reader cannot use position in the strip to guess position in the document.
  const positions = targets.map((id) => {
    const at = editor.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `the jump chip points at #${id}, which is not in the Editor view`);
    return at;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i] > positions[i - 1],
      `chip ${i + 1} (#${targets[i]}) points ABOVE chip ${i} (#${targets[i - 1]}) — ` +
        'the strip must read top to bottom like the workspace it maps'
    );
  }

  // Both ends of the workspace are reachable: the first chip lands in the first
  // zone and the last one in the Library, which is the furthest scroll.
  assert.strictEqual(targets[0], 'dissect-heading');
  assert.strictEqual(targets[targets.length - 1], 'history-heading');
});

s.test('a narrow editor unsticks the strip AND stops reserving room for it', () => {
  const css = readStyle();
  const narrow = cssBlock(css, '@container editor-view (max-width: 520px)');
  assert.ok(narrow, 'no @container editor-view (max-width: 520px) block');
  assert.ok(
    /\.jump-nav\s*\{[^}]*position:\s*static/.test(narrow.body),
    'a two-line chip strip permanently parked at the top of a 285px column is most of the screen'
  );
  assert.ok(
    /\.jump-nav\s*\{[^}]*min-height:\s*0/.test(narrow.body),
    'a static strip must not keep reserving --jumpnav-h of height'
  );
  // The half that is easy to forget: with nothing sticky above them, headings
  // that still reserved 56px would open every jump with a band of dead space.
  assert.ok(
    /\.zone-heading,\s*\.panel-heading\s*\{[^}]*scroll-margin-top:\s*12px/.test(narrow.body),
    'the jump targets must release the scroll-margin they reserved for the strip'
  );
  // It has to come after the base rule to win — same specificity, later wins.
  const base = css.indexOf('scroll-margin-top: calc(var(--jumpnav-h)');
  assert.ok(base !== -1 && narrow.start > base, 'the 520px override must follow the base scroll-margin rule');
});

/* ------------------------------------------------------------------------ *
 * TODO: coverage that activates with later features.
 * ------------------------------------------------------------------------ */

s.todo(
  'the tablist grows a third view without the keyboard model changing',
  'activates when the Structure Builder ships as its own view; assert tabKeyTarget wraps across 3 and that register/switchTo need no new branches'
);
s.todo(
  'high-contrast mode is asserted against measured contrast ratios, not token identity',
  'needs a headless browser with getComputedStyle to sample real foreground/background pairs; today the tokens are checked structurally'
);
s.todo(
  'the container-query breakpoint is verified against a real laid-out view',
  'needs the browser E2E harness; today the 880px rule is asserted statically'
);
s.todo(
  'the compile rail is proven to STICK, not merely to declare position: sticky',
  'needs a headless browser: scroll the workspace and assert the rail’s ' +
    'getBoundingClientRect().top stays pinned at --jumpnav-h + 12px while the shape ' +
    'column scrolls past it. Measured in Chrome for 0.15.0 at a 1110px container — rail ' +
    'top held at exactly 56px across scrollY 1400→2000 while .editor-shape ran -213→-813, ' +
    'and released at the bottom of .editor-split as sticky should. Asserted structurally here.'
);
s.todo(
  'the jump chips are proven to LAND below the strip, not merely to reserve scroll-margin',
  'same harness: click each chip and assert the target heading’s rect.top lands at the ' +
    'strip’s bottom edge. Measured in Chrome for 0.15.0 — four of the five landed at ' +
    'top 56px against a 45px strip (11px clear); the Compile chip lands INSIDE the rail’s ' +
    'own scrollport, which reveals the heading without pinning it to the rail’s top.'
);

module.exports = {
  loadAppSandbox,
  fakeEl,
  fakeStorage,
  makeShell,
  cssBlock,
  hexLiterals,
  stripCssComments,
  readEditorMarkup,
  zoneHeadingParents,
  sliceByClass,
  cardOrder,
};

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
