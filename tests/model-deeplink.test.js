'use strict';
/*
 * tests/model-deeplink.test.js — the paired 0.21.0 release:
 *
 *   docs/FDD.md #69  Suno Model Selector        -> var SUNO_MODELS threaded
 *                                                  through the compile pipeline
 *   docs/FDD.md #75  Base64 / URL-Hash Deep Link -> encodeWorkspaceHash /
 *                                                  decodeWorkspaceHash
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING, in the order the file runs:
 *
 *   1. THE REGISTRY IS HONEST. docs/FEATURE-MECHANICS.md §3 documents v5.5 and
 *      nothing else, so every knob on every entry carries the BASIS it was
 *      chosen on. The tests below check the shape of that claim AND the claim
 *      itself: a knob marked 'documented' has its citation read back out of
 *      the real docs/ file, and only v5.5 is allowed to carry one. If someone
 *      later "improves" v4 with a plausible-sounding invented ceiling, the
 *      basis vocabulary is what fails.
 *
 *   2. v5.5 IS BYTE-IDENTICAL. The default model is the behaviour this app
 *      shipped for eleven releases, and threading an options argument through
 *      four functions is exactly the change that quietly moves a string. Every
 *      compile is run BOTH ways — with no options at all (the pre-0.21.0 call
 *      shape) and with sunoModelOptions('v5-5') — over a populated workspace,
 *      and against a baseline string captured from the shipped pipeline.
 *
 *   3. THE OLDER MODELS DIFFER EXACTLY AS SPECIFIED, and no further. The
 *      [Exclude: …] block is omitted and REPORTED, the modifier cap is 2 in
 *      the compiled tag while the store still holds four, and the ceiling is
 *      the same 1,000 — because that is the only ceiling anything documents.
 *
 *   4. A HOSTILE HASH LANDS INERT. Tampered checksum, valid checksum over
 *      hostile JSON, a quarter-megabyte of garbage: each is refused, at the
 *      cheapest stage that can refuse it, with every store untouched. The
 *      oversize test proves the refusal happens BEFORE JSON.parse by counting
 *      calls to a JSON.parse this suite installs in the sandbox.
 *
 *   5. NOTHING SECRET TRAVELS. A registry-shaped object carrying a vault
 *      record and a cloud key is encoded, and the decoded payload is compared
 *      byte-for-byte with the clean workspace's.
 *
 *   6. THE PRECEDENCE IS REAL, NOT WISHED FOR. autosave < workspace hash <
 *      ?lyrics=, proven twice: behaviourally, by composing the very functions
 *      the boot composes over real stores, and structurally, by reading the
 *      boot chain out of #app-main.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById, stripScriptBodies } = require('./lib/extract.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const MECHANICS = path.join(ROOT, 'docs', 'FEATURE-MECHANICS.md');
const FDD = path.join(ROOT, 'docs', 'FDD.md');

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * #app-main in a DOM-free vm context.
 *
 * URLSearchParams is here for the same reason tests/pwa.test.js carries it —
 * parseSharedLyrics needs it, and the precedence matrix below drives the real
 * share reader rather than a stand-in for it. Everything else is a language
 * built-in, which is what keeps the top level of #app-main loadable here.
 */
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
    URLSearchParams,
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
  SUNO_MODELS,
  SUNO_MODEL_KNOBS,
  SUNO_MODEL_BASES,
  SUNO_MODEL_KNOB_LABELS,
  DEFAULT_SUNO_MODEL_ID,
  sunoModelById,
  resolveSunoModel,
  sunoModelOptions,
  sunoModelKnob,
  createPromptState,
  createExclusionState,
  createStructureState,
  serializeWorkspace,
  validateWorkspaceSnapshot,
  restoreWorkspace,
  createThemePrefs,
  buildFinalPrompt,
  compileStylePrompt,
  formatStructureTag,
  clampModifiers,
  encodeWorkspaceHash,
  decodeWorkspaceHash,
  isWorkspaceHash,
  buildWorkspaceLink,
  crc32,
  crc32Hex,
  utf8Encode,
  utf8Decode,
  base64ToBase64Url,
  base64UrlToBytes,
  bytesToBase64,
  stableJsonStringify,
  parseSharedLyrics,
  PROMPT_CHAR_LIMIT,
  STRUCTURE_MAX_MODIFIERS,
  WORKSPACE_HASH_PREFIX,
  WORKSPACE_HASH_MAX_CHARS,
  WORKSPACE_LINK_WARN_CHARS,
  SLIDER_DEFAULT,
} = app.sandbox;

/** Re-create a vm-context value as a plain object of THIS realm. */
function realm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(realm(actual), realm(expected), message);
}

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/** The Prompt Editor's markup only — script bodies blanked, tags kept. */
function readEditorMarkup() {
  const html = stripScriptBodies(readIndex());
  const start = html.indexOf('id="view-editor"');
  assert.ok(start !== -1, '#view-editor is missing');
  const end = html.indexOf('</main>', start);
  return html.slice(start, end === -1 ? html.length : end);
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/* -------------------------------------------------------------------------- */
/* Workspace fixtures — the same shape tests/persistence.test.js uses          */
/* -------------------------------------------------------------------------- */

function makeRegistry(initialSliders) {
  const sliders = Object.assign(
    { energy: SLIDER_DEFAULT, warmth: SLIDER_DEFAULT, density: SLIDER_DEFAULT },
    initialSliders || {}
  );
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
    values: sliders,
  };
}

/**
 * A realistic, non-trivial workspace: every prompt section populated through a
 * REAL source id, two exclusions, and a song flow whose first block holds the
 * full §3.2 four modifiers (which is what makes the v4 cap observable).
 */
function populate(registry) {
  registry.promptState.add({ section: 'genre', tag: 'french electro', source: 'manual', weight: 0.9 });
  registry.promptState.add({ section: 'genre', tag: 'techno', source: 'dissector', weight: 0.75 });
  registry.promptState.add({ section: 'mood', tag: 'nocturnal', source: 'scene' });
  registry.promptState.add({ section: 'vocal', tag: 'breathy alto', source: 'vocal-persona' });
  registry.promptState.add({ section: 'instrument', tag: 'analog bass', source: 'instrument-block' });
  registry.promptState.add({ section: 'scene', tag: 'neon rain', source: 'scene' });
  registry.promptState.add({ section: 'era', tag: '2007 blog house', source: 'era-signature' });
  registry.promptState.setSource('slider-energy', ['high energy', 'driving rhythm']);

  registry.exclusions.add('male vocals');
  registry.exclusions.add('acoustic guitar');

  const intro = registry.structure.addBlock('[Intro]');
  registry.structure.setModifiers(intro, ['sparse', 'filtered', 'wide', 'airy']);
  const chorus = registry.structure.addBlock('[Chorus]');
  registry.structure.setLyrics(chorus, 'lights over the rooftops');
  registry.structure.addBlock('[Outro]');

  registry.sliders.set('energy', 86);
  return registry;
}

/** Everything observable about a registry, for "nothing was touched". */
function snapshotOf(registry) {
  return JSON.stringify({
    prompt: registry.promptState.list(),
    exclusions: registry.exclusions.list(),
    structure: registry.structure.toJSON(),
    sliders: {
      energy: registry.sliders.get('energy'),
      warmth: registry.sliders.get('warmth'),
      density: registry.sliders.get('density'),
    },
  });
}

/* THE CAPTURED BASELINES. Taken from the shipped pipeline over populate()
 * above, and pinned here so a future refactor cannot move the default model's
 * output without this file saying so. They are strings, not rules: the rules
 * are in tests/compiler.test.js and tests/limiter-eval.js. */
const BASELINE_V55_STYLE =
  'french electro, techno, nocturnal, breathy alto, analog bass, neon rain, 2007 blog house, ' +
  'high energy, driving rhythm [Exclude: male vocals, acoustic guitar]';
