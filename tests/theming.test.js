'use strict';
/*
 * tests/theming.test.js — user-configurable colour, the dark/light switcher
 * and the Studio Daylight palette (docs/FDD.md §6 + #17).
 *
 * Four halves, all dependency-free:
 *
 *   1. PREFERENCES. `createThemePrefs` is exercised in a node:vm context with
 *      no `document`, `window` or `localStorage`: a recording fake storage and
 *      an injected `matchMedia` prove the system-preference default, that an
 *      explicit choice outranks it forever, and that a record written by an
 *      older release still loads.
 *
 *   2. VALIDATION. `normalizeColorValue` is the ONLY thing standing between a
 *      stored string and an inline custom property on <html>, so it is
 *      attacked rather than sampled: a battery of hostile payloads must all be
 *      rejected with nothing persisted, while every accepted form round-trips.
 *
 *   3. APPLICATION. `applyThemeState` is driven against a fake document to
 *      prove the cascade contract that CSS alone cannot express — inline user
 *      colours beat the palette, and Code Mode beats the inline colours by
 *      having them SUSPENDED for its duration and restored afterwards.
 *
 *   4. STATIC CONTRACTS. The palette itself is CSS, so it is parsed: the two
 *      palette blocks must be a name-for-name mirror, every documented
 *      contrast ratio is RECOMPUTED from the declarations it documents, every
 *      derived token must reduce to palette tokens, and no colour literal of
 *      any form may sit outside a token block.
 *
 * Node built-ins only: fs, path, assert, vm (via the shared helpers).
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { suite } = require('./lib/runner.js');
const { loadAppSandbox, fakeEl, fakeStorage, cssBlock, stripCssComments } = require('./ui-layout.test.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const PREFS_KEY = 'suno_ui_prefs';
const LIGHT_CLASS = 'theme-light';
const CONTRAST_CLASS = 'high-contrast';

/* The four palette tokens the light theme had to re-derive, and the AA floor
 * every one of them has to clear against the light --bg for text-sized use. */
const CORRECTED_ACCENTS = ['--accent-cyan', '--accent-violet', '--warning-amber', '--danger-crimson'];
const AA_NORMAL_TEXT = 4.5;

/* -------------------------------------------------------------------------- */
/* Fakes (test-only)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Re-create a value produced inside the node:vm context as a plain object of
 * THIS realm. `deepStrictEqual` compares prototypes, and an object literal
 * built inside a vm context has that context's Object.prototype — so without
 * this every structural comparison fails with "same structure but not
 * reference-equal", which says nothing about the code under test.
 */
function realm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * assert.deepStrictEqual with both sides normalised into this realm first.
 * Every structural comparison in this suite goes through it, so a value that
 * crossed the vm boundary is compared on its CONTENT rather than on which
 * realm's Object.prototype it happens to carry.
 */
function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(realm(actual), realm(expected), message);
}

/**
 * The smallest object applyThemeState can drive: a root element with a
 * classList and an inline `style` that records every property write, plus the
 * one <meta> the function looks up by selector.
 */
function fakeDoc() {
  const props = Object.create(null);
  const calls = [];
  const root = fakeEl();

  root.style = {
    setProperty(name, value) {
      props[name] = String(value);
      calls.push({ op: 'set', name, value: String(value) });
    },
    removeProperty(name) {
      delete props[name];
      calls.push({ op: 'remove', name });
    },
    getPropertyValue(name) {
      return name in props ? props[name] : '';
    },
  };

  const meta = {
    attrs: { name: 'color-scheme', content: 'dark' },
    setAttribute(name, value) {
      meta.attrs[name] = String(value);
    },
    getAttribute(name) {
      return name in meta.attrs ? meta.attrs[name] : null;
    },
  };

  return {
    documentElement: root,
    querySelector(selector) {
      return selector === 'meta[name="color-scheme"]' ? meta : null;
    },
    // Test-only handles.
    root,
    meta,
    props,
    calls,
    /** The inline custom properties currently set, as a plain object. */
    snapshot() {
      const out = {};
      for (const key of Object.keys(props)) out[key] = props[key];
      return out;
    },
  };
}

/**
 * A matchMedia stand-in that answers exactly one prefers-color-scheme value.
 * @param {'dark'|'light'|'none'} preference
 */
function fakeMatchMedia(preference) {
  const seen = [];
  const fn = function (query) {
    seen.push(query);
    return { matches: preference !== 'none' && query.indexOf(preference) !== -1 };
  };
  fn.queries = seen;
  return fn;
}

/* -------------------------------------------------------------------------- */
/* Stylesheet helpers                                                         */
/* -------------------------------------------------------------------------- */

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/** The inline <style> block WITH its comments — the palette documents itself. */
function readStyleRaw() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return m[1];
}

/** The inline <style> block with comments blanked out (line numbers preserved). */
function readStyle() {
  return stripCssComments(readStyleRaw());
}

/**
 * Every custom-property declaration in a CSS block body, as {name: value}.
 * Nested blocks are not expected inside a token block, so a flat scan is exact.
 */
