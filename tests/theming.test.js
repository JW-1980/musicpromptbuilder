'use strict';
/*
 * tests/theming.test.js — user-configurable colour, the theme SUITE and the
 * Code Mode legibility override (docs/FDD.md §6 + #17).
 *
 * Five halves, all dependency-free:
 *
 *   1. PREFERENCES. `createThemePrefs` is exercised in a node:vm context with
 *      no `document`, `window` or `localStorage`: a recording fake storage and
 *      an injected `matchMedia` prove the system-preference default, that an
 *      explicit choice outranks it forever, and that a record written by an
 *      older release still loads. Since 0.16.0 the record carries TWO theme
 *      fields (`theme` and `themeId`), so a whole migration matrix is driven
 *      through load() rather than one legacy case being spot-checked.
 *
 *   2. VALIDATION. `normalizeColorValue` is the ONLY thing standing between a
 *      stored string and an inline custom property on <html>, so it is
 *      attacked rather than sampled: a battery of hostile payloads must all be
 *      rejected with nothing persisted, while every accepted form round-trips.
 *
 *   3. APPLICATION. `applyThemeState` is driven against a fake document to
 *      prove the cascade contract that CSS alone cannot express — the registry
 *      walk that swaps theme classes, inline user colours beating the palette,
 *      and Code Mode beating the inline colours by having them SUSPENDED for
 *      its duration and restored afterwards.
 *
 *   4. STATIC CONTRACTS. The palettes are CSS, so they are parsed: every theme
 *      block must be a name-for-name mirror of :root's seventeen colour
 *      tokens, they must sit in the source order their equal specificity
 *      depends on, every documented contrast ratio is RECOMPUTED from the
 *      declarations it documents, every derived token must reduce to palette
 *      tokens, and no colour literal of any form may sit outside a token
 *      block. The registry in #app-main is cross-checked against those blocks
 *      in both directions, so neither can gain an entry the other lacks.
 *
 *   5. COLOUR VISION. Studio ColorSafe's whole reason to exist is that its
 *      four accents survive red/green colour vision deficiency, which is not
 *      something a contrast ratio can express. A Viénot–Brettel–Mollon (1999)
 *      dichromacy simulation is implemented here and every accent PAIR is
 *      measured through it; Studio Daylight is run through the same bar and
 *      must fail it, or the new theme was not necessary.
 *
 * Node built-ins only: fs, path, assert, vm (via the shared helpers).
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { suite } = require('./lib/runner.js');
const { loadAppSandbox, fakeEl, fakeStorage, cssBlock, stripCssComments } = require('./ui-layout.test.js');
const { stripScriptBodies } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const PREFS_KEY = 'suno_ui_prefs';
const LIGHT_CLASS = 'theme-light';
const CONTRAST_CLASS = 'high-contrast';

/* The four palette tokens the light theme had to re-derive, and the AA floor
 * every one of them has to clear against the light --bg for text-sized use. */
const CORRECTED_ACCENTS = ['--accent-cyan', '--accent-violet', '--warning-amber', '--danger-crimson'];
const AA_NORMAL_TEXT = 4.5;

/* Every token block in the stylesheet, in the order it MUST appear. All of
 * them carry the same specificity — a single class, or :root/html which lose
 * to one — so this order is the only thing that lets a later block beat an
 * earlier one, and `.high-contrast` beating all six palettes is the whole
 * mechanism of Code Mode. `:root` and `html` are the un-classed defaults and
 * sit first by construction. */
const PALETTE_SELECTORS = [
  ':root {',
  '.theme-light {',
  '.theme-studio-colorsafe {',
  '.theme-tape-deck {',
  '.theme-null-signal {',
  '.theme-abyssal-bloom {',
];
const CODE_MODE_SELECTOR = '.high-contrast {';
/* The theme CLASSES, i.e. the palettes minus :root. Five of them, and every
 * one has to precede Code Mode. */
const THEME_CLASS_SELECTORS = PALETTE_SELECTORS.slice(1);
/* The two tokens .high-contrast is allowed to declare on top of the seventeen
 * palette names: they are MODE mechanics (kill the blur, thicken the ring),
 * not hues, and no theme may touch them. */
const MODE_ONLY_TOKENS = ['--focus-ring', '--glass-blur'];
/* The three glow tokens that live in the palette blocks rather than in the
 * derived `html` block, because neon on black and a soft drop shadow on paper
 * are different design decisions rather than one mix of the same accent. */
const GLOW_TOKENS = ['--glow-crimson', '--glow-cyan', '--glow-violet'];

/* Per-theme contrast floors, recomputed from the declarations themselves.
 * `text` and `dim` are the two shades every screen is read in, so both are
 * held to a real floor everywhere. The ACCENT floor is per theme on purpose:
 *
 *   - the two light themes and Abyssal Bloom clear AA (4.5:1) on all four;
 *   - Tape Deck and Null Signal each ship one accent in the low fours, which
 *     is under AA for body text but above the 3.32:1 secondary Studio Obsidian
 *     itself has shipped since 0.1.0. Since 0.16.0 the RAW accents paint only
 *     borders, glows and chip accents (3:1 UI-component contrast) — every
 *     violet-tinted TEXT run (.structure-tag, the pressed .btn-toggle label)
 *     rides the derived --ink-violet, which its own test below holds to a
 *     hard >=4.5 in EVERY theme. Holding the raw originals to 4.0 records the
 *     border-accent trade instead of hiding it behind a passing 3.3;
 *   - :root is listed so the baseline every "no regression" claim leans on is
 *     itself asserted rather than assumed.
 */
const THEME_CONTRAST_FLOORS = {
  ':root {': { text: 12, dim: 4.5, accent: 3.3 },
  '.theme-light {': { text: 12, dim: 4.5, accent: 4.5 },
  '.theme-studio-colorsafe {': { text: 12, dim: 4.5, accent: 4.5 },
  '.theme-tape-deck {': { text: 12, dim: 4.5, accent: 4.0 },
  '.theme-null-signal {': { text: 12, dim: 4.5, accent: 4.0 },
  '.theme-abyssal-bloom {': { text: 12, dim: 4.5, accent: 4.5 },
};

/* How far a documented ratio may sit from the recomputed one before the
 * comment counts as a lie. Two decimal places are published, so this is one
 * rounding step plus a hair. */
const RATIO_TOLERANCE = 0.06;

/* --- Studio ColorSafe's colour-vision contract ----------------------------
 *
 * Two numbers, both chosen from what the palette actually measures rather than
 * from a standard (there is no WCAG figure for "these two hues are still two
 * hues to a dichromat"):
 *
 *   CVD_MIN_DELTA_E — CIE76 ΔE between any two of the four accents after a
 *     Viénot simulation. ColorSafe's worst pair over protan/deutan/tritan is
 *     34.6 (primary vs danger under protanopia); Studio Daylight's worst is
 *     12.6 and Studio Obsidian's is 15.7. 25 sits between the two populations
 *     with room on both sides, so it separates "designed for this" from "not".
 *   CVD_MIN_SEMANTIC_CONTRAST — the two pairs that carry MEANING (primary vs
 *     secondary, warning vs danger) additionally have to differ in LIGHTNESS,
 *     because that is the channel no simulation can take away. ColorSafe's
 *     worst semantic pair is 2.28:1; Daylight's is 1.05:1.
 */
const CVD_MIN_DELTA_E = 25;
const CVD_MIN_SEMANTIC_CONTRAST = 2.0;
const CVD_KINDS = ['protan', 'deutan', 'tritan'];
/* The pairs that encode meaning rather than merely appearing together. */
const CVD_SEMANTIC_PAIRS = [
  ['--accent-cyan', '--accent-violet'],
  ['--warning-amber', '--danger-crimson'],
];

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

/* --- Block + comment addressing ------------------------------------------ */

/**
 * The declarations of one token block, keyed by name.
 * @param {string} selector e.g. '.theme-tape-deck {'
 */
function blockDecls(selector) {
  const found = cssBlock(readStyle(), selector);
  assert.ok(found, `token block \`${selector} … }\` is missing from the stylesheet`);
  return declarations(found.body);
}

/**
 * The COMMENT that documents a block — everything from the last `/*` opener
 * before it up to the selector itself, taken from the raw (comment-carrying)
 * stylesheet.
 *
 * This works because stripCssComments() replaces comment characters with
 * spaces rather than deleting them, so an index into the stripped stylesheet
 * is the same index in the raw one. Without that, every "does the comment tell
 * the truth" assertion would have to search the whole file for a table row and
 * would happily match another block's.
 *
 * @param {string} selector
 * @returns {string}
 */
function commentFor(selector) {
  const found = cssBlock(readStyle(), selector);
  assert.ok(found, `token block \`${selector} … }\` is missing from the stylesheet`);
  const raw = readStyleRaw();
  const before = raw.slice(0, found.start);
  const open = before.lastIndexOf('/*');
  assert.ok(open !== -1, `${selector} has no comment above it at all`);
  return raw.slice(open, found.start);
}