const BASELINE_V4_STYLE =
  'french electro, techno, nocturnal, breathy alto, analog bass, neon rain, 2007 blog house, ' +
  'high energy, driving rhythm';
const BASELINE_V55_SHEET =
  '[Intro - sparse, filtered, wide, airy]\n\n[Chorus]\nlights over the rooftops\n\n[Outro]';
const BASELINE_V4_SHEET = '[Intro - sparse, filtered]\n\n[Chorus]\nlights over the rooftops\n\n[Outro]';

/** A fake localStorage that records every mutation. */
function fakeStorage(seed) {
  const data = Object.assign(Object.create(null), seed || {});
  const writes = [];
  return {
    data,
    writes,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      writes.push({ key, value });
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    keysWritten() {
      return writes.map((w) => w.key);
    },
  };
}

const s = suite('model selector (FDD #69) + workspace deep links (FDD #75)');

/* ========================================================================== */
/* A. THE REGISTRY, AND THE HONESTY OF ITS CLAIMS                             */
/* ========================================================================== */

s.test('SUNO_MODELS ships the three models FDD #69 names, newest first, ids unique', () => {
  assert.ok(Array.isArray(SUNO_MODELS) || SUNO_MODELS.length !== undefined, 'SUNO_MODELS is not a list');
  const ids = [];
  const labels = [];
  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    ids.push(SUNO_MODELS[i].id);
    labels.push(SUNO_MODELS[i].label);
  }
  deepEqual(ids, ['v5-5', 'v4', 'v3-5'], 'FDD #69 names v5.5, v4 and v3.5 — in that order');
  assert.strictEqual(new Set(ids).size, ids.length, 'two entries share an id');
  assert.strictEqual(new Set(labels).size, labels.length, 'two entries share a label');
  assert.strictEqual(DEFAULT_SUNO_MODEL_ID, 'v5-5', 'the whole app is documented against v5.5');
  assert.ok(sunoModelById(DEFAULT_SUNO_MODEL_ID), 'the default id must exist in the registry');

  // Every label names the model a user would recognise, and none of them
  // invents a version this app knows nothing about.
  deepEqual(labels, ['Suno v5.5', 'Suno v4', 'Suno v3.5']);
});

s.test('every entry declares EXACTLY the four knobs — no invented syntax rules', () => {
  deepEqual(SUNO_MODEL_KNOBS, ['charLimit', 'modifierCap', 'excludeSupported', 'sectionNumbering']);

  const structural = ['id', 'label', 'summary', 'basis', 'rationale'];
  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    const entry = SUNO_MODELS[i];
    const keys = Object.keys(realm(entry)).sort();
    deepEqual(
      keys,
      structural.concat(SUNO_MODEL_KNOBS).sort(),
      `${entry.id} carries a field that is neither a documented knob nor its provenance — a new ` +
        'knob is a new claim about Suno and needs a basis of its own'
    );
    assert.strictEqual(typeof entry.charLimit, 'number');
    assert.ok(entry.charLimit > 0 && Math.floor(entry.charLimit) === entry.charLimit);
    assert.strictEqual(typeof entry.modifierCap, 'number');
    assert.ok(entry.modifierCap >= 1 && Math.floor(entry.modifierCap) === entry.modifierCap);
    assert.strictEqual(typeof entry.excludeSupported, 'boolean');
    assert.strictEqual(typeof entry.sectionNumbering, 'boolean');
    assert.ok(entry.summary && entry.summary.length > 30, `${entry.id} has no usable summary`);
  }
});

s.test('every knob carries a BASIS from the vocabulary and a rationale that explains it', () => {
  deepEqual(SUNO_MODEL_BASES, ['documented', 'conservative', 'app-convention']);

  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    const entry = SUNO_MODELS[i];
    deepEqual(
      Object.keys(realm(entry.basis)).sort(),
      SUNO_MODEL_KNOBS.slice().sort(),
      `${entry.id}.basis must account for every knob and nothing else`
    );
    deepEqual(
      Object.keys(realm(entry.rationale)).sort(),
      SUNO_MODEL_KNOBS.slice().sort(),
      `${entry.id}.rationale must account for every knob and nothing else`
    );
    for (let k = 0; k < SUNO_MODEL_KNOBS.length; k += 1) {
      const knob = SUNO_MODEL_KNOBS[k];
      const basis = entry.basis[knob];
      assert.ok(
        SUNO_MODEL_BASES.indexOf(basis) !== -1,
        `${entry.id}.basis.${knob} is ${JSON.stringify(basis)}, which is not a basis this app knows`
      );
      const why = entry.rationale[knob];
      assert.ok(
        typeof why === 'string' && why.length > 40,
        `${entry.id}.rationale.${knob} does not explain anything: ${JSON.stringify(why)}`
      );
    }
  }
});

s.test('ONLY v5.5 claims a documented basis — and its citations are real lines in docs/', () => {
  const mechanics = fs.readFileSync(MECHANICS, 'utf8');
  const fdd = fs.readFileSync(FDD, 'utf8');

  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    const entry = SUNO_MODELS[i];
    for (let k = 0; k < SUNO_MODEL_KNOBS.length; k += 1) {
      const knob = SUNO_MODEL_KNOBS[k];
      if (entry.basis[knob] !== 'documented') continue;
      assert.strictEqual(
        entry.id,
        'v5-5',
        `${entry.id}.${knob} claims to be documented, but docs/FEATURE-MECHANICS.md §3 describes ` +
          'v5.5 and nothing else. A conservative choice must say so.'
      );
    }
  }

  // The v5.5 citations are checked against the documents themselves, so a
  // rationale cannot go on citing a rule that has been rewritten or removed.
  const v55 = sunoModelById('v5-5');
  assert.strictEqual(v55.basis.charLimit, 'documented');
  assert.ok(
    /1,000-character/.test(fdd) || /1,000 characters/.test(fdd),
    'FDD.md no longer states the 1,000-character ceiling the registry cites'
  );
  assert.strictEqual(v55.basis.modifierCap, 'documented');
  assert.ok(
    /must not exceed 4 comma-separated terms/.test(mechanics),
    '§3.2 no longer states the four-term cap the registry cites'
  );
  assert.strictEqual(v55.basis.excludeSupported, 'documented');
  assert.ok(
    /\[Exclude: \.\.\.\]/.test(mechanics) && /in v5\.5 is handled explicitly/.test(mechanics),
    '§3.3 no longer states the [Exclude: …] rule the registry cites'
  );
  // The numbering rule is this app's, and says so rather than borrowing authority.
  assert.strictEqual(v55.basis.sectionNumbering, 'app-convention');
});

s.test('v5.5’s knobs ARE the shipped constants — the registry cannot drift from the compiler', () => {
  const v55 = sunoModelById('v5-5');
  assert.strictEqual(v55.charLimit, PROMPT_CHAR_LIMIT, 'the registry and PROMPT_CHAR_LIMIT disagree');
  assert.strictEqual(
    v55.modifierCap,
    STRUCTURE_MAX_MODIFIERS,
    'the registry and STRUCTURE_MAX_MODIFIERS disagree about §3.2'
  );
  assert.strictEqual(v55.excludeSupported, true);
  assert.strictEqual(v55.sectionNumbering, true);
});