function declarations(body) {
  const out = Object.create(null);
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

/**
 * Does this token's value carry a colour? `#hex`, `rgb()/rgba()` and
 * `color-mix()` do; `blur(14px)`, `2px`, a font stack and a cubic-bezier do
 * not. This is what separates the palette (which both themes must mirror) from
 * the typography and timing tokens (which a theme has no business touching).
 */
function isColorValue(value) {
  return /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bcolor-mix\(/.test(value);
}

function colorTokenNames(body) {
  const decls = declarations(body);
  return Object.keys(decls)
    .filter((name) => isColorValue(decls[name]))
    .sort();
}

/* --- Colour maths (WCAG 2.x relative luminance / contrast ratio) ---------- */

function parseCssColor(text) {
  const value = String(text).trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (hex) {
    return {
      r: parseInt(hex[1].slice(0, 2), 16),
      g: parseInt(hex[1].slice(2, 4), 16),
      b: parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (fn) {
    const n = fn[1].split(',').map((part) => Number(part.trim()));
    if (n.length >= 3 && n.slice(0, 3).every((v) => Number.isFinite(v))) {
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 && Number.isFinite(n[3]) ? n[3] : 1 };
    }
  }
  return null;
}

/** Composite a (possibly translucent) colour over an opaque one. */
function compositeOver(fg, bg) {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  };
}

function relativeLuminance(color) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of `value` (composited if translucent) against `bgValue`. */
function ratioAgainst(value, bgValue) {
  const fg = parseCssColor(value);
  const bg = parseCssColor(bgValue);
  assert.ok(fg, `not a parseable colour: ${value}`);
  assert.ok(bg, `not a parseable background: ${bgValue}`);
  return contrastRatio(compositeOver(fg, bg), bg);
}

const s = suite('theming (Studio Daylight + user-configurable tokens)');

/* -------------------------------------------------------------------------- */
/* 1. createThemePrefs — theme + custom colours                               */
/* -------------------------------------------------------------------------- */

s.test('the theming layer is reachable as top-level function declarations', () => {
  const app = loadAppSandbox();
  for (const name of [
    'createThemePrefs',
    'applyThemeState',
    'normalizeColorValue',
    'parseColorParts',
    'composeColorValue',
    'isThemableToken',
  ]) {
    assert.strictEqual(
      typeof app.sandbox[name],
      'function',
      `${name} must be a top-level \`function\` declaration, before the boot IIFE`
    );
  }
  assert.ok(Array.isArray(app.sandbox.THEMABLE_TOKENS), 'THEMABLE_TOKENS must be a top-level var');
});

s.test('the theme choice persists under suno_ui_prefs alongside the existing flag', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  assert.strictEqual(prefs.getTheme(), null, 'an untouched install has made no choice');
  assert.strictEqual(storage.writes.length, 0, 'reading a preference must not write one');

  assert.strictEqual(prefs.setTheme('light'), 'light', 'setTheme returns the theme now in effect');
  assert.strictEqual(prefs.getTheme(), 'light');
  assert.strictEqual(prefs.resolvedTheme(), 'light');

  deepEqual(storage.keysWritten(), [PREFS_KEY], 'only the one UI-state key is written');
  const stored = JSON.parse(storage.data[PREFS_KEY]);
  assert.strictEqual(stored.theme, 'light');
  assert.strictEqual(stored.highContrast, false, 'the older field must survive the new one');
  deepEqual(stored.customColors, {}, 'the record carries all three fields');

  // A fresh instance over the same storage must come back to the same place.
  const reloaded = app.sandbox.createThemePrefs({ storage });
  reloaded.load();
  assert.strictEqual(reloaded.getTheme(), 'light', 'the choice did not survive a reload');
});

s.test('setTheme accepts only the two themes, and null hands the vote back to the OS', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage, matchMedia: fakeMatchMedia('light') });

  prefs.setTheme('dark');
  assert.strictEqual(prefs.getTheme(), 'dark');
  assert.strictEqual(prefs.resolvedTheme(), 'dark', 'an explicit dark beats a light system');

  const writesBefore = storage.writes.length;
  for (const bogus of ['Light', 'DARK', 'sepia', 42, {}, [], true]) {
    assert.strictEqual(
      prefs.setTheme(bogus),
      'dark',
      `setTheme(${JSON.stringify(bogus)}) must change nothing`
    );
    assert.strictEqual(prefs.getTheme(), 'dark');
  }
  assert.strictEqual(
    storage.writes.length,
    writesBefore,
    'a rejected theme must not touch storage either'
  );

  assert.strictEqual(prefs.setTheme(null), 'light', 'clearing the choice re-consults the system');
  assert.strictEqual(prefs.getTheme(), null);
  assert.strictEqual(prefs.setTheme('system'), 'light', '"system" is the same instruction as null');
  assert.strictEqual(JSON.parse(storage.data[PREFS_KEY]).theme, null);
});

s.test('the system preference decides only while the user has not, via injected matchMedia', () => {
  const app = loadAppSandbox();

  const dark = fakeMatchMedia('dark');
  const followsDark = app.sandbox.createThemePrefs({ storage: fakeStorage(), matchMedia: dark });
  assert.strictEqual(followsDark.getTheme(), null);
  assert.strictEqual(followsDark.resolvedTheme(), 'dark', 'system dark must resolve to dark');
  assert.ok(dark.queries.length > 0, 'matchMedia must actually be consulted');
  assert.ok(
    dark.queries.every((q) => /prefers-color-scheme/.test(q)),
    `only prefers-color-scheme may be queried, saw: ${dark.queries.join(', ')}`
  );

  const light = app.sandbox.createThemePrefs({
    storage: fakeStorage(),
    matchMedia: fakeMatchMedia('light'),
  });
  assert.strictEqual(light.resolvedTheme(), 'light', 'system light must resolve to light');
  light.setTheme('dark');
  assert.strictEqual(light.resolvedTheme(), 'dark', 'an explicit choice always wins');
  light.setTheme(null);
  assert.strictEqual(light.resolvedTheme(), 'light', '…and giving it up hands the vote back');

  // No opinion, no matchMedia at all, and a matchMedia that throws: all three
  // must land on the house theme rather than anywhere undefined.
  const none = app.sandbox.createThemePrefs({ matchMedia: fakeMatchMedia('none') });
  assert.strictEqual(none.resolvedTheme(), 'dark');
  assert.strictEqual(app.sandbox.createThemePrefs({}).resolvedTheme(), 'dark');
  const hostile = app.sandbox.createThemePrefs({
    matchMedia: function () {
      throw new Error('SecurityError: matchMedia is blocked in this context');
    },
  });
  assert.doesNotThrow(() => hostile.resolvedTheme(), 'a throwing matchMedia must be swallowed');
  assert.strictEqual(hostile.resolvedTheme(), 'dark');
});