/**
 * The ratio a block's own comment claims for one token against that block's
 * --bg, from a row shaped `--token   over --bg   12.34:1`.
 * @returns {number|null} null when the row is absent
 */
function documentedRatio(comment, token) {
  const row = new RegExp(token + '\\s+over --bg\\s+([0-9.]+):1').exec(comment);
  return row ? Number(row[1]) : null;
}

/* --- Viénot, Brettel & Mollon (1999) dichromacy simulation ----------------
 *
 * The published method, implemented here rather than depended on (zero
 * dependencies, and a colour-blindness claim asserted by a library nobody in
 * this repo can read is not asserted at all):
 *
 *   1. undo the sRGB transfer function to get linear light;
 *   2. project into LMS cone response with the Viénot matrix;
 *   3. collapse the missing cone onto the plane the remaining two span —
 *      protan replaces L, deutan replaces M, tritan replaces S;
 *   4. project back to linear RGB and re-apply the transfer function.
 *
 * The coefficients are the paper's, reproduced to the precision the reference
 * implementations use. What comes out is what a dichromat's visual system has
 * left to work with, which is exactly the input a "can these still be told
 * apart" question needs.
 */
function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  const x = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(x * 255)));
}

/**
 * @param {{r:number,g:number,b:number}} color an OPAQUE colour
 * @param {'protan'|'deutan'|'tritan'} kind
 * @returns {{r:number,g:number,b:number,a:number}} what that dichromat sees
 */
function simulateCvd(color, kind) {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  let L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  let M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  let S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;

  if (kind === 'protan') L = 2.02344 * M - 2.52581 * S;
  else if (kind === 'deutan') M = 0.494207 * L + 1.24827 * S;
  else if (kind === 'tritan') S = -0.395913 * L + 0.801109 * M;
  else throw new Error(`unknown CVD kind: ${kind}`);

  return {
    r: linearToSrgb(0.0809444479 * L - 0.130504409 * M + 0.116772127 * S),
    g: linearToSrgb(-0.0102485286 * L + 0.0540193266 * M - 0.113614708 * S),
    b: linearToSrgb(-0.0003653052 * L - 0.0041216147 * M + 0.6935112 * S),
    a: 1,
  };
}

/** CIE L*a*b* under D65, the space CIE76 ΔE is defined in. */
function toLab(color) {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIE76 colour difference — the plain Euclidean distance in L*a*b*. */
function deltaE76(a, b) {
  const A = toLab(a);
  const B = toLab(b);
  return Math.sqrt((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2);
}

const s = suite('theming (the theme suite + user-configurable tokens)');

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

s.test('setThemeId accepts exactly the registry, and null hands the vote back to the OS', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage, matchMedia: fakeMatchMedia('light') });

  assert.strictEqual(prefs.getThemeId(), null, 'an untouched install has chosen no theme');
  assert.strictEqual(prefs.resolvedThemeId(), 'daylight', 'a light system resolves to Daylight');
  assert.strictEqual(storage.writes.length, 0, 'reading a preference must not write one');

  for (const entry of app.sandbox.THEMES) {
    assert.strictEqual(prefs.setThemeId(entry.id), entry.id, `setThemeId(${entry.id}) must take`);
    assert.strictEqual(prefs.getThemeId(), entry.id);
    assert.strictEqual(prefs.resolvedTheme(), entry.base, `${entry.id} must resolve to its own base`);
    // BOTH fields move together: `theme` is what an older build reads.
    const stored = JSON.parse(storage.data[PREFS_KEY]);
    assert.strictEqual(stored.themeId, entry.id);
    assert.strictEqual(
      stored.theme,
      entry.base,
      `the legacy theme field must follow ${entry.id}'s ground, or a 0.15.0 build reading this ` +
        'record paints the wrong one'
    );
  }

  prefs.setThemeId('tape-deck');
  const writesBefore = storage.writes.length;
  for (const bogus of ['studio-code', 'Tape-Deck', 'theme-tape-deck', 'sepia', 42, {}, [], true]) {
    assert.strictEqual(
      prefs.setThemeId(bogus),
      'tape-deck',
      `setThemeId(${JSON.stringify(bogus)}) must change nothing`
    );
    assert.strictEqual(prefs.getThemeId(), 'tape-deck');
  }
  assert.strictEqual(storage.writes.length, writesBefore, 'a rejected id must not touch storage');

  assert.strictEqual(prefs.setThemeId(null), 'daylight', 'clearing re-consults the system');
  assert.strictEqual(prefs.getThemeId(), null);
  assert.strictEqual(prefs.getTheme(), null, 'clearing the id clears the legacy field with it');
  assert.strictEqual(prefs.setThemeId('system'), 'daylight', '"system" is the same instruction');
});

s.test('setTheme still works and drags themeId to that ground’s default theme', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage, matchMedia: fakeMatchMedia('dark') });

  // The two fields are never allowed to disagree about the ground, whichever
  // setter moved. Anything else lets an old control silently strand the new one.
  assert.strictEqual(prefs.setTheme('light'), 'light');
  assert.strictEqual(prefs.getThemeId(), 'daylight');
  assert.strictEqual(prefs.setTheme('dark'), 'dark');
  assert.strictEqual(prefs.getThemeId(), 'obsidian');

  // …and a suite theme moved by setThemeId leaves `theme` on ITS ground, not
  // on whatever the coarse switch last said.
  prefs.setThemeId('abyssal-bloom');
  assert.strictEqual(prefs.getTheme(), 'dark');
  prefs.setThemeId('studio-colorsafe');
  assert.strictEqual(prefs.getTheme(), 'light');
  assert.strictEqual(prefs.resolvedTheme(), 'light');
  assert.strictEqual(JSON.parse(storage.data[PREFS_KEY]).theme, 'light');

  // Setting the coarse switch AWAY from a suite theme is a real choice, so it
  // takes the id with it rather than leaving a stale one behind.
  prefs.setTheme('dark');
  assert.strictEqual(prefs.getThemeId(), 'obsidian', 'the suite theme must not survive as a ghost');
  prefs.setTheme(null);
  assert.strictEqual(prefs.getThemeId(), null);
  assert.strictEqual(prefs.resolvedThemeId(), 'obsidian', 'a dark system resolves to Obsidian');
});

