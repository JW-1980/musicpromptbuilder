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
/* The blocks allowed to hold a raw colour literal, in stylesheet order. The
 * two palettes must come before the Code Mode override, which wins on equal
 * specificity purely by sitting last. */
const TOKEN_BLOCK_SELECTORS = [':root {', '.theme-light {', '.high-contrast {'];
const EXPECTED_VERSION = '0.14.0';
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

s.test(`APP_VERSION is ${EXPECTED_VERSION} — the ribbon-refinement release (§1.5 gating, response curve, sub-row scroll, analytic lighting)`, () => {
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

  // …and those declarations must actually live in one of the THREE token
  // blocks: the two palettes (:root = Studio Obsidian, .theme-light = Studio
  // Daylight) and the .high-contrast override that beats both.
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

module.exports = {
  loadAppSandbox,
  fakeEl,
  fakeStorage,
  makeShell,
  cssBlock,
  hexLiterals,
  stripCssComments,
};

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