s.test('a pre-theming {highContrast:true} record still loads exactly as it reads', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage({ [PREFS_KEY]: JSON.stringify({ highContrast: true }) });
  const prefs = app.sandbox.createThemePrefs({ storage, matchMedia: fakeMatchMedia('light') });

  assert.strictEqual(prefs.load(), true, 'load() still reports the high-contrast flag');
  assert.strictEqual(prefs.isHighContrast(), true, 'the legacy field must be honoured');
  assert.strictEqual(prefs.getTheme(), null, 'a record with no theme has expressed no choice');
  assert.strictEqual(prefs.resolvedTheme(), 'light', '…so the system preference applies');
  deepEqual(prefs.getCustomColors(), {}, 'and there are no colours to restore');
  assert.strictEqual(storage.writes.length, 0, 'reading an old record must not rewrite it');
});

s.test('corrupt, foreign or hostile stored records degrade to defaults without throwing', () => {
  const app = loadAppSandbox();
  const corrupt = [
    '{oops',
    '',
    ' ',
    'null',
    'true',
    '5',
    '"theme"',
    '[]',
    '[{"theme":"light"}]',
    '{"theme":"sepia"}',
    '{"theme":true}',
    '{"theme":["light"],"customColors":"red"}',
    '{"customColors":{"--bg":"url(javascript:alert(1))"}}',
    '{"customColors":{"--glass-blur":"none"}}',
    '{"customColors":[["--bg","#fff"]]}',
  ];

  for (const raw of corrupt) {
    const storage = fakeStorage({ [PREFS_KEY]: raw });
    const prefs = app.sandbox.createThemePrefs({ storage });
    assert.doesNotThrow(() => prefs.load(), `load() threw on stored value ${JSON.stringify(raw)}`);
    assert.strictEqual(prefs.isHighContrast(), false, `highContrast leaked from ${raw}`);
    assert.strictEqual(prefs.getTheme(), null, `a theme leaked from ${raw}`);
    deepEqual(
      prefs.getCustomColors(),
      {},
      `a colour override survived validation from ${raw}`
    );
    assert.strictEqual(storage.writes.length, 0, 'a bad read must not trigger a repair write');
  }
});

s.test('stored colours are re-validated on load, entry by entry', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage({
    [PREFS_KEY]: JSON.stringify({
      highContrast: false,
      theme: 'light',
      customColors: {
        '--accent-cyan': '#FF0000',
        '--bg': 'rgba(1, 2, 3, 0.5)',
        '--text': 'red; background: url(x)',
        '--glass-blur': 'blur(0)',
        '--not-a-token': '#FFFFFF',
      },
    }),
  });
  const prefs = app.sandbox.createThemePrefs({ storage });
  prefs.load();

  deepEqual(
    prefs.getCustomColors(),
    { '--accent-cyan': '#FF0000', '--bg': 'rgba(1, 2, 3, 0.5)' },
    'exactly the valid, themable entries survive — the rest are dropped silently'
  );
  assert.strictEqual(prefs.getTheme(), 'light', 'a bad sibling entry must not poison the theme');

  // Validation is per FIELD, not per record: one unusable field is dropped on
  // its own rather than throwing away a perfectly good choice beside it.
  const partial = fakeStorage({
    [PREFS_KEY]: JSON.stringify({ highContrast: true, theme: 'dark', customColors: 'red' }),
  });
  const survivor = app.sandbox.createThemePrefs({ storage: partial });
  survivor.load();
  assert.strictEqual(survivor.isHighContrast(), true);
  assert.strictEqual(survivor.getTheme(), 'dark');
  deepEqual(survivor.getCustomColors(), {}, 'a non-object customColors degrades to no overrides');
});

s.test('getCustomColors hands back a copy, so a caller cannot edit the record behind its back', () => {
  const app = loadAppSandbox();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  prefs.setCustomColor('--bg', '#123456');

  const first = prefs.getCustomColors();
  first['--bg'] = 'stolen';
  first['--text'] = 'injected';
  deepEqual(
    prefs.getCustomColors(),
    { '--bg': '#123456' },
    'mutating the returned object must not reach the stored record'
  );
});

s.test('clearCustomColors drops every override and persists the emptiness', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  prefs.setCustomColor('--bg', '#101014');
  prefs.setCustomColor('--accent-cyan', '#FF00AA');
  assert.strictEqual(Object.keys(prefs.getCustomColors()).length, 2);

  prefs.clearCustomColors();
  deepEqual(prefs.getCustomColors(), {});
  deepEqual(JSON.parse(storage.data[PREFS_KEY]).customColors, {});
  for (const key of storage.keysWritten()) {
    assert.strictEqual(key, PREFS_KEY, `an unexpected key was written: "${key}"`);
  }
});