s.test('the persistence migration matrix: every record shape a user could be carrying', () => {
  const app = loadAppSandbox();

  /* One row per record an install could actually hold: written by 0.15.0 and
   * earlier, written by this release, hand-edited, or corrupt. `system` is the
   * prefers-color-scheme in force while it is read, because half the point of
   * the dual field is that a record with no opinion still has one. */
  const MATRIX = [
    // --- records from before the suite existed --------------------------
    {
      why: 'the pre-theming record: one boolean, nothing else',
      stored: { highContrast: true },
      system: 'light',
      expect: { highContrast: true, theme: null, themeId: null, resolvedId: 'daylight', base: 'light' },
    },
    {
      why: '0.15.0 chose dark explicitly',
      stored: { highContrast: false, theme: 'dark', customColors: {} },
      system: 'light',
      expect: { highContrast: false, theme: 'dark', themeId: null, resolvedId: 'obsidian', base: 'dark' },
    },
    {
      why: '0.15.0 chose light explicitly, and it must still outrank a dark OS',
      stored: { highContrast: false, theme: 'light', customColors: {} },
      system: 'dark',
      expect: { highContrast: false, theme: 'light', themeId: null, resolvedId: 'daylight', base: 'light' },
    },
    {
      why: '0.15.0 never chose: the OS still decides',
      stored: { highContrast: false, theme: null, customColors: {} },
      system: 'dark',
      expect: { highContrast: false, theme: null, themeId: null, resolvedId: 'obsidian', base: 'dark' },
    },
    // --- records this release writes ------------------------------------
    {
      why: 'a suite theme, with the legacy field kept in step',
      stored: { highContrast: false, theme: 'dark', themeId: 'tape-deck', customColors: {} },
      system: 'light',
      expect: {
        highContrast: false,
        theme: 'dark',
        themeId: 'tape-deck',
        resolvedId: 'tape-deck',
        base: 'dark',
      },
    },
    {
      why: 'Code Mode on TOP of a suite theme — the theme is the restore point',
      stored: { highContrast: true, theme: 'light', themeId: 'studio-colorsafe', customColors: {} },
      system: 'dark',
      expect: {
        highContrast: true,
        theme: 'light',
        themeId: 'studio-colorsafe',
        resolvedId: 'studio-colorsafe',
        base: 'light',
      },
    },
    // --- records that disagree with themselves, or are simply wrong ------
    {
      why: 'the two fields contradict each other: the registry-validated id wins',
      stored: { theme: 'light', themeId: 'abyssal-bloom' },
      system: 'light',
      expect: {
        highContrast: false,
        theme: 'light',
        themeId: 'abyssal-bloom',
        resolvedId: 'abyssal-bloom',
        base: 'dark',
      },
    },
    {
      why: 'a themeId from a build that shipped a theme this one does not',
      stored: { theme: 'light', themeId: 'vaporwave' },
      system: 'dark',
      expect: { highContrast: false, theme: 'light', themeId: null, resolvedId: 'daylight', base: 'light' },
    },
    {
      why: 'Code Mode smuggled in as a themeId — it is a mode, not a theme',
      stored: { theme: 'dark', themeId: 'studio-code' },
      system: 'light',
      expect: { highContrast: false, theme: 'dark', themeId: null, resolvedId: 'obsidian', base: 'dark' },
    },
    {
      why: 'a class name instead of a slug',
      stored: { themeId: 'theme-tape-deck' },
      system: 'dark',
      expect: { highContrast: false, theme: null, themeId: null, resolvedId: 'obsidian', base: 'dark' },
    },
    {
      why: 'a themeId that is not even a string',
      stored: { themeId: { id: 'tape-deck' } },
      system: 'light',
      expect: { highContrast: false, theme: null, themeId: null, resolvedId: 'daylight', base: 'light' },
    },
    {
      why: 'a bad theme beside a good id: validation is per FIELD',
      stored: { theme: 'sepia', themeId: 'null-signal' },
      system: 'light',
      expect: {
        highContrast: false,
        theme: null,
        themeId: 'null-signal',
        resolvedId: 'null-signal',
        base: 'dark',
      },
    },
  ];

  for (const row of MATRIX) {
    const storage = fakeStorage({ [PREFS_KEY]: JSON.stringify(row.stored) });
    const prefs = app.sandbox.createThemePrefs({
      storage,
      matchMedia: fakeMatchMedia(row.system),
    });
    assert.doesNotThrow(() => prefs.load(), `load() threw on: ${row.why}`);

    assert.strictEqual(prefs.isHighContrast(), row.expect.highContrast, `highContrast — ${row.why}`);
    assert.strictEqual(prefs.getTheme(), row.expect.theme, `getTheme() — ${row.why}`);
    assert.strictEqual(prefs.getThemeId(), row.expect.themeId, `getThemeId() — ${row.why}`);
    assert.strictEqual(prefs.resolvedThemeId(), row.expect.resolvedId, `resolvedThemeId() — ${row.why}`);
    assert.strictEqual(prefs.resolvedTheme(), row.expect.base, `resolvedTheme() — ${row.why}`);
    assert.strictEqual(storage.writes.length, 0, `reading must not repair-write — ${row.why}`);
  }

  // Corrupt payloads land on the system preference with nothing leaking out of
  // them, which is the same answer an empty install gets.
  for (const raw of ['{oops', '', 'null', '[]', '"tape-deck"', '{"themeId":', '5']) {
    const storage = fakeStorage({ [PREFS_KEY]: raw });
    const prefs = app.sandbox.createThemePrefs({ storage, matchMedia: fakeMatchMedia('dark') });
    assert.doesNotThrow(() => prefs.load(), `load() threw on ${JSON.stringify(raw)}`);
    assert.strictEqual(prefs.getThemeId(), null, `a themeId leaked from ${JSON.stringify(raw)}`);
    assert.strictEqual(prefs.resolvedThemeId(), 'obsidian');
    assert.strictEqual(storage.writes.length, 0);
  }
});

s.test('a record this release writes stays readable by the build that predates it', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  /* The whole reason `theme` survives alongside `themeId`. An older build
   * knows only the first field, so after every possible write it must still
   * find a value it understands — never a null it would read as "no choice"
   * and answer with the wrong ground. */
  for (const entry of app.sandbox.THEMES) {
    prefs.setThemeId(entry.id);
    const stored = JSON.parse(storage.data[PREFS_KEY]);
    assert.ok(
      stored.theme === 'dark' || stored.theme === 'light',
      `after setThemeId(${entry.id}) the legacy field is ${JSON.stringify(stored.theme)}, which a ` +
        '0.15.0 build reads as "never chosen"'
    );
    assert.strictEqual(stored.theme, entry.base);
    assert.strictEqual(stored.themeId, entry.id);
    assert.strictEqual(typeof stored.highContrast, 'boolean', 'the oldest field of all survives too');
  }

  // And the round trip: what this release writes, this release reads back.
  prefs.setThemeId('null-signal');
  prefs.setHighContrast(true);
  prefs.setCustomColor('--accent-cyan', '#123456');
  const reloaded = app.sandbox.createThemePrefs({ storage });
  reloaded.load();
  assert.strictEqual(reloaded.getThemeId(), 'null-signal');
  assert.strictEqual(reloaded.isHighContrast(), true);
  deepEqual(reloaded.getCustomColors(), { '--accent-cyan': '#123456' });
});