s.test('THE CONSERVATIVE KNOBS: the ceiling is HELD, the bracket is halved, the shield is off', () => {
  const v55 = sunoModelById('v5-5');
  for (const id of ['v4', 'v3-5']) {
    const entry = sunoModelById(id);

    // The ceiling is kept, not guessed — in either direction.
    assert.strictEqual(
      entry.charLimit,
      v55.charLimit,
      `${id} moved the character ceiling; no document states one for it, so the only defensible ` +
        'value is the documented 1,000'
    );
    assert.strictEqual(entry.basis.charLimit, 'conservative');
    assert.ok(
      /no document states|only documented ceiling/i.test(entry.rationale.charLimit),
      `${id}.rationale.charLimit must say the ceiling is held for want of a document`
    );

    assert.strictEqual(entry.modifierCap, 2, `${id} must halve the bracket rather than invent a cap`);
    assert.strictEqual(entry.basis.modifierCap, 'conservative');

    assert.strictEqual(entry.excludeSupported, false, `${id} must not emit an undocumented block`);
    assert.strictEqual(entry.basis.excludeSupported, 'conservative');

    assert.strictEqual(
      entry.sectionNumbering,
      v55.sectionNumbering,
      'section numbering is an app convention and does not move with the model'
    );
  }

  // v4 and v3.5 are IDENTICAL, deliberately: nothing available here documents a
  // difference, and inventing one to make the entries look different would be
  // the exact fabrication this registry exists to avoid.
  const v4 = realm(sunoModelById('v4'));
  const v35 = realm(sunoModelById('v3-5'));
  for (let k = 0; k < SUNO_MODEL_KNOBS.length; k += 1) {
    assert.strictEqual(
      v4[SUNO_MODEL_KNOBS[k]],
      v35[SUNO_MODEL_KNOBS[k]],
      `v4 and v3.5 disagree about ${SUNO_MODEL_KNOBS[k]} — on the strength of which document?`
    );
  }
});

s.test('every knob has a user-facing name, so the note reads as a sentence', () => {
  const labels = realm(SUNO_MODEL_KNOB_LABELS);
  deepEqual(Object.keys(labels).sort(), SUNO_MODEL_KNOBS.slice().sort());
  for (const key of Object.keys(labels)) {
    assert.ok(labels[key] && labels[key].length > 3, `${key} has no readable label`);
    assert.ok(labels[key] === labels[key].toLowerCase(), 'a mid-sentence label must be lower case');
  }
});

s.test('resolveSunoModel never throws and never invents: junk resolves to the default', () => {
  for (const junk of [null, undefined, '', 'v6', 'V5-5', 0, 42, {}, [], true, 'v5_5']) {
    assert.strictEqual(
      resolveSunoModel(junk).id,
      DEFAULT_SUNO_MODEL_ID,
      `${JSON.stringify(junk)} resolved to something other than the default`
    );
  }
  assert.strictEqual(sunoModelById('v4').id, 'v4');
  assert.strictEqual(sunoModelById('V4'), null, 'ids are exact — a near miss is not a match');
  assert.strictEqual(sunoModelById(null), null);
});

s.test('sunoModelOptions is the whole knob set; sunoModelKnob’s precedence is explicit > model > default', () => {
  const v4 = sunoModelOptions('v4');
  deepEqual(realm(v4), {
    modelId: 'v4',
    max: 1000,
    modifierCap: 2,
    excludeSupported: false,
    sectionNumbering: true,
  });
  assert.strictEqual(sunoModelOptions('nonsense').modelId, DEFAULT_SUNO_MODEL_ID);

  // 1. explicit wins
  assert.strictEqual(sunoModelKnob({ modelId: 'v4', modifierCap: 3 }, 'modifierCap'), 3);
  // 2. the model named by the options
  assert.strictEqual(sunoModelKnob({ modelId: 'v4' }, 'modifierCap'), 2);
  // 3. the default, for anything else at all
  for (const junk of [undefined, null, {}, [], 'v4', 7]) {
    assert.strictEqual(sunoModelKnob(junk, 'modifierCap'), STRUCTURE_MAX_MODIFIERS);
  }
  // An explicitly-null knob is not a value; it falls through to the model.
  assert.strictEqual(sunoModelKnob({ modelId: 'v4', modifierCap: null }, 'modifierCap'), 2);
});

/* ========================================================================== */
/* B. v5.5 IS BYTE-IDENTICAL TO THE BUILD BEFORE THE SELECTOR EXISTED          */
/* ========================================================================== */

s.test('BYTE IDENTITY: the populated workspace compiles to the captured v5.5 baseline', () => {
  const r = populate(makeRegistry());

  // The pre-0.21.0 call shape: no options at all.
  const legacy = buildFinalPrompt(r.promptState, r.exclusions.list());
  assert.strictEqual(legacy.text, BASELINE_V55_STYLE, 'the default model’s output MOVED');
  assert.strictEqual(legacy.length, BASELINE_V55_STYLE.length);
  assert.strictEqual(legacy.limit, PROMPT_CHAR_LIMIT);
  assert.strictEqual(legacy.modelId, 'v5-5');
  assert.strictEqual(legacy.excludeOmitted, false);

  // …and the explicit v5.5 options are the same thing said out loud.
  const explicit = buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions('v5-5'));
  assert.strictEqual(explicit.text, legacy.text, 'v5-5 options changed the string');
  deepEqual(realm(explicit), realm(legacy), 'v5-5 options changed the RESULT, not just the string');

  // The structure sheet too — same baseline, both ways.
  assert.strictEqual(r.structure.compile(), BASELINE_V55_SHEET);
  assert.strictEqual(r.structure.compile(sunoModelOptions('v5-5')), BASELINE_V55_SHEET);
  assert.strictEqual(
    formatStructureTag('Intro', null, ['sparse', 'filtered', 'wide', 'airy']),
    '[Intro - sparse, filtered, wide, airy]'
  );
  assert.strictEqual(
    formatStructureTag('Intro', null, ['sparse', 'filtered', 'wide', 'airy'], sunoModelOptions('v5-5')),
    '[Intro - sparse, filtered, wide, airy]'
  );
});

s.test('BYTE IDENTITY holds across a matrix of workspaces, not just one', () => {
  const cases = [
    ['empty', (r) => r],
    ['tags only', (r) => {
      r.promptState.add({ section: 'genre', tag: 'amapiano', source: 'manual', weight: 1 });
      return r;
    }],
    ['exclusions only', (r) => {
      r.exclusions.add('harsh noise');
      return r;
    }],
    ['both', populate],
    ['over the ceiling', (r) => {
      r.promptState.batch(function () {
        for (let i = 0; i < 200; i += 1) {
          r.promptState.add({ section: 'genre', tag: 'descriptor number ' + i, source: 'manual' });
        }
      });
      r.exclusions.add('male vocals');
      return r;
    }],
  ];

  for (const [name, build] of cases) {
    const a = build(makeRegistry());
    const b = build(makeRegistry());
    const legacy = buildFinalPrompt(a.promptState, a.exclusions.list());
    const explicit = buildFinalPrompt(b.promptState, b.exclusions.list(), sunoModelOptions('v5-5'));
    assert.strictEqual(explicit.text, legacy.text, `${name}: v5-5 diverged from the default path`);
    assert.strictEqual(explicit.trimmed, legacy.trimmed, `${name}: trimming diverged`);
    deepEqual(explicit.droppedTags, legacy.droppedTags, `${name}: the drop report diverged`);
    assert.ok(explicit.length <= PROMPT_CHAR_LIMIT, `${name}: the ceiling was breached`);
  }
});

s.test('an explicit max still outranks the model — the option that predates the registry', () => {
  const r = populate(makeRegistry());
  const tight = buildFinalPrompt(r.promptState, r.exclusions.list(), { max: 30 });
  assert.ok(tight.length <= 30, `${tight.length} > 30`);
  assert.strictEqual(tight.limit, 30);
  assert.strictEqual(tight.trimmed, true);
  assert.strictEqual(tight.modelId, 'v5-5', 'no modelId still means the default model');

  // …and it outranks a model that was named as well.
  const both = buildFinalPrompt(r.promptState, r.exclusions.list(), { max: 40, modelId: 'v4' });
  assert.strictEqual(both.limit, 40);
  assert.strictEqual(both.modelId, 'v4');
});

/* ========================================================================== */
/* C. WHAT THE OLDER MODELS ACTUALLY DO DIFFERENTLY                           */
/* ========================================================================== */