s.test('a hostile or absent storage never breaks a theme or a colour change', () => {
  const app = loadAppSandbox();

  const noStorage = app.sandbox.createThemePrefs({});
  assert.strictEqual(noStorage.setTheme('light'), 'light', 'the in-memory state must still flip');
  assert.strictEqual(noStorage.setCustomColor('--bg', '#FFFFFF'), true);

  const hostile = app.sandbox.createThemePrefs({
    storage: {
      getItem() {
        throw new Error('SecurityError: storage is disabled');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    },
  });
  assert.doesNotThrow(() => {
    hostile.load();
    hostile.setTheme('light');
    hostile.setCustomColor('--accent-cyan', '#00FF00');
    hostile.clearCustomColors();
  }, 'a throwing storage must be swallowed, not propagated into boot');
  assert.strictEqual(hostile.resolvedTheme(), 'light', 'the choice still has to be applied');
});

/* -------------------------------------------------------------------------- */
/* 2. Validation — the only gate between a string and an inline style          */
/* -------------------------------------------------------------------------- */

s.test('every hostile colour payload is rejected, and NOTHING is persisted', () => {
  const app = loadAppSandbox();
  const hostile = [
    'url(javascript:alert(1))',
    'red; background:url(x)',
    '#00F0FF; --text: #000',
    'var(--accent-cyan)',
    'var(--x, #fff)',
    '#GGG',
    '#12345',
    '#1234',
    'rgba(300,0,0,2)',
    'rgb(-1,0,0)',
    'rgba(0,0,0,1.5)',
    'expression(alert(1))',
    'javascript:alert(1)',
    'red',
    'transparent',
    'currentColor',
    'hsl(180 100% 50%)',
    'color-mix(in srgb, red 50%, blue)',
    '#00F0FF !important',
    'rgb(0,0,0)/*',
    'рed', // Cyrillic homoglyph of "red"
    '＃00F0FF', // fullwidth number sign
    '#00F0FF​', // zero-width space smuggled onto a valid value
    '#'.repeat(200),
    'rgba(' + '0,'.repeat(40) + '1)',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    [],
    ['#000000'],
    { toString: () => '#000000' },
  ];
  assert.ok(hostile.length >= 12, 'the battery must be a battery');

  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  for (const payload of hostile) {
    assert.strictEqual(
      app.sandbox.normalizeColorValue(payload),
      null,
      `normalizeColorValue accepted ${JSON.stringify(String(payload))}`
    );
    assert.strictEqual(
      prefs.setCustomColor('--bg', payload),
      false,
      `setCustomColor accepted ${JSON.stringify(String(payload))}`
    );
  }

  deepEqual(prefs.getCustomColors(), {}, 'a rejected value must leave no trace');
  assert.strictEqual(storage.writes.length, 0, 'a rejected value must not even reach storage');
});

s.test('an unknown token name is refused however valid the colour is', () => {
  const app = loadAppSandbox();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });

  for (const token of [
    '--glass-blur',
    '--font-ui',
    '--vt-out',
    '--focus-ring',
    '--tint-cyan',
    '--glow-cyan',
    '--pulse-ring',
    'bg',
    '--BG',
    '--bg ',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.strictEqual(
      app.sandbox.isThemableToken(token),
      false,
      `${JSON.stringify(token)} must not be themable`
    );
    assert.strictEqual(
      prefs.setCustomColor(token, '#FF0000'),
      false,
      `setCustomColor must refuse the token ${JSON.stringify(token)}`
    );
  }
  deepEqual(prefs.getCustomColors(), {});
});

s.test('every accepted colour form round-trips to a canonical value', () => {
  const app = loadAppSandbox();
  const normalize = app.sandbox.normalizeColorValue;

  const accepted = [
    ['#fff', '#FFF'],
    ['#0A0A0C', '#0A0A0C'],
    ['#00f0ff', '#00F0FF'],
    ['#FF336680', '#FF336680'],
    ['  #00F0FF  ', '#00F0FF'],
    ['rgb(0,0,0)', 'rgb(0, 0, 0)'],
    ['rgb( 255 , 184 , 0 )', 'rgb(255, 184, 0)'],
    ['rgba(255,255,255,0.04)', 'rgba(255, 255, 255, 0.04)'],
    ['RGBA(18, 18, 24, .94)', 'rgba(18, 18, 24, 0.94)'],
    ['rgba(0,0,0,0)', 'rgba(0, 0, 0, 0)'],
    ['rgba(0,0,0,1)', 'rgba(0, 0, 0, 1)'],
    ['rgba(0,0,0,1.0)', 'rgba(0, 0, 0, 1)'],
  ];

  for (const [input, expected] of accepted) {
    assert.strictEqual(normalize(input), expected, `normalizeColorValue(${JSON.stringify(input)})`);
    // A canonical value must be a fixed point: normalising it again is a no-op.
    assert.strictEqual(normalize(expected), expected, `${expected} is not a fixed point`);
  }

  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  assert.strictEqual(prefs.setCustomColor('--accent-cyan', 'rgb( 12,34,56 )'), true);
  deepEqual(prefs.getCustomColors(), { '--accent-cyan': 'rgb(12, 34, 56)' });
});

s.test('parseColorParts and composeColorValue are inverses across the accepted forms', () => {
  const app = loadAppSandbox();
  const { parseColorParts, composeColorValue } = app.sandbox;

  deepEqual(parseColorParts('#0A0A0C'), { r: 10, g: 10, b: 12, a: 1 });
  deepEqual(parseColorParts('#F0A'), { r: 255, g: 0, b: 170, a: 1 });
  deepEqual(parseColorParts('rgba(255, 255, 255, 0.04)'), {
    r: 255,
    g: 255,
    b: 255,
    a: 0.04,
  });
  assert.strictEqual(parseColorParts('#FF000080').a, 128 / 255);
  assert.strictEqual(parseColorParts('nonsense'), null, 'an invalid colour has no parts');

  // Opaque values come back as hex (which is what the palette is written in),
  // translucent ones as rgba — the picker's two controls compose either.
  assert.strictEqual(composeColorValue(0, 240, 255, 1), '#00F0FF');
  assert.strictEqual(composeColorValue(255, 255, 255, 0.04), 'rgba(255, 255, 255, 0.04)');
  assert.strictEqual(composeColorValue(10, 10, 12, 0), 'rgba(10, 10, 12, 0)');
  assert.strictEqual(composeColorValue(-5, 999, 12.6, 4), '#00FF0D', 'out-of-range input is clamped');

  for (const value of ['#00F0FF', 'rgba(255, 255, 255, 0.92)', 'rgb(138, 43, 226)']) {
    const p = app.sandbox.parseColorParts(value);
    const back = composeColorValue(p.r, p.g, p.b, p.a);
    assert.strictEqual(
      app.sandbox.normalizeColorValue(back),
      back,
      `${value} -> ${back} did not survive the round trip`
    );
    deepEqual(
      app.sandbox.parseColorParts(back),
      p,
      `${value} lost channels on the way round`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 3. applyThemeState — the cascade contract                                  */
/* -------------------------------------------------------------------------- */

s.test('the base theme is a class on the root element, and the meta follows it', () => {
  const app = loadAppSandbox();
  const doc = fakeDoc();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });

  let result = app.sandbox.applyThemeState(prefs, doc);
  assert.strictEqual(result.theme, 'dark');
  assert.strictEqual(doc.root.classList.contains(LIGHT_CLASS), false, 'dark is the absence of a class');
  assert.strictEqual(doc.meta.getAttribute('content'), 'dark');

  prefs.setTheme('light');
  result = app.sandbox.applyThemeState(prefs, doc);
  assert.strictEqual(result.theme, 'light');
  assert.strictEqual(doc.root.classList.contains(LIGHT_CLASS), true);
  assert.strictEqual(
    doc.meta.getAttribute('content'),
    'light',
    'meta[name=color-scheme] must track the theme or the UA keeps painting dark widgets'
  );

  prefs.setTheme('dark');
  app.sandbox.applyThemeState(prefs, doc);
  assert.strictEqual(doc.root.classList.contains(LIGHT_CLASS), false, 'the class must come off again');
  assert.strictEqual(doc.meta.getAttribute('content'), 'dark');
});

s.test('user colours are written as inline custom properties, and removed when cleared', () => {
  const app = loadAppSandbox();
  const doc = fakeDoc();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });

  prefs.setCustomColor('--accent-cyan', '#FF0000');
  prefs.setCustomColor('--bg', 'rgba(1, 2, 3, 0.5)');
  const result = app.sandbox.applyThemeState(prefs, doc);

  deepEqual(result.applied.sort(), ['--accent-cyan', '--bg']);
  deepEqual(doc.snapshot(), {
    '--accent-cyan': '#FF0000',
    '--bg': 'rgba(1, 2, 3, 0.5)',
  });

  prefs.clearCustomColors();
  app.sandbox.applyThemeState(prefs, doc);
  deepEqual(doc.snapshot(), {}, 'clearing must actually remove the declarations');
  deepEqual(app.sandbox.applyThemeState(prefs, doc).applied, []);
});