s.test('Code Mode leaves the stored theme alone, so turning it off restores it', () => {
  const app = loadAppSandbox();
  const storage = fakeStorage();
  const prefs = app.sandbox.createThemePrefs({ storage });

  prefs.setThemeId('abyssal-bloom');
  prefs.setHighContrast(true);
  assert.strictEqual(
    prefs.getThemeId(),
    'abyssal-bloom',
    'Code Mode is an overlay; it must not consume the theme underneath it'
  );
  assert.strictEqual(prefs.resolvedThemeId(), 'abyssal-bloom');
  assert.strictEqual(JSON.parse(storage.data[PREFS_KEY]).themeId, 'abyssal-bloom');

  prefs.setHighContrast(false);
  assert.strictEqual(prefs.resolvedThemeId(), 'abyssal-bloom', 'the restore point has to restore');
  assert.strictEqual(prefs.resolvedTheme(), 'dark');
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

s.test('applyThemeState walks the registry: exactly one theme class survives a swap', () => {
  const app = loadAppSandbox();
  const doc = fakeDoc();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  const themes = app.sandbox.THEMES;
  const classNames = themes.map((t) => t.className).filter(Boolean);

  /* Every theme, then every theme again from a different starting point. The
   * bug this catches is the obvious one — a swap that ADDS a class without
   * removing the one before it — and it is invisible in CSS, because two
   * palettes on the same element resolve by source order and simply paint the
   * later one. The page would look right and the state would be wrong. */
  for (const from of themes) {
    for (const to of themes) {
      prefs.setThemeId(from.id);
      app.sandbox.applyThemeState(prefs, doc);
      prefs.setThemeId(to.id);
      const result = app.sandbox.applyThemeState(prefs, doc);

      assert.strictEqual(result.themeId, to.id, `${from.id} -> ${to.id} reported the wrong theme`);
      assert.strictEqual(result.theme, to.base);
      const present = classNames.filter((name) => doc.root.classList.contains(name));
      deepEqual(
        present,
        to.className ? [to.className] : [],
        `${from.id} -> ${to.id} left these theme classes on the root: ${present.join(', ')}`
      );
      assert.strictEqual(
        doc.meta.getAttribute('content'),
        to.base,
        'meta[name=color-scheme] must track the GROUND, or the UA keeps painting the wrong widgets'
      );
    }
  }

  // Studio Obsidian is still the absence of a class — :root IS its palette.
  prefs.setThemeId('obsidian');
  app.sandbox.applyThemeState(prefs, doc);
  deepEqual(doc.root.classes, [], 'Obsidian must leave the root element unclassed');
});

s.test('applyThemeState falls back to a base when handed a prefs that predates themeId', () => {
  const app = loadAppSandbox();

  /* Exactly the shape a caller built against the 0.15.0 API would pass: no
   * resolvedThemeId at all. It must resolve to that ground's default theme
   * rather than throwing or landing on undefined. */
  for (const [base, expectedId, expectedClass] of [
    ['light', 'daylight', LIGHT_CLASS],
    ['dark', 'obsidian', null],
    ['nonsense', 'obsidian', null],
  ]) {
    const doc = fakeDoc();
    const result = app.sandbox.applyThemeState(
      {
        resolvedTheme: () => base,
        isHighContrast: () => false,
        getCustomColors: () => ({}),
      },
      doc
    );
    assert.strictEqual(result.themeId, expectedId, `resolvedTheme() === ${base}`);
    assert.strictEqual(result.theme, expectedId === 'daylight' ? 'light' : 'dark');
    deepEqual(doc.root.classes, expectedClass ? [expectedClass] : []);
  }
});

s.test('a user colour override applies on top of ANY theme, and is suspended by Code Mode', () => {
  const app = loadAppSandbox();
  const prefs = app.sandbox.createThemePrefs({ storage: fakeStorage() });
  prefs.setCustomColor('--accent-cyan', '#FF0000');
  prefs.setCustomColor('--bg', 'rgba(1, 2, 3, 0.5)');
  const override = { '--accent-cyan': '#FF0000', '--bg': 'rgba(1, 2, 3, 0.5)' };

  for (const entry of app.sandbox.THEMES) {
    const doc = fakeDoc();
    prefs.setHighContrast(false);
    prefs.setThemeId(entry.id);
    app.sandbox.applyThemeState(prefs, doc);
    deepEqual(
      doc.snapshot(),
      override,
      `the overrides did not survive a switch to ${entry.id} — an inline custom property outranks ` +
        'every theme class, so a recolour is meant to follow the user across the whole suite'
    );

    prefs.setHighContrast(true);
    app.sandbox.applyThemeState(prefs, doc);
    deepEqual(
      doc.snapshot(),
      {},
      `a user colour survived Code Mode over ${entry.id}; it would out-specify the legibility mode`
    );
    assert.ok(
      doc.root.classList.contains(CONTRAST_CLASS),
      `Code Mode's class is missing over ${entry.id}`
    );
    if (entry.className) {
      assert.ok(
        doc.root.classList.contains(entry.className),
        `${entry.id}'s class must STAY under Code Mode — the mode overrides it by source order, ` +
          'not by removal, and it is the restore point'
      );
    }

    prefs.setHighContrast(false);
    app.sandbox.applyThemeState(prefs, doc);
    deepEqual(doc.snapshot(), override, `the overrides did not come back over ${entry.id}`);
  }
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

/* -------------------------------------------------------------------------- */
/* 4b. The suite — the mirror, the ratios and the registry (0.16.0)            */
/* -------------------------------------------------------------------------- */

s.test('every theme block is a name-for-name mirror of :root — all seventeen, nothing else', () => {
  const css = readStyle();
  const rootDecls = declarations(cssBlock(css, ':root {').body);
  const mirror = colorTokenNames(cssBlock(css, ':root {').body);

  assert.strictEqual(
    mirror.length,
    17,
    `the mirror is the fourteen themable tokens plus the three glows; :root declares ` +
      `${mirror.length} colour tokens: ${mirror.join(', ')}`
  );

  // The JS allow-list and the CSS palette are two halves of the same list, so
  // neither is allowed to grow without the other.
  const app = loadAppSandbox();
  const themable = app.sandbox.THEMABLE_TOKENS.map((t) => t.name).sort();
  deepEqual(
    mirror,
    themable.concat(GLOW_TOKENS).sort(),
    'the seventeen mirrored names must be exactly THEMABLE_TOKENS plus the three --glow-*'
  );

  for (const selector of THEME_CLASS_SELECTORS) {
    const decls = declarations(cssBlock(css, selector).body);
    deepEqual(
      Object.keys(decls).sort(),
      mirror,
      `${selector.replace(' {', '')} is not a mirror of :root. A token only SOME themes declare ` +
        'is a colour that survives a theme swap unchanged, which is how a palette rots one hue ' +
        'at a time; a token no theme but this one declares is dead weight'
    );

    // …and it must be a real second palette, not a copy of the first.
    const copied = mirror.filter((name) => decls[name] === rootDecls[name]);
    deepEqual(
      copied,
      [],
      `${selector.replace(' {', '')} copies these tokens from :root verbatim rather than ` +
        `re-designing them: ${copied.join(', ')}`
    );
  }

  /* Code Mode gets the same seventeen PLUS exactly two mode-only tokens. It is
   * a mode, not a theme: it may kill the blur and thicken the focus ring,
   * which no palette is allowed to touch. */
  const contrast = declarations(cssBlock(css, CODE_MODE_SELECTOR).body);
  deepEqual(
    Object.keys(contrast).sort(),
    mirror.concat(MODE_ONLY_TOKENS).sort(),
    '.high-contrast must declare the seventeen palette names plus --glass-blur and --focus-ring, ' +
      'and nothing else'
  );
  for (const selector of THEME_CLASS_SELECTORS) {
    const decls = declarations(cssBlock(css, selector).body);
    for (const token of MODE_ONLY_TOKENS) {
      assert.ok(
        !(token in decls),
        `${selector.replace(' {', '')} declares ${token}; a theme changes hues, not mechanics`
      );
    }
  }
});

s.test('every glow in every theme mixes its colour from that theme’s own accents', () => {
  const css = readStyle();
  const palette = new Set(colorTokenNames(cssBlock(css, ':root {').body));

  for (const selector of PALETTE_SELECTORS) {
    const decls = declarations(cssBlock(css, selector).body);
    for (const glow of GLOW_TOKENS) {
      const value = decls[glow];
      assert.ok(value, `${selector.replace(' {', '')} does not declare ${glow}`);
      assert.ok(
        /color-mix\(in srgb, var\(--/.test(value),
        `${selector.replace(' {', '')} ${glow} must mix its colour from an accent token, not ` +
          `hard-code one: ${value}`
      );
      const refs = value.match(/var\((--[a-zA-Z0-9-]+)\)/g) || [];
      for (const ref of refs) {
        const token = /var\((--[a-zA-Z0-9-]+)\)/.exec(ref)[1];
        assert.ok(
          palette.has(token),
          `${selector.replace(' {', '')} ${glow} derives from ${token}, which is not a palette token`
        );
      }
      assert.ok(
        !/#[0-9a-fA-F]{3,8}\b/.test(value),
        `${selector.replace(' {', '')} ${glow} hard-codes a hex: ${value}`
      );
    }
  }

  // Code Mode kills every glow outright: a halo is decoration, and the mode
  // trades decoration for legibility.
  const contrast = declarations(cssBlock(css, CODE_MODE_SELECTOR).body);
  for (const glow of GLOW_TOKENS) {
    assert.strictEqual(contrast[glow], 'none', `.high-contrast must resolve ${glow} to none`);
  }
});

s.test('theme swaps kill transitions for the swap frame (Chrome freeze fix, queued since Task 11)', () => {
  const style = readStyle();
  const source = readIndex();
  assert.ok(
    /\.theme-switching \*,\s*\n\s*\.theme-switching \*::before,\s*\n\s*\.theme-switching \*::after\s*\{\s*\n\s*transition: none !important;/.test(style),
    'the .theme-switching kill rule must cover elements and pseudo-elements'
  );
  const repaint = /function repaintTheme\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(repaint, 'repaintTheme not found');
  assert.ok(
    /classList\.add\('theme-switching'\)/.test(repaint[1]),
    'repaintTheme must add the kill class before applying the palette'
  );
  assert.ok(
    /classList\.remove\('theme-switching'\)/.test(repaint[1]),
    'repaintTheme must release the kill class after the swap frames'
  );
});

s.test('--ink-violet clears WCAG AA in every theme, and violet TEXT rides it, never the raw accent (0.16.x fix)', () => {
  const style = readStyle();

  // The raw accent may paint borders, glows and chip accents — never text.
  // .structure-tag and the pressed .btn-toggle label were the two offenders.
  assert.ok(
    !/(?<![-\w])color:\s*var\(--accent-violet\)/.test(style),
    'no rule may paint text with raw --accent-violet — violet text must use --ink-violet (border-color is fine)'
  );
  assert.ok(
    /\.structure-tag\s*\{[^}]*color:\s*var\(--ink-violet\)/.test(style),
    '.structure-tag must colour its text with --ink-violet'
  );
  assert.ok(
    /\.btn-toggle\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--ink-violet\)/.test(style),
    'the pressed .btn-toggle label must colour its text with --ink-violet'
  );

  // Track the SHIPPED mix so this test cannot drift from the CSS.
  const m = /--ink-violet:\s*color-mix\(in srgb,\s*var\(--accent-violet\)\s*([\d.]+)%,\s*var\(--text\)\s*([\d.]+)%\)/.exec(style);
  assert.ok(m, '--ink-violet must be declared as color-mix(in srgb, var(--accent-violet) N%, var(--text) M%)');
  const pv = Number(m[1]) / 100;
  const pt = Number(m[2]) / 100;
  assert.ok(Math.abs(pv + pt - 1) < 1e-9, '--ink-violet mix percentages must sum to 100%');

  for (const selector of PALETTE_SELECTORS.concat([CODE_MODE_SELECTOR])) {
    const decls = blockDecls(selector);
    const violet = parseCssColor(decls['--accent-violet']);
    const text = parseCssColor(decls['--text']);
    const bg = parseCssColor(decls['--bg']);
    assert.ok(violet && text && bg, `${selector} must declare parseable violet/text/bg`);
    // CSS color-mix in srgb: premultiplied-alpha interpolation of the
    // gamma-encoded components (matches what the browser computes).
    const a = violet.a * pv + text.a * pt;
    const ink = {
      r: (violet.r * violet.a * pv + text.r * text.a * pt) / a,
      g: (violet.g * violet.a * pv + text.g * text.a * pt) / a,
      b: (violet.b * violet.a * pv + text.b * text.a * pt) / a,
      a,
    };
    const ratio = contrastRatio(compositeOver(ink, bg), bg);
    assert.ok(
      ratio >= 4.5,
      `${selector.replace(' {', '')} --ink-violet lands at ${ratio.toFixed(2)}:1 over --bg — must clear AA (4.5:1)`
    );
  }
});

s.test('every theme’s documented contrast ratios are recomputed from its own declarations', () => {
  const rows = [];

  for (const selector of PALETTE_SELECTORS) {
    const decls = blockDecls(selector);
    const comment = commentFor(selector);
    const floors = THEME_CONTRAST_FLOORS[selector];
    const name = selector.replace(' {', '');
    assert.ok(floors, `${name} has no documented contrast floor in this suite`);

    const bg = decls['--bg'];
    assert.ok(
      /^#[0-9A-Fa-f]{6}$/.test(bg),
      `${name}: --bg must be an opaque hex — every ratio in the suite is measured against it, ` +
        `and a translucent ground has no defined one. Got ${bg}`
    );

    for (const token of ['--text', '--text-dim'].concat(CORRECTED_ACCENTS)) {
      const actual = ratioAgainst(decls[token], bg);
      const floor =
        token === '--text' ? floors.text : token === '--text-dim' ? floors.dim : floors.accent;
      assert.ok(
        actual >= floor,
        `${name} ${token} (${decls[token]}) is ${actual.toFixed(2)}:1 on ${bg} — below the ` +
          `${floor}:1 floor this suite documents for that theme`
      );
      rows.push(`${name} ${token} ${actual.toFixed(2)}`);

      /* Two blocks document their ACCENTS in a different, older shape and are
       * recomputed by their own test rather than here:
       *   :root has no table at all — it is the reference every other table
       *     quotes, and its values ARE the house palette;
       *   .theme-light publishes "old (ratio) -> new hex NAME ratio" rows,
       *     because its accents are a CORRECTION of Obsidian's rather than a
       *     fresh design, and "the documented contrast pairs match the values
       *     they document" recomputes both ends of every arrow.
       * Their --text / --text-dim rows are in the plain form and are checked
       * here like everyone else's. */
      if (selector === ':root {') continue;
      if (selector === '.theme-light {' && CORRECTED_ACCENTS.indexOf(token) !== -1) continue;
      const claimed = documentedRatio(comment, token);
      assert.ok(
        claimed !== null,
        `${name} does not document a ratio for ${token}. An undocumented palette value is a ` +
          'magic number, and this suite has no way to tell a considered choice from a typo'
      );
      assert.ok(
        Math.abs(actual - claimed) < RATIO_TOLERANCE,
        `${name} ${token}: the comment claims ${claimed}:1 against --bg, it is ${actual.toFixed(2)}:1`
      );
    }

    // The dimmed shade has to survive being read on a FIELD inside a CARD,
    // which is where most of it is actually painted — three composites deep.
    const surface = compositeOver(parseCssColor(decls['--surface']), parseCssColor(bg));
    const field = compositeOver(parseCssColor(decls['--field-bg']), surface);
    const dimOnField = contrastRatio(compositeOver(parseCssColor(decls['--text-dim']), field), field);
    assert.ok(
      dimOnField >= AA_NORMAL_TEXT,
      `${name}: --text-dim is ${dimOnField.toFixed(2)}:1 on a field inside a card — placeholder ` +
        'and helper text live there, and they have to clear AA where they are actually painted'
    );
  }

  assert.ok(rows.length >= 36, `expected six palettes x six tokens, measured ${rows.length}`);
});

s.test('the THEMES registry and the stylesheet describe the same six themes, both ways', () => {
  const app = loadAppSandbox();
  const css = readStyle();
  const themes = app.sandbox.THEMES;
  const codeMode = app.sandbox.CODE_MODE_THEME;

  assert.ok(Array.isArray(themes), 'THEMES must be a top-level var array');
  assert.strictEqual(
    themes.length,
    PALETTE_SELECTORS.length,
    `the registry lists ${themes.length} themes, the stylesheet ships ${PALETTE_SELECTORS.length} palettes`
  );

  const ids = new Set();
  const classNames = new Set();
  let unclassed = 0;

  for (const entry of themes) {
    assert.ok(entry && typeof entry.id === 'string' && /^[a-z][a-z0-9-]*$/.test(entry.id),
      `${JSON.stringify(entry && entry.id)} is not a usable slug — it is stored in localStorage`);
    assert.ok(typeof entry.label === 'string' && entry.label.trim(), `${entry.id} has no label`);
    assert.ok(typeof entry.kind === 'string' && entry.kind.trim(), `${entry.id} has no kind`);
    assert.ok(entry.base === 'dark' || entry.base === 'light', `${entry.id} has no dark/light base`);
    assert.ok(!ids.has(entry.id), `duplicate theme id ${entry.id}`);
    assert.ok(!classNames.has(entry.className), `duplicate className ${entry.className}`);
    ids.add(entry.id);
    classNames.add(entry.className);

    if (!entry.className) {
      // Exactly one theme may be class-free: Studio Obsidian IS :root.
      unclassed += 1;
      assert.strictEqual(entry.id, 'obsidian', 'only Studio Obsidian may be the un-classed theme');
      assert.strictEqual(entry.base, 'dark', ':root is the dark palette');
      continue;
    }
    const block = cssBlock(css, '.' + entry.className + ' {');
    assert.ok(
      block,
      `the registry names class "${entry.className}" for ${entry.id}, and no ` +
        `\`.${entry.className} { … }\` block exists — that theme would apply a class nobody wrote`
    );
    assert.ok(
      PALETTE_SELECTORS.indexOf('.' + entry.className + ' {') !== -1,
      `.${entry.className} is a registered theme but is not in this suite's ordered palette list, ` +
        'so its source position relative to Code Mode is unasserted'
    );
  }
  assert.strictEqual(unclassed, 1, 'exactly one theme may be the un-classed :root palette');

  // …and the other direction: no palette block may exist that nothing selects.
  for (const selector of THEME_CLASS_SELECTORS) {
    const className = selector.replace('.', '').replace(' {', '');
    assert.ok(
      classNames.has(className),
      `the stylesheet ships .${className} but the THEMES registry never names it — that palette ` +
        'is unreachable dead CSS'
    );
  }

  // Code Mode is deliberately NOT a theme: it is a mode with a picker row.
  assert.strictEqual(
    app.sandbox.themeById('studio-code'),
    null,
    'Studio Code must not be a registry theme, or `themeId: "studio-code"` becomes a second, ' +
      'unturn-off-able way to say what the highContrast boolean already says'
  );
  assert.strictEqual(codeMode.id, 'studio-code');
  assert.strictEqual(codeMode.className, CONTRAST_CLASS, 'the Code Mode row must apply .high-contrast');
  assert.ok(cssBlock(css, CODE_MODE_SELECTOR), '.high-contrast must exist as a token block');
  assert.ok(codeMode.label.trim() && codeMode.kind.trim(), 'the Code Mode row needs a label and a kind');

  // The picker renders the registry plus that one row: seven, no more, no less.
  assert.strictEqual(themes.length + 1, 7, 'the picker offers exactly seven choices');
  const bases = themes.map((t) => t.base);
  assert.ok(bases.indexOf('dark') !== -1 && bases.indexOf('light') !== -1,
    'the suite must offer both grounds, or the system preference has nothing to resolve to');
});

s.test('themeById / normalizeThemeId accept the registry and refuse everything else', () => {
  const app = loadAppSandbox();
  const { themeById, normalizeThemeId, defaultThemeIdForBase, THEMES } = app.sandbox;

  for (const entry of THEMES) {
    assert.strictEqual(themeById(entry.id), entry, `themeById(${entry.id}) must return the entry`);
    assert.strictEqual(normalizeThemeId(entry.id), entry.id);
  }
  for (const bogus of [
    'studio-code',
    'high-contrast',
    'theme-light',
    'Obsidian',
    'obsidian ',
    '',
    ' ',
    null,
    undefined,
    42,
    {},
    [],
    ['obsidian'],
    { id: 'obsidian' },
    { toString: () => 'obsidian' },
  ]) {
    assert.strictEqual(themeById(bogus), null, `themeById accepted ${JSON.stringify(String(bogus))}`);
    assert.strictEqual(normalizeThemeId(bogus), null, `normalizeThemeId accepted ${String(bogus)}`);
  }

  assert.strictEqual(defaultThemeIdForBase('light'), 'daylight');
  assert.strictEqual(defaultThemeIdForBase('dark'), 'obsidian');
  assert.strictEqual(defaultThemeIdForBase('nonsense'), 'obsidian', 'anything not light is dark');
});

s.test('menuKeyTarget is the picker’s whole keyboard model, and it is pure', () => {
  const app = loadAppSandbox();
  const { menuKeyTarget } = app.sandbox;
  assert.strictEqual(typeof menuKeyTarget, 'function', 'menuKeyTarget must be top-level');

  // Seven rows, the number the picker actually renders.
  assert.strictEqual(menuKeyTarget('ArrowDown', 0, 7), 1);
  assert.strictEqual(menuKeyTarget('ArrowDown', 6, 7), 0, 'the list wraps at the bottom');
  assert.strictEqual(menuKeyTarget('ArrowUp', 0, 7), 6, '…and at the top');
  assert.strictEqual(menuKeyTarget('ArrowUp', 3, 7), 2);
  assert.strictEqual(menuKeyTarget('Home', 5, 7), 0);
  assert.strictEqual(menuKeyTarget('End', 1, 7), 6);

  // Keys that belong to the page, not to the menu.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Tab', 'a', '', null]) {
    assert.strictEqual(menuKeyTarget(key, 0, 7), -1, `${JSON.stringify(key)} must not be handled`);
  }

  // Nonsense in, -1 or a valid index out — never a throw and never NaN.
  for (const [index, count] of [[-1, 7], [99, 7], [0, 0], [0, -3], [NaN, 7], [0, NaN], ['x', 'y']]) {
    const out = menuKeyTarget('ArrowDown', index, count);
    assert.ok(
      out === -1 || (Number.isInteger(out) && out >= 0),
      `menuKeyTarget('ArrowDown', ${String(index)}, ${String(count)}) returned ${String(out)}`
    );
  }
});

s.test('no colour literal of ANY form sits outside a token block', () => {
  const css = readStyle();
  /* CONSCIOUSLY UPDATED IN 0.16.0: the list was [:root, .theme-light, html,
   * .high-contrast]. The four palettes the theme suite added are token blocks
   * by definition — a palette IS where literals live — so the whitelist grows
   * with the suite. The assertion itself is unchanged: a hex or an rgba()
   * anywhere ELSE is still a colour no theme swap, no user recolour and no
   * Code Mode can reach. */
  const blocks = PALETTE_SELECTORS.concat(['html {', CODE_MODE_SELECTOR]).map((selector) => {
    const found = cssBlock(css, selector);
    assert.ok(found, `token block \`${selector} … }\` is missing`);
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

s.test('Code Mode is the last word: .high-contrast follows all five theme classes in source order', () => {
  const css = readStyle();

  /* CONSCIOUSLY EXTENDED IN 0.16.0: this used to compare three blocks. There
   * are seven now, and the reason is unchanged and stronger — every theme is a
   * single class, exactly the specificity .high-contrast carries, so the ONLY
   * thing that lets Code Mode beat five palettes instead of one is sitting
   * after all five. An editor who appends a new theme below it would silently
   * disable the accessibility mode for that theme alone. */
  const ordered = PALETTE_SELECTORS.concat([CODE_MODE_SELECTOR]).map((selector) => {
    const found = cssBlock(css, selector);
    assert.ok(found, `token block \`${selector} … }\` is missing`);
    return { selector: selector.replace(' {', ''), start: found.start };
  });

  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(
      ordered[i - 1].start < ordered[i].start,
      `${ordered[i].selector} must come after ${ordered[i - 1].selector}; the file reads ` +
        ordered
          .slice()
          .sort((a, b) => a.start - b.start)
          .map((e) => e.selector)
          .join(' -> ')
    );
  }

  const contrast = cssBlock(css, CODE_MODE_SELECTOR);
  for (const selector of THEME_CLASS_SELECTORS) {
    assert.ok(
      cssBlock(css, selector).start < contrast.start,
      `${selector.replace(' {', '')} sits AFTER .high-contrast, so it would beat Code Mode ` +
        'on equal specificity and the legibility mode would leak that theme'
    );
  }

  // The surfaces Code Mode has to flatten now include the ones this release
  // added, or the mode would leak a translucent panel into a legibility view.
  const decls = declarations(contrast.body);
  for (const token of ['--bg', '--surface', '--field-bg', '--viz-bg', '--toast-bg', '--text']) {
    assert.ok(token in decls, `.high-contrast does not override ${token}`);
  }
  assert.ok(/#000000/i.test(decls['--viz-bg']), 'the visualiser stage must go solid black too');
  assert.ok(/#000000/i.test(decls['--toast-bg']), 'floating panels must go solid black too');
});

/* CONSCIOUSLY REWRITTEN IN 0.16.0. Through 0.15.0 this test asserted
 * `contrast[token] === :root[token]` for all four accents — "Code Mode pins the
 * accents to Obsidian" — and parsed a two-column ratio table out of the
 * comment. That contract is now WRONG in a specific, deliberate way: two of the
 * four pins were RAISED for the black ground they are actually painted on.
 *
 *   --accent-violet   #8A2BE2 -> #B77CED   3.52:1 -> 7.12:1 on #000000
 *   --danger-crimson  #FF3366 -> #FF5983   5.92:1 -> 7.01:1 on #000000
 *
 * Both ratios are recomputed below from the shipped declarations, not quoted.
 * The 3.52:1 secondary is the item PLANNING.md carried as "Consider: Code Mode
 * violet accent at 3.52:1 on black" — a legibility mode whose secondary accent
 * misses AA was the one thing in the mode that was not legible. Raising it
 * breaks nothing else: cyan and amber were already the brightest values in the
 * app and stay byte-identical to Obsidian, so the mode still reads as Obsidian
 * with the contrast turned up rather than as a seventh palette.
 *
 * The replacement contract is STRONGER than identity, and is what identity was
 * standing in for all along: Code Mode's ground is black under every one of
 * the six themes, so each pin must beat what EVERY palette's own value for
 * that token would have measured there, and must clear AA outright. Identity
 * with Obsidian was one way to satisfy that; it is no longer the only way, and
 * it was never the point. */
s.test('Code Mode pins every accent for a black ground, beating what any theme would leak', () => {
  const css = readStyle();
  const comment = commentFor(CODE_MODE_SELECTOR);
  const dark = declarations(cssBlock(css, ':root {').body);
  const contrast = declarations(cssBlock(css, CODE_MODE_SELECTOR).body);
  const BLACK = '#000000';
  /* The short name each token goes by in the comment's ratio table. */
  const TABLE_ROW = {
    '--accent-cyan': 'cyan',
    '--accent-violet': 'violet',
    '--warning-amber': 'amber',
    '--danger-crimson': 'crimson',
  };
  /* Which pins moved in 0.16.0 and which are still Obsidian's, so "unchanged"
   * is asserted rather than assumed for the two that did not move. */
  const RAISED = ['--accent-violet', '--danger-crimson'];

  for (const token of CORRECTED_ACCENTS) {
    assert.ok(
      token in contrast,
      `.high-contrast does not pin ${token}. Code Mode's ground is black under EVERY theme, so ` +
        'a palette derived for a light ground — or for a warm brown one — would leak into the ' +
        'accessibility mode as the least legible colour in the app'
    );

    const pinned = ratioAgainst(contrast[token], BLACK);
    assert.ok(
      pinned >= AA_NORMAL_TEXT,
      `${token} is pinned to ${contrast[token]}, which is ${pinned.toFixed(2)}:1 on black — the ` +
        'legibility mode may not ship an accent that misses AA on its own ground'
    );

    /* Every palette's value for the same token, measured on black. A theme
     * whose own value already clears AA there is not a legibility problem and
     * the pin is free to be dimmer than it (Abyssal Bloom's pure #00FFFF is
     * brighter than the pin, and that is fine); a theme whose value MISSES AA
     * is precisely what the pin exists to keep out, so the pin must beat every
     * one of those. At least one palette has to fail per token, or the pin
     * would be pinning against nothing. */
    let illegible = 0;
    for (const selector of PALETTE_SELECTORS) {
      const theirs = blockDecls(selector)[token];
      const leaked = ratioAgainst(theirs, BLACK);
      if (leaked >= AA_NORMAL_TEXT) continue;
      illegible += 1;
      assert.ok(
        pinned > leaked,
        `${token}: ${selector.replace(' {', '')}'s ${theirs} is ${leaked.toFixed(2)}:1 on black — ` +
          `under AA — yet the pin ${contrast[token]} only manages ${pinned.toFixed(2)}:1`
      );
    }
    assert.ok(
      illegible > 0,
      `${token} is pinned, but every palette's own value already clears AA on black — the pin ` +
        'would be keeping nothing out and the comment above it is documenting a fiction'
    );

    if (RAISED.indexOf(token) === -1) {
      assert.strictEqual(
        contrast[token].toUpperCase(),
        dark[token].toUpperCase(),
        `${token} was already legible on black and must stay byte-identical to Obsidian, so the ` +
          'mode keeps reading as Obsidian-with-the-contrast-up'
      );
    } else {
      assert.notStrictEqual(
        contrast[token].toUpperCase(),
        dark[token].toUpperCase(),
        `${token} is documented as RAISED in 0.16.0 but still carries the Obsidian value`
      );
      assert.ok(
        pinned > ratioAgainst(dark[token], BLACK),
        `${token} was raised, so it has to measure BETTER than Obsidian's ` +
          `${ratioAgainst(dark[token], BLACK).toFixed(2)}:1 on black; it measures ${pinned.toFixed(2)}:1`
      );
      assert.ok(
        pinned >= 7,
        `${token} was raised specifically to clear 7:1 on black; it measures ${pinned.toFixed(2)}:1`
      );
    }

    /* The comment's ratio table is the reason each pin exists, so all four of
     * its columns — the hex, the pin's ratio, and what Obsidian and Daylight
     * would have measured — are recomputed here. */
    const row = new RegExp(
      '^\\s*' + TABLE_ROW[token] + '\\s+(#[0-9A-Fa-f]{6})\\s+([0-9.]+):1\\s+([0-9.]+):1\\s+([0-9.]+):1',
      'm'
    ).exec(comment);
    assert.ok(row, `the .high-contrast comment has no "<hex> pin / Obsidian / Daylight" row for ${token}`);
    assert.strictEqual(
      row[1].toUpperCase(),
      contrast[token].toUpperCase(),
      `${token}: the table names ${row[1]} as the pin, the block declares ${contrast[token]}`
    );
    const claims = [Number(row[2]), Number(row[3]), Number(row[4])];
    const actual = [
      pinned,
      ratioAgainst(dark[token], BLACK),
      ratioAgainst(blockDecls('.theme-light {')[token], BLACK),
    ];
    for (let i = 0; i < 3; i += 1) {
      assert.ok(
        Math.abs(claims[i] - actual[i]) < RATIO_TOLERANCE,
        `${token}: the table's column ${i + 1} claims ${claims[i]}:1 on black, it is ` +
          `${actual[i].toFixed(2)}:1`
      );
    }
  }

  /* The border moved with the accents, and for the same reason: in a mode
   * where every surface is the same black, the border IS the layout. The
   * comment documents both ends of that move, so both are recomputed. */
  const move = /--surface-border\s+moved 0\.45 -> 0\.55 \(([0-9.]+):1 -> ([0-9.]+):1\)/.exec(comment);
  assert.ok(move, 'the .high-contrast comment must document the --surface-border raise');
  assert.ok(
    Math.abs(ratioAgainst('rgba(255, 255, 255, 0.45)', BLACK) - Number(move[1])) < RATIO_TOLERANCE,
    `the comment claims the old border was ${move[1]}:1 on black`
  );
  assert.ok(
    Math.abs(ratioAgainst(contrast['--surface-border'], BLACK) - Number(move[2])) < RATIO_TOLERANCE,
    `the comment claims the new border is ${move[2]}:1, it is ` +
      `${ratioAgainst(contrast['--surface-border'], BLACK).toFixed(2)}:1`
  );
  assert.ok(
    ratioAgainst(contrast['--surface-border'], BLACK) > ratioAgainst('rgba(255, 255, 255, 0.45)', BLACK),
    'the border raise has to make the border MORE visible, not less'
  );
});

/* -------------------------------------------------------------------------- */
/* 4c. Colour vision — the only reason Studio ColorSafe exists                 */
/* -------------------------------------------------------------------------- */

s.test('the Viénot simulation itself behaves, before anything is asserted through it', () => {
  // Grey is on the achromatic axis: no cone contribution to lose, so every
  // dichromacy leaves it where it was. This is the standard sanity check on a
  // Viénot implementation, and it fails loudly if a matrix coefficient is
  // mistyped — without it the whole section could pass on garbage.
  for (const grey of [0, 64, 128, 200, 255]) {
    for (const kind of CVD_KINDS) {
      const out = simulateCvd({ r: grey, g: grey, b: grey }, kind);
      for (const ch of ['r', 'g', 'b']) {
        assert.ok(
          Math.abs(out[ch] - grey) <= 2,
          `${kind} moved the neutral ${grey} to rgb(${out.r}, ${out.g}, ${out.b})`
        );
      }
    }
  }

  // Protanopia and deuteranopia are red/green losses: pure red and pure green
  // must collapse toward each other. Tritanopia is a blue/yellow loss and must
  // leave them apart.
  const red = { r: 255, g: 0, b: 0 };
  const green = { r: 0, g: 255, b: 0 };
  const plain = deltaE76(red, green);
  for (const kind of ['protan', 'deutan']) {
    const collapsed = deltaE76(simulateCvd(red, kind), simulateCvd(green, kind));
    assert.ok(
      collapsed < plain / 2,
      `${kind} must collapse red against green; ΔE went ${plain.toFixed(1)} -> ${collapsed.toFixed(1)}`
    );
  }
  assert.ok(
    deltaE76(simulateCvd(red, 'tritan'), simulateCvd(green, 'tritan')) > plain / 2,
    'tritanopia is a blue/yellow loss and must leave red and green far apart'
  );

  assert.strictEqual(deltaE76({ r: 12, g: 34, b: 56 }, { r: 12, g: 34, b: 56 }), 0);
  assert.throws(() => simulateCvd(red, 'nope'), /unknown CVD kind/);
});

s.test('Studio ColorSafe keeps all four accents apart under protan, deutan and tritan', () => {
  const decls = blockDecls('.theme-studio-colorsafe {');
  const worst = { deltaE: Infinity, where: '' };

  for (const kind of CVD_KINDS) {
    const seen = {};
    for (const token of CORRECTED_ACCENTS) {
      const parsed = parseCssColor(decls[token]);
      assert.ok(parsed, `${token} is not a parseable colour: ${decls[token]}`);
      assert.strictEqual(parsed.a, 1, `${token} must be opaque — a simulation needs a real colour`);
      seen[token] = simulateCvd(parsed, kind);
    }

    for (let i = 0; i < CORRECTED_ACCENTS.length; i += 1) {
      for (let j = i + 1; j < CORRECTED_ACCENTS.length; j += 1) {
        const a = CORRECTED_ACCENTS[i];
        const b = CORRECTED_ACCENTS[j];
        const difference = deltaE76(seen[a], seen[b]);
        if (difference < worst.deltaE) {
          worst.deltaE = difference;
          worst.where = `${a} vs ${b} under ${kind}`;
        }
        assert.ok(
          difference >= CVD_MIN_DELTA_E,
          `ColorSafe ${a} (${decls[a]}) and ${b} (${decls[b]}) collapse to ΔE ` +
            `${difference.toFixed(1)} under ${kind} — below the ${CVD_MIN_DELTA_E} this theme ` +
            'exists to hold. Two states of the interface would be painted the same colour'
        );
      }
    }

    /* The pairs that carry meaning get the stronger bar: they must differ in
     * LIGHTNESS too, which is the one channel no dichromacy can take away. A
     * user who cannot see the hue difference between "warning" and "danger"
     * can still see that one is darker. */
    for (const [a, b] of CVD_SEMANTIC_PAIRS) {
      const ratio = contrastRatio(seen[a], seen[b]);
      assert.ok(
        ratio >= CVD_MIN_SEMANTIC_CONTRAST,
        `ColorSafe ${a} and ${b} are a SEMANTIC pair, and under ${kind} they differ by only ` +
          `${ratio.toFixed(2)}:1 in lightness — hue is all that is left to tell them apart, ` +
          'and hue is exactly what this user does not have'
      );
    }

    // Each accent still has to be readable ON the theme's ground afterwards:
    // separating four colours that have all become invisible is no use.
    const bg = simulateCvd(parseCssColor(decls['--bg']), kind);
    for (const token of CORRECTED_ACCENTS) {
      const ratio = contrastRatio(seen[token], bg);
      assert.ok(
        ratio >= 3,
        `ColorSafe ${token} falls to ${ratio.toFixed(2)}:1 against its own ground under ${kind}`
      );
    }
  }

  assert.ok(
    worst.deltaE >= CVD_MIN_DELTA_E,
    `the tightest ColorSafe pair is ${worst.where} at ΔE ${worst.deltaE.toFixed(1)}`
  );
});

s.test('…and Studio Daylight fails that same bar, which is why ColorSafe was built', () => {
  /* The control. If the house light theme passed the contract above, the
   * colour-blind theme would be four new hexes for nothing — so the bar is
   * only meaningful while a palette that was NOT designed for CVD misses it.
   * Studio Obsidian is measured too: the suite's claim is about the accents
   * the app normally paints with, not about one theme. */
  for (const selector of ['.theme-light {', ':root {']) {
    const decls = blockDecls(selector);
    const failures = [];

    for (const kind of CVD_KINDS) {
      const seen = {};
      for (const token of CORRECTED_ACCENTS) {
        seen[token] = simulateCvd(parseCssColor(decls[token]), kind);
      }
      for (let i = 0; i < CORRECTED_ACCENTS.length; i += 1) {
        for (let j = i + 1; j < CORRECTED_ACCENTS.length; j += 1) {
          const difference = deltaE76(seen[CORRECTED_ACCENTS[i]], seen[CORRECTED_ACCENTS[j]]);
          if (difference < CVD_MIN_DELTA_E) {
            failures.push(
              `${CORRECTED_ACCENTS[i]}/${CORRECTED_ACCENTS[j]} under ${kind}: ΔE ${difference.toFixed(1)}`
            );
          }
        }
      }
    }

    assert.ok(
      failures.length > 0,
      `${selector.replace(' {', '')} passes the CVD bar unaided, so either the bar is too low to ` +
        'mean anything or Studio ColorSafe is redundant. One of the two needs re-deciding'
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

/* CONSCIOUSLY REWRITTEN IN 0.16.0. Through 0.15.0 this asserted that
 * #btn-theme was a `aria-pressed` toggle whose accessible name contained the
 * visible word "Light". Both halves are now wrong BY DESIGN: there are seven
 * themes, and a two-state control cannot express seven, so the toggle became a
 * menu button whose visible label is the fixed word "Theme". What the old test
 * was really protecting — a real, announced, keyboard-reachable control whose
 * accessible name contains its visible label (WCAG 2.5.3) — is asserted below
 * against the pattern that replaced it. */
s.test('the theme switcher is a menu button whose accessible name carries its visible label', () => {
  const html = readIndex();

  assert.ok(/id="btn-theme"/.test(html), 'index.html is missing the #btn-theme switcher');
  assert.ok(
    !/id="btn-theme"[\s\S]{0,300}aria-pressed=/.test(html),
    '#btn-theme is no longer a toggle: aria-pressed on a menu button announces a two-state ' +
      'control that does not exist'
  );
  assert.ok(
    /id="btn-theme"[\s\S]{0,300}aria-haspopup="menu"/.test(html),
    '#btn-theme must declare that it opens a menu'
  );
  assert.ok(
    /id="btn-theme"[\s\S]{0,300}aria-expanded="false"/.test(html),
    '#btn-theme must expose aria-expanded, and the menu must start closed'
  );
  assert.ok(
    /id="btn-theme"[\s\S]{0,300}aria-controls="theme-panel"/.test(html),
    '#btn-theme must name the panel it controls'
  );

  const label = /id="btn-theme"[\s\S]{0,400}aria-label="([^"]+)"/.exec(html);
  assert.ok(label, '#btn-theme must carry an aria-label');
  assert.ok(
    /^Theme:/.test(label[1]),
    `the accessible name must contain the visible label "Theme" (WCAG 2.5.3); got "${label[1]}"`
  );
  assert.ok(
    /id="btn-theme"[\s\S]{0,1600}<span>Theme<\/span>/.test(html),
    'the visible label must be the literal word the accessible name starts with'
  );

  // The panel: a menu of rows, labelled by its own heading, closed at boot.
  for (const id of ['theme-panel', 'theme-panel-title', 'theme-rows']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }
  assert.ok(/id="theme-panel"[\s\S]{0,120}hidden>/.test(html), 'the theme panel must start closed');
  assert.ok(
    /id="theme-rows"[\s\S]{0,140}role="menu"/.test(html),
    'the ROWS carry role="menu", not the panel — a menu whose first child is a heading is not a menu'
  );
  assert.ok(
    /id="theme-rows"[\s\S]{0,200}aria-labelledby="theme-panel-title"/.test(html),
    'the menu must be labelled by the panel heading'
  );
  // The rows themselves are built from the registry, so the markup must not
  // hard-code any of them — that is what keeps the two from drifting.
  assert.ok(
    /id="theme-rows"[^>]*>\s*<\/div>/.test(html),
    '#theme-rows must ship empty: its rows come from the THEMES registry at boot'
  );

  // Both glyphs ship inline — a single-file app has no icon font to fetch —
  // and exactly one of them starts hidden.
  for (const id of ['theme-glyph-sun', 'theme-glyph-moon']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }
  assert.ok(
    /id="theme-glyph-sun"[\s\S]{0,400}hidden>/.test(html),
    'the sun glyph must start hidden — the app boots into a dark-based theme'
  );
  /* CONSCIOUSLY NARROWED IN 0.19.0: this used to scan the whole file. It now
   * scans the MARKUP, because 0.19.0 added an SVG that is not markup — the PWA
   * icon (FDD #89), which is a STANDALONE SVG document inside a data: URI in
   * #app-main and does not parse without an xmlns. The assertion's actual
   * subject is unchanged and still enforced: an <svg> ELEMENT in this HTML
   * needs no namespace, and one carrying an absolute URL would be a URL in a
   * resource-loading position. The icon's namespace is allowed by
   * tests/verify-single-file.js rule 7, exact-match, with its own negatives. */
  assert.ok(
    !/<svg[^>]*xmlns=/.test(stripScriptBodies(html)),
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

s.test('the picker popover is styled like the header’s other popover, and survives Code Mode', () => {
  const css = readStyle();

  // Same positioning contract as the colours disclosure beside it: a popover
  // inside a header that is its own stacking context has to be anchored, or it
  // paints under the workspace.
  assert.ok(
    /\.theme-menu[^{]*\{[^}]*position:\s*relative/.test(css),
    '.theme-menu must be the positioning context for the theme popover'
  );
  assert.ok(
    /\.theme-panel\s*\{[^}]*position:\s*absolute/.test(css),
    '.theme-panel must be absolutely positioned against .theme-menu'
  );
  assert.ok(
    /\.theme-panel\[hidden\]\s*\{\s*display:\s*none/.test(css),
    '.theme-panel must collapse when [hidden]: it is a flex/absolute box, and the UA default ' +
      'display:none is exactly what a display declaration would have overridden'
  );

  // The checked row has to be legible as checked without relying on colour
  // alone once Code Mode flattens its wash.
  const checked = /\.theme-row\[aria-checked="true"\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(checked, '.theme-row[aria-checked="true"] must be styled — a menu needs a current item');
  assert.ok(/var\(--/.test(checked[1]), 'the checked row must paint from tokens, not literals');
  assert.ok(
    /\.high-contrast \.theme-row\[aria-checked="true"\]\s*\{[^}]*var\(--accent-cyan\)/.test(css),
    'Code Mode flattens the checked row’s wash, so the accent BORDER has to carry the signal'
  );
  assert.ok(
    /\.high-contrast[^{]*\.theme-panel[^{]*\{[^}]*backdrop-filter:\s*none/.test(css),
    'the theme popover is glass, so Code Mode must kill its blur like every other glass surface'
  );

  // The swatch strip is the theme itself: it paints from var() only, so it
  // cannot drift from the block whose class it carries.
  const strip = /\.theme-swatches\s*\{([^}]*)\}/.exec(css);
  assert.ok(strip, '.theme-swatches must exist — every row previews its own palette');
  assert.ok(
    /background:\s*var\(--bg\)/.test(strip[1]),
    'the strip’s ground must be var(--bg), which the row’s theme class re-declares on the strip'
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(strip[1]),
    `the swatch strip must hold no colour literal at all: ${strip[1].trim()}`
  );
  assert.ok(/\.theme-swatch\s*\{/.test(css), '.theme-swatch (the dots) must exist');

  // Focus is visible on a keyboard-driven menu, or the roving tabindex is a
  // trap rather than a feature.
  assert.ok(
    /\.theme-row:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/.test(css),
    '.theme-row needs a token-driven focus ring — Code Mode thickens it'
  );
});

/* ------------------------------------------------------------------------ *
 * TODO: coverage that activates with later features.
 * ------------------------------------------------------------------------ */

s.todo(
  'the picker is driven through a real DOM: pick a colour, assert getComputedStyle changed',
  'needs the browser E2E harness; today the row wiring is verified by hand in a browser (all ' +
    'seven themes cycled, computed --bg/--text/--accent-cyan spot-checked per theme, keyboard ' +
    'nav and reload persistence walked) and the pure halves (validation, composition, ' +
    'applyThemeState, menuKeyTarget) are covered here'
);
s.todo(
  'the palettes are checked against measured, laid-out contrast rather than declared tokens',
  'needs a headless browser with getComputedStyle to sample real foreground/background pairs after ' +
    'the cascade; today the ratios are recomputed from the declarations themselves, which catches ' +
    'a drifted token but not a rule that paints two of them on each other'
);
s.todo(
  'per-theme colour overrides (one custom palette per theme rather than one shared map)',
  'today customColors is one map shared by all six themes, so a colour chosen against Studio ' +
    'Obsidian follows the user into Tape Deck; splitting it needs a UI affordance for "which ' +
    'theme am I editing" before the storage shape changes'
);
s.todo(
  'the ribbon’s DSP hues are CVD-corrected under Studio ColorSafe',
  'major=cyan / minor=violet are a documented DSP contract (FEATURE-MECHANICS.md §1.5) duplicated ' +
    'in the GLSL fragment shader, so they sit outside the token system entirely: the colour-blind ' +
    'theme corrects the interface and not the visualiser. Owner call — a second, theme-aware ' +
    'valence palette is a visualiser feature, not a theme one'
);

module.exports = { fakeDoc, fakeMatchMedia, declarations, contrastRatio, ratioAgainst };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