s.test('v4 / v3.5 omit the [Exclude: …] block — and REPORT that they did', () => {
  const r = populate(makeRegistry());

  for (const id of ['v4', 'v3-5']) {
    const final = buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions(id));
    assert.strictEqual(final.text, BASELINE_V4_STYLE, `${id} did not compile the expected string`);
    assert.strictEqual(final.text.indexOf('[Exclude:'), -1, `${id} wrote an undocumented block`);
    assert.strictEqual(final.excludeOmitted, true, `${id} omitted the block SILENTLY`);
    // The terms are not deleted: they are still reported, so the card can say
    // they are kept and will compile again on v5.5.
    deepEqual(final.exclusions, ['male vocals', 'acoustic guitar']);
    assert.strictEqual(final.modelId, id);

    const compiled = compileStylePrompt(r.promptState, r.exclusions.list(), sunoModelOptions(id));
    assert.strictEqual(compiled.meta.excludeBlock, '', 'no block may be built at all');
    assert.strictEqual(compiled.meta.excludeOmitted, true);
  }

  // Switching back restores the block exactly — nothing was destroyed.
  assert.strictEqual(
    buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions('v5-5')).text,
    BASELINE_V55_STYLE
  );
});

s.test('excludeOmitted is about OMISSION, not about having no exclusions', () => {
  const r = makeRegistry();
  r.promptState.add({ section: 'genre', tag: 'techno', source: 'manual' });

  const noneV4 = buildFinalPrompt(r.promptState, [], sunoModelOptions('v4'));
  assert.strictEqual(noneV4.excludeOmitted, false, 'nothing was omitted — there was nothing to omit');
  assert.strictEqual(noneV4.text, 'techno');

  r.exclusions.add('male vocals');
  const someV4 = buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions('v4'));
  assert.strictEqual(someV4.excludeOmitted, true);
  const someV55 = buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions('v5-5'));
  assert.strictEqual(someV55.excludeOmitted, false);
  assert.strictEqual(someV55.text, 'techno [Exclude: male vocals]');
});

s.test('v4 / v3.5 clamp the bracket to 2 modifiers — while the STORE still holds four', () => {
  const r = populate(makeRegistry());
  const mods = ['sparse', 'filtered', 'wide', 'airy'];

  assert.strictEqual(formatStructureTag('Intro', null, mods, sunoModelOptions('v4')), '[Intro - sparse, filtered]');
  assert.strictEqual(formatStructureTag('Intro', null, mods, sunoModelOptions('v3-5')), '[Intro - sparse, filtered]');
  assert.strictEqual(r.structure.compile(sunoModelOptions('v4')), BASELINE_V4_SHEET);
  assert.strictEqual(r.structure.compile(sunoModelOptions('v3-5')), BASELINE_V4_SHEET);

  // §3.2's priority rule is unchanged: the first terms survive, in order.
  deepEqual(clampModifiers(mods, 2), ['sparse', 'filtered']);
  deepEqual(clampModifiers(mods), mods, 'no cap means §3.2’s four');
  deepEqual(clampModifiers(mods, 0), [], 'a zero cap is a real cap, not a fallback');

  // The store is untouched by the model: this is a COMPILE-time ceiling.
  const stored = r.structure.blocks()[0].modifiers;
  deepEqual(stored, mods, 'the model clamped the stored data, which would be data loss');
  assert.strictEqual(r.structure.compile(sunoModelOptions('v5-5')), BASELINE_V55_SHEET);
});

s.test('the ceiling comes from the registry, and today every model keeps the documented 1,000', () => {
  const r = populate(makeRegistry());
  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    const entry = SUNO_MODELS[i];
    const final = buildFinalPrompt(r.promptState, r.exclusions.list(), sunoModelOptions(entry.id));
    assert.strictEqual(final.limit, entry.charLimit, `${entry.id} did not compile at its own ceiling`);
    assert.strictEqual(final.limit, PROMPT_CHAR_LIMIT, 'the conservative ceiling is the documented one');
  }
});

s.test('sectionNumbering is a REAL knob, not a decorative one', () => {
  // Every shipped model numbers, so the knob is exercised explicitly: a knob
  // nothing reads would be a claim the registry does not keep.
  assert.strictEqual(formatStructureTag('Verse', 2, ['tight']), '[Verse 2 - tight]');
  assert.strictEqual(
    formatStructureTag('Verse', 2, ['tight'], { sectionNumbering: false }),
    '[Verse - tight]'
  );
  assert.strictEqual(
    formatStructureTag('Verse', 2, ['tight'], { sectionNumbering: true }),
    '[Verse 2 - tight]'
  );
  for (let i = 0; i < SUNO_MODELS.length; i += 1) {
    assert.strictEqual(
      formatStructureTag('Verse', 2, [], sunoModelOptions(SUNO_MODELS[i].id)),
      '[Verse 2]',
      `${SUNO_MODELS[i].id} stopped numbering, which no document asks for`
    );
  }
});

s.test('the §3.1 metatag taxonomy is SHARED — validation is not model-scoped', () => {
  const source = app.source;
  // The taxonomy functions take no model argument, by signature.
  assert.ok(/function validateMetatag\(([^)]*)\)/.test(source));
  const validate = /function validateMetatag\(([^)]*)\)/.exec(source)[1];
  assert.ok(!/model/i.test(validate), `validateMetatag grew a model parameter: (${validate})`);
  const sanitize = /function sanitizeStructureTag\(([^)]*)\)/.exec(source)[1];
  assert.ok(!/model/i.test(sanitize), `sanitizeStructureTag grew a model parameter: (${sanitize})`);
  // And SUNO_METATAGS is one table, not one per model.
  assert.strictEqual((source.match(/var SUNO_METATAGS = /g) || []).length, 1);
  assert.ok(
    !/SUNO_MODELS[\s\S]{0,400}metatags/i.test(source.slice(source.indexOf('var SUNO_MODELS'), source.indexOf('var SUNO_MODELS') + 400)),
    'a model entry must not carry its own tag taxonomy'
  );
});

/* ========================================================================== */
/* D. THE CHOICE PERSISTS AS LIGHTWEIGHT UI STATE                             */
/* ========================================================================== */

s.test('the model choice round-trips through suno_ui_prefs beside the theme', () => {
  const storage = fakeStorage();
  const prefs = createThemePrefs({ storage });

  assert.strictEqual(prefs.getModelId(), null, 'an untouched install has chosen nothing');
  assert.strictEqual(prefs.resolvedModelId(), 'v5-5', 'and compiles for v5.5 anyway');
  assert.strictEqual(storage.writes.length, 0, 'reading a preference must not write one');

  assert.strictEqual(prefs.setModelId('v4'), 'v4');
  deepEqual(storage.keysWritten(), ['suno_ui_prefs'], 'only the one UI-state key is written');
  const stored = JSON.parse(storage.data['suno_ui_prefs']);
  assert.strictEqual(stored.modelId, 'v4');
  assert.strictEqual(stored.highContrast, false, 'the older fields must survive the new one');
  deepEqual(stored.customColors, {});

  const reloaded = createThemePrefs({ storage });
  reloaded.load();
  assert.strictEqual(reloaded.getModelId(), 'v4', 'the choice did not survive a reload');
  assert.strictEqual(reloaded.resolvedModelId(), 'v4');

  // …and it does not clobber the theme, which shares the record.
  reloaded.setThemeId('tape-deck');
  const both = JSON.parse(storage.data['suno_ui_prefs']);
  assert.strictEqual(both.modelId, 'v4', 'writing the theme erased the model');
  assert.strictEqual(both.themeId, 'tape-deck');
});