s.test('Code Mode SUSPENDS the user colours and gives them back afterwards', () => {
  const app = loadAppSandbox();
  const doc = fakeDoc();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });

  prefs.setTheme('light');
  prefs.setCustomColor('--bg', '#123456');
  prefs.setCustomColor('--text', 'rgba(9, 9, 9, 0.9)');
  app.sandbox.applyThemeState(prefs, doc);
  const before = doc.snapshot();
  deepEqual(before, { '--bg': '#123456', '--text': 'rgba(9, 9, 9, 0.9)' });

  // An inline declaration outranks any class selector, so a colour override
  // left in place would silently defeat the legibility mode. It has to go.
  prefs.setHighContrast(true);
  const during = app.sandbox.applyThemeState(prefs, doc);
  assert.strictEqual(doc.root.classList.contains(CONTRAST_CLASS), true);
  deepEqual(during.applied, [], 'nothing may stay inline while Code Mode is on');
  deepEqual(
    doc.snapshot(),
    {},
    'a user colour surviving Code Mode would out-specify it and break the mode'
  );
  assert.strictEqual(
    doc.root.classList.contains(LIGHT_CLASS),
    true,
    'the base theme class stays: Code Mode overrides it by source order, not by removal'
  );
  deepEqual(
    prefs.getCustomColors(),
    before,
    'suspended is not deleted — the preferences must be untouched'
  );

  prefs.setHighContrast(false);
  app.sandbox.applyThemeState(prefs, doc);
  assert.strictEqual(doc.root.classList.contains(CONTRAST_CLASS), false);
  deepEqual(doc.snapshot(), before, 'the overrides must come straight back');
});

s.test('applyThemeState is idempotent — the second call changes nothing the first did', () => {
  const app = loadAppSandbox();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  prefs.setTheme('light');
  prefs.setCustomColor('--accent-violet', '#101010');

  for (const highContrast of [false, true]) {
    prefs.setHighContrast(highContrast);
    const doc = fakeDoc();

    const first = app.sandbox.applyThemeState(prefs, doc);
    const state = {
      props: doc.snapshot(),
      classes: doc.root.classes.slice().sort(),
      meta: doc.meta.getAttribute('content'),
    };

    const second = app.sandbox.applyThemeState(prefs, doc);
    deepEqual(second, first, `the return value drifted (highContrast=${highContrast})`);
    deepEqual(doc.snapshot(), state.props, 'the inline properties drifted');
    deepEqual(doc.root.classes.slice().sort(), state.classes, 'the classes drifted');
    assert.strictEqual(doc.meta.getAttribute('content'), state.meta, 'the meta drifted');
  }
});

s.test('applyThemeState re-validates on the way out, so nothing unvetted can reach the DOM', () => {
  const app = loadAppSandbox();
  const doc = fakeDoc();

  // A prefs-shaped object that lies: exactly what a compromised or
  // hand-edited record would look like if load() were ever bypassed.
  const lying = {
    resolvedTheme: () => 'light',
    isHighContrast: () => false,
    getCustomColors: () => ({
      '--bg': 'url(javascript:alert(1))',
      '--text': '#FFFFFF; --glass-blur: none',
      '--glass-blur': 'none',
      '--accent-cyan': '#00FF00',
    }),
  };

  const result = app.sandbox.applyThemeState(lying, doc);
  deepEqual(result.applied, ['--accent-cyan'], 'only the one honest entry may pass');
  deepEqual(doc.snapshot(), { '--accent-cyan': '#00FF00' });
});

s.test('applyThemeState survives a missing or feature-poor document', () => {
  const app = loadAppSandbox();
  assert.strictEqual(app.sandbox.applyThemeState(null, fakeDoc()), null);
  assert.strictEqual(app.sandbox.applyThemeState({}, null), null);
  assert.strictEqual(app.sandbox.applyThemeState({}, {}), null, 'no documentElement, nothing to do');

  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  prefs.setCustomColor('--bg', '#FFFFFF');

  // No style API and no querySelector — an unusual document, not a broken one.
  const bare = { documentElement: { classList: fakeEl().classList } };
  let result;
  assert.doesNotThrow(() => {
    result = app.sandbox.applyThemeState(prefs, bare);
  }, 'a document without an inline style API must not throw');
  deepEqual(result.applied, [], 'nothing could be applied, and that is reported');
  assert.strictEqual(result.theme, 'dark');
});

/* -------------------------------------------------------------------------- */
/* 4. Static CSS contracts — the palette itself                               */
/* -------------------------------------------------------------------------- */

s.test('.theme-light redefines every colour token :root declares — name for name', () => {
  const css = readStyle();
  const root = cssBlock(css, ':root {');
  const light = cssBlock(css, '.theme-light {');
  assert.ok(root, 'no `:root { … }` palette block');
  assert.ok(light, 'no `.theme-light { … }` palette block — there is no light theme');

  const rootColors = colorTokenNames(root.body);
  const lightColors = colorTokenNames(light.body);
  assert.ok(rootColors.length >= 14, `expected a real palette in :root, found ${rootColors.length}`);
  deepEqual(
    lightColors,
    rootColors,
    'the two palettes must be a name-for-name mirror — a token only one of them ' +
      'declares is a colour that survives a theme swap unchanged'
  );

  // …and the values must actually differ, or it is not a second theme.
  const rootDecls = declarations(root.body);
  const lightDecls = declarations(light.body);
  const identical = rootColors.filter((name) => rootDecls[name] === lightDecls[name]);
  deepEqual(
    identical,
    [],
    `these tokens were copied rather than re-designed: ${identical.join(', ')}`
  );

  // The non-colour tokens are the other half of the contract: a theme changes
  // hues, not typefaces or timings, so .theme-light must NOT touch them.
  const nonColour = Object.keys(declarations(root.body)).filter((n) => !isColorValue(rootDecls[n]));
  assert.ok(nonColour.length >= 5, 'expected the font/blur/ring/timing tokens in :root');
  for (const name of nonColour) {
    assert.ok(
      !(name in lightDecls),
      `.theme-light redefines the non-colour token ${name}; a theme has no business there`
    );
  }
});

s.test('every re-derived light accent is recomputed here and clears WCAG AA', () => {
  const css = readStyle();
  const light = declarations(cssBlock(css, '.theme-light {').body);
  const dark = declarations(cssBlock(css, ':root {').body);
  const bg = light['--bg'];

  assert.ok(/^#[0-9A-Fa-f]{6}$/.test(bg), `the light --bg must be an opaque hex, got ${bg}`);
  assert.ok(
    bg.toUpperCase() !== '#FFFFFF',
    'the light ground must not be pure white — glass over paper-white has nothing to blur'
  );

  for (const token of CORRECTED_ACCENTS.concat(['--text', '--text-dim'])) {
    const ratio = ratioAgainst(light[token], bg);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `${token} (${light[token]}) is ${ratio.toFixed(2)}:1 on ${bg} — below the ${AA_NORMAL_TEXT}:1 ` +
        'floor for the text-sized use this app makes of it'
    );
  }

  // And the correction must have been necessary: at least three of the four
  // dark accents fail on the light ground, which is why they were re-derived.
  const failing = CORRECTED_ACCENTS.filter((t) => ratioAgainst(dark[t], bg) < AA_NORMAL_TEXT);
  assert.ok(
    failing.length >= 3,
    `expected the Obsidian accents to fail on a light ground; only ${failing.length} did`
  );
});

s.test('the documented contrast pairs match the values they document', () => {
  const raw = readStyleRaw();

  const css = readStyle();
  const light = declarations(cssBlock(css, '.theme-light {').body);
  const dark = declarations(cssBlock(css, ':root {').body);
  const bg = light['--bg'];

  for (const token of CORRECTED_ACCENTS) {
    const documented = new RegExp(
      token + '\\s+(#[0-9A-Fa-f]{6})\\s*\\(([0-9.]+):1\\)\\s*->\\s*(#[0-9A-Fa-f]{6})[^\\n]*?([0-9.]+):1'
    ).exec(raw);
    assert.ok(
      documented,
      `${token} has no documented "<old hex> (<ratio>) -> <new hex> <name> <ratio>" pair in the ` +
        '.theme-light comment; an undocumented colour correction is a magic number'
    );
    const [, oldHex, oldRatio, newHex, newRatio] = documented;

    assert.strictEqual(
      oldHex.toUpperCase(),
      dark[token].toUpperCase(),
      `${token}: the comment documents ${oldHex} as the Obsidian value, :root says ${dark[token]}`
    );
    assert.strictEqual(
      newHex.toUpperCase(),
      light[token].toUpperCase(),
      `${token}: the comment documents ${newHex} as the Daylight value, .theme-light says ${light[token]}`
    );

    const actualOld = ratioAgainst(dark[token], bg);
    const actualNew = ratioAgainst(light[token], bg);
    assert.ok(
      Math.abs(actualOld - Number(oldRatio)) < 0.06,
      `${token}: comment claims the old value is ${oldRatio}:1 on light, it is ${actualOld.toFixed(2)}:1`
    );
    assert.ok(
      Math.abs(actualNew - Number(newRatio)) < 0.06,
      `${token}: comment claims ${newRatio}:1, it is ${actualNew.toFixed(2)}:1`
    );
  }

  for (const token of ['--text', '--text-dim']) {
    const documented = new RegExp(token + '\\s+over --bg\\s+([0-9.]+):1').exec(raw);
    assert.ok(documented, `${token} has no documented ratio against --bg`);
    const actual = ratioAgainst(light[token], bg);
    assert.ok(
      Math.abs(actual - Number(documented[1])) < 0.06,
      `${token}: comment claims ${documented[1]}:1, it is ${actual.toFixed(2)}:1`
    );
  }
});