s.test('a stored model id is VALIDATED, and an unknown one changes nothing', () => {
  const prefs = createThemePrefs({ storage: fakeStorage() });
  prefs.setModelId('v4');
  const writes = [];

  // An id this build does not know is refused outright: nothing stored, nothing
  // changed — the same contract setThemeId has.
  assert.strictEqual(prefs.setModelId('v9'), 'v4');
  assert.strictEqual(prefs.getModelId(), 'v4');
  assert.strictEqual(prefs.setModelId(null), 'v5-5', 'null hands the decision back to the default');
  assert.strictEqual(prefs.getModelId(), null);

  // A record left by a build that shipped a model this one does not falls back
  // to the default rather than compiling for a model nobody defined.
  const hostile = fakeStorage({
    suno_ui_prefs: JSON.stringify({ highContrast: true, theme: 'dark', modelId: 'v9-9' }),
  });
  const loaded = createThemePrefs({ storage: hostile });
  loaded.load();
  assert.strictEqual(loaded.getModelId(), null, 'an unknown stored id must not survive the read');
  assert.strictEqual(loaded.resolvedModelId(), 'v5-5');
  assert.strictEqual(loaded.isHighContrast(), true, 'the rest of the record still loaded');
  assert.strictEqual(writes.length, 0);
});

s.test('the model is NOT part of a workspace — it describes the machine, not the song', () => {
  const snapshot = serializeWorkspace(populate(makeRegistry()), { savedAt: 1 });
  deepEqual(
    Object.keys(realm(snapshot)).sort(),
    ['exclusions', 'prompt', 'savedAt', 'sliders', 'structure', 'workspaceVersion'],
    'the snapshot shape must not have grown a model field'
  );
  const decoded = decodeWorkspaceHash(encodeWorkspaceHash(snapshot));
  assert.strictEqual(decoded.ok, true);
  assert.strictEqual(
    JSON.stringify(realm(decoded.snapshot)).indexOf('modelId'),
    -1,
    'a share link must not impose the sender’s model on the recipient'
  );
});

/* ========================================================================== */
/* E. THE CODEC                                                               */
/* ========================================================================== */

s.test('the primitives match the platform: crc32, UTF-8 and base64url', () => {
  // The CRC-32 check value every implementation of this polynomial agrees on.
  assert.strictEqual(crc32(utf8Encode('123456789')), 0xcbf43926);
  assert.strictEqual(crc32Hex([]), '00000000', 'the checksum is fixed-width');
  assert.strictEqual(crc32Hex(utf8Encode('123456789')), 'cbf43926');

  for (const text of ['', 'hello', 'é€𝄞 ünïcøde', '"quotes" & <tags>', 'line\nbreak', '🎧🎛️']) {
    const bytes = utf8Encode(text);
    assert.ok(
      Buffer.from(bytes).equals(Buffer.from(text, 'utf8')),
      `utf8Encode diverged from the platform on ${JSON.stringify(text)}`
    );
    assert.strictEqual(utf8Decode(bytes), text, `utf8Decode failed to round-trip ${JSON.stringify(text)}`);
    const encoded = base64ToBase64Url(bytesToBase64(bytes));
    assert.strictEqual(
      encoded,
      Buffer.from(text, 'utf8').toString('base64url'),
      `base64url diverged from the platform on ${JSON.stringify(text)}`
    );
    if (text) deepEqual(base64UrlToBytes(encoded), bytes);
  }
});

s.test('the decoders are STRICT — a malformed byte sequence is refused, not repaired', () => {
  // UTF-8: overlong, lone continuation, truncated, surrogate half, out of range.
  for (const [bytes, why] of [
    [[0xc0, 0x80], 'overlong NUL'],
    [[0xe0, 0x80, 0x80], 'overlong three-byte'],
    [[0x80], 'a continuation byte alone'],
    [[0xe2, 0x82], 'a truncated three-byte sequence'],
    [[0xed, 0xa0, 0x80], 'a surrogate half'],
    [[0xf5, 0x80, 0x80, 0x80], 'past U+10FFFF'],
    [[0xff], 'never a leading byte'],
  ]) {
    assert.strictEqual(utf8Decode(bytes), null, `${why} was decoded instead of refused`);
  }

  // base64url: the standard alphabet's own characters are NOT base64url.
  assert.strictEqual(base64UrlToBytes('a+bc'), null, "'+' is not base64url");
  assert.strictEqual(base64UrlToBytes('a/bc'), null, "'/' is not base64url");
  assert.strictEqual(base64UrlToBytes('aGVsbG8='), null, 'padding is not base64url');
  assert.strictEqual(base64UrlToBytes('A'), null, 'six leftover bits cannot end an encoding');
  assert.strictEqual(base64UrlToBytes('AB'), null, 'a non-zero remainder means an edited string');
  assert.strictEqual(base64UrlToBytes('a b'), null);
  assert.strictEqual(base64UrlToBytes(''), null);
});

s.test('stableJsonStringify is deterministic regardless of how an object was built', () => {
  const a = { b: 1, a: [3, { z: 1, y: 2 }], c: { n: null } };
  const b = { c: { n: null }, a: [3, { y: 2, z: 1 }], b: 1 };
  assert.strictEqual(stableJsonStringify(a), stableJsonStringify(b));
  assert.strictEqual(stableJsonStringify(a), '{"a":[3,{"y":2,"z":1}],"b":1,"c":{"n":null}}');
  // And it still IS JSON.
  deepEqual(JSON.parse(stableJsonStringify(a)), realm(a));
});

s.test('encode / decode round-trip a populated snapshot, and re-encoding is a fixpoint', () => {
  const snapshot = serializeWorkspace(populate(makeRegistry()), { savedAt: 1700000000000 });
  const hash = encodeWorkspaceHash(snapshot);

  // The wire format, exactly as documented.
  const parts = hash.split('.');
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], WORKSPACE_HASH_PREFIX);
  assert.strictEqual(parts[0], 'spb1');
  assert.ok(/^[0-9a-f]{8}$/.test(parts[1]), `checksum "${parts[1]}" is not 8 lower-case hex`);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(parts[2]), 'the payload left the base64url alphabet');

  const decoded = decodeWorkspaceHash(hash);
  assert.strictEqual(decoded.ok, true, decoded.reason);
  deepEqual(decoded.snapshot, snapshot, 'the snapshot did not survive the round trip');
  assert.strictEqual(
    encodeWorkspaceHash(decoded.snapshot),
    hash,
    're-encoding what was decoded must produce the identical link'
  );
  assert.strictEqual(encodeWorkspaceHash(snapshot), hash, 'the same workspace must encode the same, twice');
  // The leading '#' is accepted, because that is how location.hash reports it.
  assert.strictEqual(decodeWorkspaceHash('#' + hash).ok, true);

  // And the decoded snapshot really does rebuild the workspace.
  const target = makeRegistry();
  const outcome = restoreWorkspace(decoded.snapshot, target);
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(
    buildFinalPrompt(target.promptState, target.exclusions.list()).text,
    BASELINE_V55_STYLE
  );
  assert.strictEqual(target.structure.compile(), BASELINE_V55_SHEET);
  assert.strictEqual(target.sliders.get('energy'), 86);
});

s.test('an empty workspace round-trips too — the boring case is a case', () => {
  const snapshot = serializeWorkspace(makeRegistry(), { savedAt: 7 });
  const decoded = decodeWorkspaceHash(encodeWorkspaceHash(snapshot));
  assert.strictEqual(decoded.ok, true, decoded.reason);
  deepEqual(decoded.snapshot, snapshot);
});

s.test('a tampered checksum is refused, and nothing is applied', () => {
  const registry = populate(makeRegistry());
  const hash = encodeWorkspaceHash(serializeWorkspace(registry, { savedAt: 5 }));
  const parts = hash.split('.');
  const target = populate(makeRegistry());
  const before = snapshotOf(target);

  for (const [broken, why] of [
    [parts[0] + '.deadbeef.' + parts[2], 'a checksum from another payload'],
    [parts[0] + '.' + parts[1] + '.' + parts[2].slice(0, -4), 'a payload cut short'],
    [parts[0] + '.' + parts[1] + '.' + parts[2].slice(0, 8) + 'AAAA' + parts[2].slice(12), 'an edited payload'],
    [parts[0] + '.DEADBEEF.' + parts[2], 'an upper-case checksum'],
    [parts[0] + '.dead.' + parts[2], 'a short checksum'],
  ]) {
    const verdict = decodeWorkspaceHash(broken);
    assert.strictEqual(verdict.ok, false, `${why} was accepted`);
    assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0, 'a refusal must say why');
    assert.strictEqual(verdict.snapshot, undefined, 'a refusal must hand back nothing to apply');
  }
  assert.strictEqual(snapshotOf(target), before, 'a refused link touched a store');
});