s.test('every derived token reduces to palette tokens, so a recolour reaches all of them', () => {
  const css = readStyle();
  const derived = cssBlock(css, 'html {');
  assert.ok(derived, 'no `html { … }` derived-token block');

  const decls = declarations(derived.body);
  const names = Object.keys(decls);
  assert.ok(names.length >= 6, `expected the tint/glow/track family, found ${names.length}`);

  const palette = new Set(colorTokenNames(cssBlock(css, ':root {').body));
  for (const name of names) {
    const value = decls[name];
    assert.ok(
      /color-mix\(/.test(value),
      `${name} is in the derived block but is not derived: ${value}`
    );
    const refs = value.match(/var\((--[a-zA-Z0-9-]+)\)/g) || [];
    assert.ok(refs.length > 0, `${name} mixes no palette token at all: ${value}`);
    for (const ref of refs) {
      const token = /var\((--[a-zA-Z0-9-]+)\)/.exec(ref)[1];
      assert.ok(
        palette.has(token),
        `${name} derives from ${token}, which is not a palette token — a recolour would miss it`
      );
    }
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(value),
      `${name} hard-codes a colour instead of mixing one: ${value}`
    );
  }

  // The glows live in the PALETTE blocks rather than here, because neon on
  // black and a soft drop shadow on paper are different design decisions.
  const rootDecls = declarations(cssBlock(css, ':root {').body);
  const lightDecls = declarations(cssBlock(css, '.theme-light {').body);
  for (const glow of ['--glow-cyan', '--glow-violet', '--glow-crimson']) {
    assert.ok(glow in rootDecls && glow in lightDecls, `${glow} must be declared by both themes`);
    assert.ok(
      /color-mix\(in srgb, var\(--/.test(rootDecls[glow]),
      `${glow} must mix its colour from an accent token: ${rootDecls[glow]}`
    );
  }
});

s.test('no colour literal of ANY form sits outside a token block', () => {
  const css = readStyle();
  const blocks = [':root {', '.theme-light {', 'html {', '.high-contrast {'].map((selector) => {
    const found = cssBlock(css, selector);
    assert.ok(found, `token block \`${selector} { … }\` is missing`);
    return found;
  });
  const inABlock = (index) => blocks.some((b) => index >= b.start && index <= b.end);

  const lines = css.split(/\r\n|\r|\n/);
  // `transparent` is deliberately not policed: it is the absence of a colour,
  // it means the same thing in every theme, and there is nothing to re-theme.
  const re = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\brgba?\(/g;
  const strays = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    if (inABlock(m.index)) continue;
    const line = css.slice(0, m.index).split(/\r\n|\r|\n/).length;
    strays.push(`  line ${line}: ${m[0]}  in  ${(lines[line - 1] || '').trim()}`);
  }
  deepEqual(
    strays,
    [],
    'colour literal(s) outside the token blocks — neither a theme swap nor a user ' +
      'recolour nor Code Mode can reach these:\n' + strays.join('\n')
  );
});

s.test('Code Mode is the last word: .high-contrast follows both palettes in source order', () => {
  const css = readStyle();
  const root = cssBlock(css, ':root {');
  const light = cssBlock(css, '.theme-light {');
  const contrast = cssBlock(css, '.high-contrast {');

  assert.ok(
    root.start < light.start && light.start < contrast.start,
    'the palettes and Code Mode carry equal specificity, so Code Mode can only win ' +
      'by coming last; the current order is ' +
      [[':root', root.start], ['.theme-light', light.start], ['.high-contrast', contrast.start]]
        .sort((a, b) => a[1] - b[1])
        .map((e) => e[0])
        .join(' -> ')
  );

  // The surfaces Code Mode has to flatten now include the ones this release
  // added, or the mode would leak a translucent panel into a legibility view.
  const decls = declarations(contrast.body);
  for (const token of ['--bg', '--surface', '--field-bg', '--viz-bg', '--toast-bg', '--text']) {
    assert.ok(token in decls, `.high-contrast does not override ${token}`);
  }
  assert.ok(/#000000/i.test(decls['--viz-bg']), 'the visualiser stage must go solid black too');
  assert.ok(/#000000/i.test(decls['--toast-bg']), 'floating panels must go solid black too');
});

s.test('Code Mode pins the accents to Obsidian, whichever theme is underneath it', () => {
  const css = readStyle();
  const raw = readStyleRaw();
  const dark = declarations(cssBlock(css, ':root {').body);
  const lightPalette = declarations(cssBlock(css, '.theme-light {').body);
  const contrast = declarations(cssBlock(css, '.high-contrast {').body);
  const BLACK = '#000000';

  for (const token of CORRECTED_ACCENTS) {
    assert.ok(
      token in contrast,
      `.high-contrast does not pin ${token}. Code Mode's ground is black in BOTH themes, so ` +
        `Studio Daylight's ${lightPalette[token]} — derived for a light ground — would leak into ` +
        'the accessibility mode as the least legible colour in the app'
    );
    assert.strictEqual(
      contrast[token].toUpperCase(),
      dark[token].toUpperCase(),
      `${token} must be pinned to the Obsidian value the mode was designed around`
    );
    const pinned = ratioAgainst(contrast[token], BLACK);
    const leaked = ratioAgainst(lightPalette[token], BLACK);
    assert.ok(
      pinned > leaked,
      `pinning ${token} made it WORSE on black (${pinned.toFixed(2)}:1 vs ${leaked.toFixed(2)}:1)`
    );

    // The comment's ratio table is the reason this pin exists; it has to be true.
    const row = new RegExp(
      token.replace('--accent-', '').replace('--warning-', '').replace('--danger-', '') +
        '\\s+([0-9.]+):1\\s+([0-9.]+):1'
    ).exec(raw);
    assert.ok(row, `the .high-contrast comment has no on-black ratio row for ${token}`);
    assert.ok(
      Math.abs(Number(row[1]) - pinned) < 0.06 && Math.abs(Number(row[2]) - leaked) < 0.06,
      `${token}: the table claims ${row[1]}:1 / ${row[2]}:1 on black, the values are ` +
        `${pinned.toFixed(2)}:1 / ${leaked.toFixed(2)}:1`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Token-list integrity + markup contracts                                 */
/* -------------------------------------------------------------------------- */

s.test('listThemableTokens() is a subset of what :root actually declares', () => {
  const app = loadAppSandbox();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  const listed = prefs.listThemableTokens();

  assert.ok(Array.isArray(listed) && listed.length >= 11, 'the picker needs a real token list');
  assert.strictEqual(
    new Set(listed).size,
    listed.length,
    'the themable list must not repeat a token'
  );

  const css = readStyle();
  const rootDecls = declarations(cssBlock(css, ':root {').body);
  const lightDecls = declarations(cssBlock(css, '.theme-light {').body);

  for (const token of listed) {
    assert.ok(
      token in rootDecls,
      `listThemableTokens() offers ${token}, which :root never declares — the picker ` +
        'would show a control that changes nothing'
    );
    assert.ok(token in lightDecls, `${token} is themable but Studio Daylight never redefines it`);
    // A themable token has to be a LITERAL colour: the picker seeds an
    // <input type="color"> from it, and a color-mix() expression has no
    // channels to seed it with.
    assert.ok(
      app.sandbox.normalizeColorValue(rootDecls[token]) !== null,
      `${token} is themable but its :root value is not a literal colour: ${rootDecls[token]}`
    );
    assert.ok(
      app.sandbox.normalizeColorValue(lightDecls[token]) !== null,
      `${token} is themable but its .theme-light value is not a literal colour: ${lightDecls[token]}`
    );
  }

  // The house palette from FDD.md §6 must all be reachable from the picker.
  for (const required of [
    '--bg',
    '--surface',
    '--surface-2',
    '--surface-border',
    '--field-bg',
    '--accent-cyan',
    '--accent-violet',
    '--warning-amber',
    '--danger-crimson',
    '--text',
    '--text-dim',
  ]) {
    assert.ok(listed.indexOf(required) !== -1, `${required} must be user-configurable`);
  }

  // Every entry needs a human label and a group, or the panel cannot render it.
  for (const entry of app.sandbox.THEMABLE_TOKENS) {
    assert.ok(entry && typeof entry.label === 'string' && entry.label.trim(), `${entry && entry.name} has no label`);
    assert.ok(entry && typeof entry.group === 'string' && entry.group.trim(), `${entry.name} has no group`);
  }
});

s.test('the theme switcher is a real pressed-state control with a stable name', () => {
  const html = readIndex();

  assert.ok(/id="btn-theme"/.test(html), 'index.html is missing the #btn-theme switcher');
  assert.ok(
    /id="btn-theme"[\s\S]{0,300}aria-pressed="false"/.test(html),
    '#btn-theme must expose aria-pressed so its state is announced'
  );
  const label = /id="btn-theme"[\s\S]{0,300}aria-label="([^"]+)"/.exec(html);
  assert.ok(label, '#btn-theme must carry an aria-label');
  assert.ok(
    /light/i.test(label[1]),
    `the accessible name must contain the visible label "Light" (WCAG 2.5.3); got "${label[1]}"`
  );

  // Both glyphs ship inline — a single-file app has no icon font to fetch —
  // and exactly one of them starts hidden.
  for (const id of ['theme-glyph-sun', 'theme-glyph-moon']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }
  assert.ok(
    /id="theme-glyph-sun"[\s\S]{0,400}hidden>/.test(html),
    'the sun glyph must start hidden — the app boots into Studio Obsidian'
  );
  assert.ok(
    !/<svg[^>]*xmlns=/.test(html),
    'inline SVG needs no xmlns in HTML, and an absolute URL would trip the single-file scan'
  );
});

s.test('the colours panel is a labelled disclosure with a Code Mode note and a reset', () => {
  const html = readIndex();

  for (const id of [
    'btn-colors',
    'colors-panel',
    'colors-panel-title',
    'colors-rows',
    'colors-note',
    'colors-error',
    'btn-colors-reset',
    'btn-colors-close',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }

  assert.ok(
    /id="btn-colors"[\s\S]{0,300}aria-expanded="false"/.test(html),
    '#btn-colors must expose aria-expanded — it is a disclosure, not a button'
  );
  assert.ok(
    /id="btn-colors"[\s\S]{0,300}aria-controls="colors-panel"/.test(html),
    '#btn-colors must name the panel it controls'
  );
  assert.ok(
    /id="colors-panel"[\s\S]{0,200}role="dialog"/.test(html),
    '#colors-panel must be a role="dialog"'
  );
  assert.ok(
    /id="colors-panel"[\s\S]{0,240}aria-labelledby="colors-panel-title"/.test(html),
    '#colors-panel must be labelled by its own heading'
  );
  assert.ok(
    /id="colors-panel"[\s\S]{0,260}hidden>/.test(html),
    'the panel must start closed'
  );
  assert.ok(
    /id="colors-note"[\s\S]{0,200}hidden>/.test(html),
    'the Code Mode note must start hidden — Code Mode starts off'
  );
  assert.ok(
    /id="colors-error"[\s\S]{0,200}role="alert"/.test(html),
    'a rejected colour has to be ANNOUNCED, not just styled red'
  );

  const note = /id="colors-note"[\s\S]{0,400}?>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(note && /code mode/i.test(note[1]), 'the note must actually say Code Mode overrides colours');

  // The panel is a popover inside a header that establishes its own stacking
  // context; without an explicit z-index it would paint under the workspace.
  const css = readStyle();
  assert.ok(
    /\.app-header\s*\{[^}]*z-index:\s*\d+/.test(css),
    '.app-header creates a stacking context (backdrop-filter) and needs a z-index, ' +
      'or the colours panel paints behind #workspace'
  );
  assert.ok(
    /\.colors-menu\s*\{[^}]*position:\s*relative/.test(css),
    '.colors-menu must be the positioning context for the popover'
  );
});

/* ------------------------------------------------------------------------ *
 * TODO: coverage that activates with later features.
 * ------------------------------------------------------------------------ */

s.todo(
  'the picker is driven through a real DOM: pick a colour, assert getComputedStyle changed',
  'needs the browser E2E harness; today the row wiring is verified by hand in a browser and the ' +
    'pure halves (validation, composition, applyThemeState) are covered here'
);
s.todo(
  'the light palette is checked against measured, laid-out contrast rather than declared tokens',
  'needs a headless browser with getComputedStyle to sample real foreground/background pairs after ' +
    'the cascade; today the ratios are recomputed from the declarations themselves'
);
s.todo(
  'per-theme colour overrides (one custom palette for Obsidian, another for Daylight)',
  'today customColors is one map shared by both themes; splitting it needs a UI affordance for ' +
    '"which theme am I editing" before the storage shape changes'
);

module.exports = { fakeDoc, fakeMatchMedia, declarations, contrastRatio, ratioAgainst };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