s.test('a VALID checksum over hostile JSON is still refused — by the shared validator', () => {
  const hostile = [
    [{ workspaceVersion: 1, prompt: [{ tag: 'x', source: 'evil' }] }, 'an unknown source'],
    [{ workspaceVersion: 1, prompt: [{ tag: '', source: 'manual' }] }, 'an empty tag'],
    [{ workspaceVersion: 2 }, 'a future workspace version'],
    [{ workspaceVersion: 1, sliders: { energy: 999 } }, 'a slider past its range'],
    [{ workspaceVersion: 1, sliders: [] }, 'sliders as an array'],
    [{ workspaceVersion: 1, structure: { blocks: 'nope' } }, 'blocks as a string'],
    [{ workspaceVersion: 1, exclusions: [42] }, 'a non-string exclusion'],
    [[1, 2, 3], 'an array instead of an object'],
    ['{"workspaceVersion":1}', 'a JSON string rather than an object'],
    [null, 'null'],
  ];

  const target = populate(makeRegistry());
  const before = snapshotOf(target);

  for (const [payload, why] of hostile) {
    // A REAL, CORRECT checksum: the attacker controls the payload, so they
    // control the checksum too. This is exactly why the validator is the gate.
    const bytes = utf8Encode(JSON.stringify(payload));
    const forged = 'spb1.' + crc32Hex(bytes) + '.' + base64ToBase64Url(bytesToBase64(bytes));
    assert.strictEqual(decodeWorkspaceHash(forged).ok, false, `${why} passed validation`);

    // The same payload is refused by the validator directly — the codec did not
    // invent a second, weaker set of rules.
    assert.strictEqual(validateWorkspaceSnapshot(payload).ok, false, `${why} passed the validator`);
    assert.strictEqual(restoreWorkspace(payload, target).ok, false, `${why} was restored`);
  }
  assert.strictEqual(snapshotOf(target), before, 'hostile JSON mutated a store');
});

s.test('an oversize hash is refused BEFORE JSON.parse is ever reached', () => {
  const realJson = app.sandbox.JSON;
  let parses = 0;
  // A counting JSON, installed into the sandbox's global: #app-main resolves
  // `JSON` at call time, so this observes the real code path.
  app.sandbox.JSON = {
    parse(text) {
      parses += 1;
      return realJson.parse(text);
    },
    stringify(value) {
      return realJson.stringify(value);
    },
  };
  try {
    const huge = 'spb1.cbf43926.' + 'A'.repeat(WORKSPACE_HASH_MAX_CHARS + 1);
    assert.ok(huge.length > WORKSPACE_HASH_MAX_CHARS);
    const verdict = decodeWorkspaceHash(huge);
    assert.strictEqual(verdict.ok, false);
    assert.ok(/larger than/.test(verdict.reason), `unexpected reason: ${verdict.reason}`);
    assert.strictEqual(parses, 0, 'a quarter-megabyte of garbage reached JSON.parse');

    // The alphabet and checksum gates come before the parse as well.
    parses = 0;
    assert.strictEqual(decodeWorkspaceHash('spb1.cbf43926.@@@@').ok, false);
    assert.strictEqual(decodeWorkspaceHash('spb1.00000000.aGVsbG8').ok, false);
    assert.strictEqual(parses, 0, 'a payload that fails the checksum was parsed anyway');
  } finally {
    app.sandbox.JSON = realJson;
  }
  assert.strictEqual(WORKSPACE_HASH_MAX_CHARS, 262144, 'the documented ceiling is 256k characters');
});

s.test('a fragment that is not ours is left completely alone', () => {
  // The jump nav puts these in the very same slot.
  for (const foreign of ['#style-heading', '#history-heading', '', '#', 'spb', 'spb2.abc.def', '#spb11.a.b']) {
    assert.strictEqual(isWorkspaceHash(foreign), false, `${JSON.stringify(foreign)} was claimed`);
  }
  assert.strictEqual(isWorkspaceHash('spb1.cbf43926.aGVsbG8'), true);
  assert.strictEqual(isWorkspaceHash('#spb1.cbf43926.aGVsbG8'), true);

  // …and decoding one says so plainly rather than crashing.
  for (const foreign of ['#style-heading', 'spb2.cbf43926.aGVsbG8', 'spb1', 'spb1.abc']) {
    const verdict = decodeWorkspaceHash(foreign);
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.reason);
  }
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.strictEqual(decodeWorkspaceHash(junk).ok, false);
    assert.strictEqual(isWorkspaceHash(junk), false);
  }
});

s.test('NO key material can reach an encoded payload, and the bytes prove it', () => {
  const SECRET = 'sk-live-do-not-share-4711';
  const clean = serializeWorkspace(populate(makeRegistry()), { savedAt: 11 });

  // Exactly the shapes the boot holds a cloud provider and a vault record in,
  // hung off the object handed to the encoder.
  const fat = serializeWorkspace(populate(makeRegistry()), { savedAt: 11 });
  fat.cloud = { endpoint: 'https://api.example.com/v1/chat/completions', key: SECRET };
  fat.vault = { slot: 'openrouter::https://openrouter.ai', ciphertext: [1, 2, 3], key: SECRET };
  fat.dissectKeyInput = { value: SECRET };
  fat.apiKey = SECRET;

  const hashed = encodeWorkspaceHash(fat);
  assert.strictEqual(hashed, encodeWorkspaceHash(clean), 'the fat object encoded differently');

  // Decoded back to TEXT, so the assertion is about the payload's bytes and not
  // about an object graph that might hide something.
  const bytes = base64UrlToBytes(hashed.split('.')[2]);
  const json = utf8Decode(bytes);
  for (const needle of [SECRET, 'api.example.com', 'openrouter', 'cloud', 'vault', 'apiKey', 'ciphertext']) {
    assert.strictEqual(json.indexOf(needle), -1, `"${needle}" reached the shared payload`);
  }
  deepEqual(JSON.parse(json), realm(clean));
});

s.test('buildWorkspaceLink drops the query and the old fragment, or refuses honestly', () => {
  const hash = 'spb1.cbf43926.aGVsbG8';
  assert.strictEqual(
    buildWorkspaceLink('https://example.com/studio/index.html?lyrics=hello#old', hash),
    'https://example.com/studio/index.html#' + hash
  );
  assert.strictEqual(
    buildWorkspaceLink('file:///C:/Projecten/musicpromptbuilder/index.html', hash),
    'file:///C:/Projecten/musicpromptbuilder/index.html#' + hash
  );
  // A share-target query must never travel: it would re-import the same text
  // into the recipient's song flow on every open.
  assert.strictEqual(buildWorkspaceLink('https://e.com/i.html?lyrics=a&title=b', hash).indexOf('?'), -1);
  // Half a link is worse than none.
  for (const junk of [null, undefined, 42, 'index.html', '']) {
    assert.strictEqual(buildWorkspaceLink(junk, hash), null, `${JSON.stringify(junk)} produced a link`);
  }
  assert.strictEqual(buildWorkspaceLink('https://e.com/i.html', ''), null);
});

s.test('a real workspace link is well under the size a browser will carry', () => {
  const snapshot = serializeWorkspace(populate(makeRegistry()), { savedAt: 1700000000000 });
  const link = buildWorkspaceLink('https://example.com/sunoprompt/index.html', encodeWorkspaceHash(snapshot));
  assert.ok(link.length < WORKSPACE_LINK_WARN_CHARS, `a populated workspace made a ${link.length}-char link`);
  assert.strictEqual(WORKSPACE_LINK_WARN_CHARS, 8000, 'the documented practical URL floor');
  assert.ok(WORKSPACE_LINK_WARN_CHARS < WORKSPACE_HASH_MAX_CHARS, 'the warning must fire long before the refusal');
});

/* ========================================================================== */
/* F. THE PRECEDENCE MATRIX                                                    */
/* ========================================================================== */

/**
 * The boot chain, composed out of the SAME functions the boot composes and in
 * the same order — restore, then the workspace hash, then the shared lyrics.
 * The source assertions below prove index.html really does compose them this
 * way; this harness proves what that composition MEANS.
 */
function runBootChain(options) {
  const o = options || {};
  const registry = makeRegistry();
  const applied = { autosave: false, link: false, share: false, linkRefused: null };

  if (o.autosave) {
    applied.autosave = restoreWorkspace(o.autosave, registry).ok;
  }
  if (o.hash && isWorkspaceHash(o.hash)) {
    const verdict = decodeWorkspaceHash(o.hash);
    if (verdict.ok) applied.link = restoreWorkspace(verdict.snapshot, registry).ok;
    else applied.linkRefused = verdict.reason;
  }
  if (o.search) {
    const share = parseSharedLyrics(o.search);
    if (share.present && share.lyrics) {
      const list = registry.structure.blocks();
      const targetId = list.length ? list[0].id : registry.structure.addBlock('Verse');
      registry.structure.setLyrics(targetId, share.lyrics);
      applied.share = true;
    }
  }
  return { registry, applied };
}

s.test('PRECEDENCE: autosave < workspace hash < ?lyrics=', () => {
  // Two distinguishable workspaces.
  const autosaveRegistry = makeRegistry();
  autosaveRegistry.promptState.add({ section: 'genre', tag: 'autosaved genre', source: 'manual' });
  autosaveRegistry.structure.setLyrics(autosaveRegistry.structure.addBlock('[Verse]'), 'the saved draft');
  const autosave = serializeWorkspace(autosaveRegistry, { savedAt: 1 });

  const linkRegistry = makeRegistry();
  linkRegistry.promptState.add({ section: 'genre', tag: 'shared genre', source: 'manual' });
  linkRegistry.structure.setLyrics(linkRegistry.structure.addBlock('[Verse]'), 'the shared draft');
  const hash = encodeWorkspaceHash(serializeWorkspace(linkRegistry, { savedAt: 2 }));

  const search = '?lyrics=' + encodeURIComponent('the shared-in lyric');

  // 1. autosave alone
  let run = runBootChain({ autosave });
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['autosaved genre']);
  assert.strictEqual(run.registry.structure.blocks()[0].lyrics, 'the saved draft');

  // 2. autosave + hash -> the hash wins outright
  run = runBootChain({ autosave, hash });
  assert.strictEqual(run.applied.link, true);
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['shared genre']);
  assert.strictEqual(run.registry.structure.blocks()[0].lyrics, 'the shared draft');

  // 3. autosave + hash + share -> the workspace from the hash, the lyric on top
  run = runBootChain({ autosave, hash, search });
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['shared genre']);
  assert.strictEqual(run.registry.structure.blocks()[0].lyrics, 'the shared-in lyric');
  assert.strictEqual(run.registry.structure.blocks().length, 1, 'the share writes a block, never a flow');

  // 4. autosave + share -> the saved workspace, with the lyric over its block
  run = runBootChain({ autosave, search });
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['autosaved genre']);
  assert.strictEqual(run.registry.structure.blocks()[0].lyrics, 'the shared-in lyric');

  // 5. a REFUSED hash leaves the restored autosave exactly where it was
  const broken = hash.replace(/\.[0-9a-f]{8}\./, '.deadbeef.');
  run = runBootChain({ autosave, hash: broken });
  assert.strictEqual(run.applied.link, false);
  assert.ok(run.applied.linkRefused, 'a refusal must be reportable');
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['autosaved genre']);
  assert.strictEqual(run.registry.structure.blocks()[0].lyrics, 'the saved draft');

  // 6. a foreign fragment is not even looked at
  run = runBootChain({ autosave, hash: '#style-heading' });
  assert.strictEqual(run.applied.link, false);
  assert.strictEqual(run.applied.linkRefused, null, 'a jump-nav anchor must not be reported as a bad link');
  deepEqual(run.registry.promptState.list().map((e) => e.tag), ['autosaved genre']);
});

s.test('the boot really composes them in that order — one chain, both settle paths', () => {
  const source = app.source;

  assert.ok(/const sessionRestore = idb\.ready\(\)/.test(source), 'the restore must be a named promise');
  assert.ok(
    /ignoreRejection\(sessionRestore\.then\(applyBootIntents, applyBootIntents\)\);/.test(source),
    'both settle paths must run the same chain, or a database that will not open swallows the link'
  );

  const chain = /function applyBootIntents\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(chain, 'applyBootIntents not found');
  const linkAt = chain[1].indexOf('applyWorkspaceLink();');
  const shareAt = chain[1].indexOf('applySharedIntent();');
  assert.ok(linkAt !== -1 && shareAt !== -1, 'both intents must be applied');
  assert.ok(linkAt < shareAt, 'the shared lyric lands ON TOP of the workspace, not under it');

  // READ synchronously at boot, before anything can edit the URL — and read
  // before it is applied, in source order as well as in time.
  assert.ok(
    /const workspaceLink = readWorkspaceLink\(\);/.test(source),
    'the fragment must be captured synchronously at boot'
  );
  assert.ok(
    source.indexOf('const workspaceLink = readWorkspaceLink();') <
      source.indexOf('ignoreRejection(sessionRestore.then('),
    'the read must precede the apply'
  );
  // The claim check is what keeps the jump-nav anchors safe.
  const reader = /function readWorkspaceLink\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(reader, 'readWorkspaceLink not found');
  assert.ok(
    /if \(!isWorkspaceHash\(hash\)\) return null;/.test(reader[1]),
    'a fragment that is not ours must be abandoned before it is decoded'
  );
  assert.ok(/window\.location\.hash/.test(reader[1]), 'the fragment must come from location.hash');
});

s.test('a consumed hash comes off the address bar — on every path, applied or refused', () => {
  const source = app.source;
  const apply = /function applyWorkspaceLink\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(apply, 'applyWorkspaceLink not found');

  // Three exits: the decode refused, the restore refused, and success. All
  // three consume, or a reload re-applies the link over the user's later work.
  const returns = (apply[1].match(/\n\s+return;/g) || []).length;
  const clears = (apply[1].match(/clearWorkspaceHash\(\);/g) || []).length;
  assert.strictEqual(returns, 2, 'the two refusal paths must both exit');
  assert.strictEqual(clears, 3, 'every path — both refusals and the success — must consume the hash');
  assert.ok(
    /restoreWorkspace\(workspaceLink\.snapshot, workspaceRegistry\)/.test(apply[1]),
    'the link must be applied through the same restore every other snapshot uses'
  );
  assert.ok(/renderStructure\(\);/.test(apply[1]), 'without an explicit repaint the song flow shows stale text');

  const clear = /function clearWorkspaceHash\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(clear, 'clearWorkspaceHash not found');
  assert.ok(
    /window\.history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.search\)/.test(
      clear[1]
    ),
    'the fragment must be replaced out of the address bar, keeping the query for clearShareParams'
  );
  assert.ok(/try \{/.test(clear[1]), 'replaceState is refused on some file:// origins and must be guarded');

  // The two tidy-ups compose: each reads the LIVE location, so neither can put
  // the other's part back.
  assert.ok(
    /window\.history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.hash\)/.test(
      source
    ),
    'clearShareParams must still keep the (by then empty) fragment'
  );
});

/* ========================================================================== */
/* G. THE UI CONTRACTS                                                        */
/* ========================================================================== */

s.test('the model picker and the Share link button live in the Style prompt card', () => {
  const editor = readEditorMarkup();
  const card = editor.slice(editor.indexOf('class="view-col vibe-card style-panel"'));
  const end = card.indexOf('</section>');
  const panel = card.slice(0, end === -1 ? card.length : end);

  for (const id of ['style-model', 'style-model-note', 'btn-style-share']) {
    assert.ok(panel.indexOf(`id="${id}"`) !== -1, `#${id} must live inside the Style prompt card`);
  }
  // The picker is a labelled control, not a bare select.
  assert.ok(/<label class="field-label" for="style-model">Suno model<\/label>/.test(panel));
  assert.ok(/<select id="style-model" class="field-select style-model-select"><\/select>/.test(panel));
  // It sits in the card HEADER, beside the heading.
  assert.ok(
    /<div class="style-head">\s*<h4 id="style-heading" class="panel-heading">Style prompt<\/h4>/.test(panel),
    'the picker belongs in the header row with the heading'
  );
  assert.ok(
    panel.indexOf('id="style-model"') < panel.indexOf('id="style-count"'),
    'the model is chosen above the gauge it moves'
  );
  // Its options are NOT in the markup: the registry is the single source.
  assert.ok(!/<option/.test(panel), 'the model options must be built from SUNO_MODELS, not written twice');
  // The note is a live region: switching model changes what it says.
  assert.ok(/id="style-model-note"[^>]*role="status"/.test(panel));
  assert.ok(/id="style-model-note"[^>]*aria-live="polite"/.test(panel));

  // The two footer buttons share a row and both survive the narrow breakpoint.
  assert.ok(/<span class="draft-foot-actions">/.test(panel));
  assert.ok(
    panel.indexOf('id="btn-style-share"') < panel.indexOf('id="btn-style-copy"'),
    'sharing the workspace reads left of copying the string'
  );
});

s.test('the omission notes exist where the omitted things are', () => {
  const editor = readEditorMarkup();
  assert.ok(
    /id="exclude-model-note" class="style-trimmed" role="status" aria-live="polite" hidden/.test(editor),
    'the shield card must carry a hidden, amber, live note about an omitted block'
  );
  assert.ok(
    /id="structure-model-note" class="structure-refrain-note" role="status"/.test(editor),
    'the structure card must carry a note about a capped bracket'
  );
  // Both ship hidden: they are conditions, not decoration.
  assert.ok(/id="exclude-model-note"[^>]*hidden/.test(editor));
  assert.ok(/id="structure-model-note"[^>]*hidden/.test(editor));
  // The shield note sits with the chips it describes.
  assert.ok(editor.indexOf('id="exclude-chips"') < editor.indexOf('id="exclude-model-note"'));
});

s.test('there is exactly ONE reader of the active model, and every compile goes through it', () => {
  const html = readIndex();
  const source = app.source;

  // One reader.
  assert.strictEqual(
    (source.match(/themePrefs\.getModelId\(\)/g) || []).length,
    2,
    'activeModel() and activeModelOptions() are the only two readers of the stored choice'
  );
  assert.ok(/function activeModelOptions\(\) \{\s*return sunoModelOptions\(themePrefs\.getModelId\(\)\);/.test(source));

  // Every live compile call site takes the options.
  const styleCalls = html.match(/buildFinalPrompt\(promptState, exclusions\.list\(\)[^)]*\)\)?/g) || [];
  assert.ok(styleCalls.length >= 2, 'the render and the copy must both compile');
  for (const call of styleCalls) {
    assert.ok(
      /activeModelOptions\(\)/.test(call),
      `a live compile forgot the model options: ${call}`
    );
  }
  // The structure sheet is model-scoped in both the preview and the copy.
  const sheetCalls = source.match(/structure\.compile\([^)]*\)/g) || [];
  assert.ok(sheetCalls.length >= 2, 'the preview and the copy must both compile the sheet');
  for (const call of sheetCalls) {
    assert.ok(
      /modelOptions|activeModelOptions\(\)/.test(call),
      `the structure sheet was compiled without a model: ${call}`
    );
  }
  // The picker's change handler persists AND repaints — a choice that only
  // painted would be lost on reload, and one that only stored would not show.
  assert.ok(/themePrefs\.setModelId\(modelSelect\.value\)/.test(source));
  assert.ok(/function renderModelState\(\)/.test(source));
  assert.ok(/renderStylePrompt\(\);[\s\S]{0,400}refreshStructure\(\);/.test(source));
});

s.test('the share button compiles a snapshot, not a prompt, and warns rather than blocks', () => {
  const source = app.source;
  const handler = /styleShareBtn\.addEventListener\('click', function \(\) \{([\s\S]*?)\n    \}\);/.exec(source);
  assert.ok(handler, 'the share button has no handler');

  assert.ok(
    /const snapshot = serializeWorkspace\(workspaceRegistry\);/.test(handler[1]),
    'the link must carry the workspace, through the same serializer everything else uses'
  );
  assert.ok(/encodeWorkspaceHash\(snapshot\)/.test(handler[1]));
  assert.ok(/buildWorkspaceLink\(/.test(handler[1]));
  // The existing clipboard helpers, not a third path.
  assert.ok(/copyViaClipboard\(link\)/.test(handler[1]));
  assert.ok(/copyViaExecCommand\(link\)/.test(handler[1]));
  // A long link WARNS. It is never refused: the checksum catches a truncated
  // paste at the other end, so the risk is a broken link and not a wrong load.
  const done = /const done = function \(\) \{([\s\S]*?)\n      \};/.exec(handler[1]);
  assert.ok(done, 'the share button has no success path');
  assert.ok(/link\.length > WORKSPACE_LINK_WARN_CHARS/.test(done[1]), 'the size must be checked on copy');
  assert.ok(/'warn'/.test(done[1]), 'the size warning must be a warning tone');
  assert.ok(
    /Share link copied/.test(done[1]),
    'the copy is reported the same way whatever the size — the warning is an extra sentence'
  );
  assert.ok(
    !/\breturn\b/.test(done[1]),
    'the success path must not bail out early: a long link is copied, then warned about'
  );
  // The one thing that IS refused is a page with no address to build from —
  // half a link would be worse than none.
  assert.ok(/if \(!link\) \{/.test(handler[1]));
});

s.test('the new CSS is token-only, and the picker is compact by declaration', () => {
  const css = readStyle();
  for (const selector of ['.style-head {', '.style-model-note {', '.style-model-select {', '.draft-foot-actions {']) {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `the stylesheet is missing a rule for ${selector}`);
    const body = css.slice(start, css.indexOf('}', start));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(body),
      `${selector} hard-codes a colour, which no theme or Code Mode can reach:\n${body}`
    );
  }
  // Compact: the picker is smaller than the body select it inherits from.
  const picker = css.slice(css.indexOf('.style-model-select {'));
  assert.ok(/font-size:\s*0\.78rem/.test(picker.slice(0, picker.indexOf('}'))));
  // The narrow breakpoint stacks the header and the two buttons.
  const narrow = css.slice(css.indexOf('@container dissector (max-width: 520px)'));
  const block = narrow.slice(0, narrow.indexOf('\n  }'));
  assert.ok(/\.style-head \{[^}]*align-items:\s*stretch/.test(block), 'the header must stack when narrow');
  assert.ok(/\.style-model-field \{[^}]*width:\s*100%/.test(block));
  assert.ok(/\.draft-foot-actions \{[^}]*flex-direction:\s*column/.test(block));
});

s.test('the model note is written FROM the registry, so a judgement call cannot read as a fact', () => {
  const source = app.source;
  const fn = /function modelNoteText\(entry\) \{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(fn, 'modelNoteText not found');
  assert.ok(/entry\.summary/.test(fn[1]), 'the note must use the entry’s own summary');
  assert.ok(/entry\.basis\[knob\] === 'conservative'/.test(fn[1]), 'the note must single out the judgement calls');
  assert.ok(
    /Nothing available here documents/.test(fn[1]),
    'the note must say plainly that the older syntax is undocumented'
  );
  assert.ok(/SUNO_MODEL_KNOB_LABELS\[knob\]/.test(fn[1]), 'the knobs must be named from the registry table');
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
