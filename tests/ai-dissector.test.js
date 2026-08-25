'use strict';
/*
 * tests/ai-dissector.test.js — behavioural tests for the Tri-Mode AI Acoustic
 * Dissector that lives in <script id="app-main"> inside index.html
 * (docs/FDD.md §3 + Domains E/F, docs/FEATURE-MECHANICS.md §7).
 *
 * WHAT IS COVERED
 *   - Mode 1, the embedded MUSIC_KB taxonomy engine: real phrase matching,
 *     weighted merge, blended tempo, determinism, and honest emptiness.
 *   - The pure prompt builders, including the verbatim §7.5 batch sentence.
 *   - parseDissectorReply's tolerance (fences, prose, trailing commas, plural
 *     aliases) and its strictness (clamping, and null for garbage).
 *   - The §7.3 fallback waterfall against INJECTED fetch fakes: 429, timeout,
 *     network failure, pinned-mode errors, request shapes for every preset.
 *   - Secret hygiene: an API key must never reach any storage API.
 *   - That nothing anywhere leaves an unhandled promise rejection (§2.3).
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Any LIVE call to a real cloud provider or a real Ollama server. That
 *     needs a secret and a network; the offline-first, zero-dependency test
 *     policy forbids both. Every network path here runs against a fake `fetchFn`
 *     supplied through dependency injection, which is exactly why the engine
 *     takes one: production hands it the real `fetch`, this suite hands it a
 *     recorder. No request logic is simulated inside index.html.
 *   - DOM rendering of the dissector panel (badges, meter). That needs a
 *     browser; the boot IIFE is verified to stay inert outside one.
 *
 * The #app-main source is evaluated in a node:vm context with NO `document`,
 * `window`, `navigator`, `Worker` or `Blob`, which proves the boot IIFE stays
 * guarded and that every factory under test is a reachable top-level
 * declaration. A RECORDING `localStorage`/`sessionStorage` pair IS installed —
 * not because the app needs one, but so the secret-hygiene test can prove that
 * nothing was ever written to it.
 *
 * Node built-ins only: path, assert, vm.
 */

const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* -------------------------------------------------------------------------- */
/* Unhandled-rejection guard — armed before anything else runs                */
/* -------------------------------------------------------------------------- */

/** @type {Array<{reason: string}>} */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push({ reason: (reason && reason.stack) || String(reason) });
});
process.on('rejectionHandled', () => {
  // A rejection handled late is still a rejection that was unhandled for a
  // tick; record nothing extra, but do not silently clear the list either.
});

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/** A localStorage/sessionStorage stand-in that records every mutation. */
function makeRecordingStorage(label) {
  const writes = [];
  const removals = [];
  const store = new Map();
  return {
    writes,
    removals,
    label,
    api: {
      getItem(key) {
        return store.has(String(key)) ? store.get(String(key)) : null;
      },
      setItem(key, value) {
        writes.push({ key: String(key), value: String(value) });
        store.set(String(key), String(value));
      },
      removeItem(key) {
        removals.push(String(key));
        store.delete(String(key));
      },
      clear() {
        store.clear();
      },
      get length() {
        return store.size;
      },
    },
  };
}

/**
 * Evaluate #app-main in a DOM-free vm context. The absence of `document` is
 * the point: the boot IIFE must bail out and touch nothing.
 */
function loadAppSandbox() {
  const source = extractScriptById(INDEX, 'app-main');
  const local = makeRecordingStorage('localStorage');
  const session = makeRecordingStorage('sessionStorage');

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Promise,
    // Present because createCloudArming.restoreSlot() compares a remembered
    // slot's ORIGIN against the preset's full endpoint. Still no `document`,
    // `window`, `navigator` or `Blob`: the boot IIFE stays inert.
    URL,
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
    localStorage: local.api,
    sessionStorage: session.api,
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'index.html#app-main' });

  return {
    sandbox,
    source,
    storage: { local, session },
    evaluate(expression) {
      return vm.runInContext(expression, sandbox, { filename: 'app-main#evaluate' });
    },
  };
}

const app = loadAppSandbox();
const {
  dissectLocal,
  buildDissectorPrompt,
  buildBatchDissectionPrompt,
  parseDissectorReply,
  createDissector,
  createCloudArming,
  createVaultRestore,
  createToastHost,
  MUSIC_KB,
  CLOUD_API_PRESETS,
  DISSECTOR_MODES,
  BATCH_TRACK_LIMIT,
  OLLAMA_ENDPOINT,
  OLLAMA_DEFAULT_MODEL,
  DISSECTOR_FALLBACK_TOAST,
  LOCAL_MAX_TOKENS,
  LOCAL_MAX_LIST,
} = app.sandbox;

/* -------------------------------------------------------------------------- */
/* Fakes (test-only; never present in production code paths)                  */
/* -------------------------------------------------------------------------- */

/**
 * A fetch recorder. `plan` decides what each call answers:
 *   {status, json}   -> resolves a Response-alike
 *   {reject: Error}  -> the fetch itself rejects (network / CORS / offline)
 *   {hang: true}     -> never settles, so the engine's deadline must fire
 * @param {object|Function} plan
 */
function makeFetchFake(plan) {
  const calls = [];
  const fn = function (url, options) {
    const decision = typeof plan === 'function' ? plan(url, options, calls.length) : plan;
    calls.push({
      url: url,
      method: options && options.method,
      headers: (options && options.headers) || {},
      rawBody: options && options.body,
      body: options && options.body ? JSON.parse(options.body) : null,
      hasSignal: !!(options && options.signal),
    });
    if (decision.hang) return new Promise(function () {});
    if (decision.reject) return Promise.reject(decision.reject);
    return Promise.resolve(makeResponse(decision.status, decision.json, decision.badBody));
  };
  fn.calls = calls;
  return fn;
}

/** A minimal Response-alike: only `status` and `json()` are consumed. */
function makeResponse(status, json, badBody) {
  return {
    status: typeof status === 'number' ? status : 200,
    ok: (status || 200) < 400,
    json: function () {
      if (badBody) return Promise.reject(new SyntaxError('Unexpected token < in JSON'));
      return Promise.resolve(json === undefined ? {} : json);
    },
  };
}

/** An OpenAI-style chat completion carrying `text` as the model's answer. */
function openAiReply(text) {
  return { choices: [{ index: 0, message: { role: 'assistant', content: text } }] };
}

/** A Gemini-style reply carrying `text`. */
function geminiReply(text) {
  return { candidates: [{ content: { role: 'model', parts: [{ text: text }] } }] };
}

/** The result schema, for provider fakes that must return one. */
const GOOD_RESULT = {
  genre_tokens: [{ tag: 'techno', weight: 0.9 }],
  bpm_range: [130, 140],
  instruments: ['tr-909 kick'],
  mood: ['dark'],
  era: ['1990s'],
  confidence: 0.8,
  source: 'local',
};

/** A well-formed dissector answer, as a model would emit it. */
const GOOD_REPLY_JSON =
  '{"genre_tokens":[{"tag":"techno","weight":0.9},{"tag":"hypnotic loop","weight":0.7}],' +
  '"bpm_range":[130,140],"instruments":["tr-909 kick"],"mood":["dark"],"era":["1990s"],"confidence":0.8}';

/** Records toast calls made by the engine. */
function makeToastSpy() {
  const shown = [];
  const fn = function (message, kind) {
    shown.push({ message: message, kind: kind });
  };
  fn.shown = shown;
  return fn;
}

/**
 * A cloud config that is complete enough to actually be attempted.
 * CONSCIOUSLY MOVED off Groq in 0.17.0: Groq's preset was a byte-identical
 * copy of the generic OpenAI-compatible adapter and folded into it as a
 * base-URL suggestion, so this fixture now exercises the generic path with the
 * same host it always used.
 */
function cloudConfig(overrides) {
  const base = {
    preset: 'custom',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    key: 'sk-test-key',
    model: 'llama-3.1-8b-instant',
  };
  if (!overrides) return base;
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  for (const k of Object.keys(overrides)) out[k] = overrides[k];
  return out;
}

/** The smallest document stub createToastHost can mount into. */
function makeFakeDocument() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      attributes: {},
      childNodes: [],
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      appendChild(child) {
        child.parentNode = this;
        this.childNodes.push(child);
        this.firstChild = this.childNodes[0];
        return child;
      },
      removeChild(child) {
        const at = this.childNodes.indexOf(child);
        if (at === -1) throw new Error('removeChild: not a child');
        this.childNodes.splice(at, 1);
        child.parentNode = null;
        this.firstChild = this.childNodes[0];
        return child;
      },
    };
  }
  const body = makeEl('body');
  return {
    body: body,
    createElement: makeEl,
  };
}

/**
 * Copy a value out of the vm realm.
 *
 * Objects and arrays built INSIDE the sandbox carry that context's own
 * %Object.prototype% / %Array.prototype%, so `assert.deepStrictEqual` against a
 * literal written out here fails on prototype identity even when every value
 * matches ("same structure but not reference-equal"). Round-tripping through
 * JSON rebuilds the value with this realm's intrinsics — and, as a bonus,
 * asserts in passing that the result is plain JSON-serialisable data.
 */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Every tag string in a result, for readable assertions. */
function tagsOf(result) {
  return host(result.genre_tokens).map((t) => t.tag);
}

/** Weight of one tag, or undefined. */
function weightOf(result, tag) {
  const hit = result.genre_tokens.find((t) => t.tag === tag);
  return hit ? hit.weight : undefined;
}

/** Let queued microtasks and one macrotask turn drain. */
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

const s = suite('ai-dissector (#app-main Tri-Mode acoustic dissector)');

/* --- surface & sandbox ---------------------------------------------------- */

s.test('#app-main evaluates with no DOM and the boot IIFE stays inert', () => {
  assert.strictEqual(app.evaluate('typeof document'), 'undefined');
  assert.strictEqual(app.evaluate('typeof window'), 'undefined');
  // Nothing may have run on load: the recording storage saw zero traffic.
  assert.deepStrictEqual(app.storage.local.writes, [], 'boot wrote to localStorage outside a browser');
});

s.test('every dissector factory is a reachable top-level function declaration', () => {
  for (const name of [
    'dissectLocal',
    'buildDissectorPrompt',
    'buildBatchDissectionPrompt',
    'parseDissectorReply',
    'createDissector',
    'createToastHost',
  ]) {
    assert.strictEqual(typeof app.sandbox[name], 'function', `${name} is not a top-level function`);
  }
});

s.test('dissector constants are `var` bindings, so tests can read them', () => {
  /*
   * CONSCIOUSLY EXTENDED IN 0.17.0. 'local-llm' is a NEW id, added in UI order
   * between auto and local; 'local' is unchanged and still means the embedded
   * taxonomy engine, which is what the fifteen-odd assertions naming it in
   * this file prove. 'webgpu' is deliberately still not a mode — the
   * unknown-mode test below uses it as its example of one.
   */
  assert.deepStrictEqual(host(DISSECTOR_MODES), ['auto', 'local-llm', 'local', 'cloud', 'ollama']);
  assert.strictEqual(BATCH_TRACK_LIMIT, 5);
  assert.strictEqual(OLLAMA_ENDPOINT, 'http://localhost:11434/api/generate');
  assert.strictEqual(OLLAMA_DEFAULT_MODEL, 'llama3.2');
  assert.strictEqual(DISSECTOR_FALLBACK_TOAST, 'Cloud API busy. Falling back to local offline model.');
  assert.ok(LOCAL_MAX_TOKENS > 0 && LOCAL_MAX_LIST > 0);
});

s.test('MUSIC_KB covers the FDD Domain F taxonomy', () => {
  const ids = MUSIC_KB.genres.map((g) => g.id);
  for (const required of [
    'techno',
    'french-electro',
    'scandinavian-house',
    'progressive-trance',
    'afro-house',
    'amapiano',
  ]) {
    assert.ok(ids.includes(required), `Domain F genre "${required}" missing from MUSIC_KB`);
  }
  assert.ok(MUSIC_KB.genres.length >= 26, `only ${MUSIC_KB.genres.length} genres`);
  assert.ok(MUSIC_KB.scenes.length >= 12, `only ${MUSIC_KB.scenes.length} scenes`);
  assert.ok(MUSIC_KB.eras.length >= 7, `only ${MUSIC_KB.eras.length} era triggers`);
  assert.ok(
    MUSIC_KB.scenes.some((sc) => sc.phrases.includes('neon rain')),
    'the "neon rain" scene mapping is missing'
  );
});

s.test('every MUSIC_KB phrase is pre-normalised and globally unique', () => {
  const seen = new Map();
  const shape = /^[a-z0-9]+( [a-z0-9]+)*$/;
  for (const group of ['genres', 'scenes', 'eras']) {
    for (const entry of MUSIC_KB[group]) {
      for (const phrase of entry.phrases) {
        assert.ok(shape.test(phrase), `phrase "${phrase}" in ${entry.id} is not normalised`);
        assert.ok(!seen.has(phrase), `phrase "${phrase}" is claimed by both ${seen.get(phrase)} and ${entry.id}`);
        seen.set(phrase, entry.id);
      }
    }
  }
  assert.ok(seen.size >= 150, `only ${seen.size} trigger phrases in the KB`);
});

s.test('every MUSIC_KB entry matches the shape the engine relies on', () => {
  const ids = new Set();
  for (const group of ['genres', 'scenes', 'eras']) {
    for (const entry of MUSIC_KB[group]) {
      assert.ok(!ids.has(entry.id), `duplicate entry id ${entry.id}`);
      ids.add(entry.id);
      assert.ok(entry.label && typeof entry.label === 'string', `${entry.id}: bad label`);
      assert.ok(Array.isArray(entry.tokens) && entry.tokens.length >= 2, `${entry.id}: too few tokens`);
      for (const token of entry.tokens) {
        assert.ok(typeof token.tag === 'string' && token.tag.trim(), `${entry.id}: empty tag`);
        assert.ok(token.weight > 0 && token.weight <= 1, `${entry.id}/${token.tag}: weight ${token.weight}`);
      }
      if (entry.bpm !== null) {
        assert.ok(Array.isArray(entry.bpm) && entry.bpm.length === 2, `${entry.id}: bad bpm`);
        assert.ok(entry.bpm[0] < entry.bpm[1], `${entry.id}: bpm not ascending`);
      }
      for (const list of ['instruments', 'moods', 'eras']) {
        assert.ok(Array.isArray(entry[list]), `${entry.id}: ${list} is not an array`);
      }
    }
  }
});

/* --- Mode 1: the embedded taxonomy engine --------------------------------- */

s.test('local: French electro text yields its DNA tokens with sane weights', () => {
  const r = dissectLocal('sounds like french electro, all distortion and pumping');
  const tags = tagsOf(r);
  assert.ok(tags.includes('french electro'), `tags: ${tags.join(', ')}`);
  assert.ok(tags.includes('distorted disco bass'), `tags: ${tags.join(', ')}`);
  assert.ok(tags.includes('sidechain pumping'), `tags: ${tags.join(', ')}`);
  for (const token of r.genre_tokens) {
    assert.ok(token.weight > 0 && token.weight <= 1, `weight out of band: ${token.tag}=${token.weight}`);
  }
  // The canonical genre token must outrank its supporting traits.
  assert.ok(weightOf(r, 'french electro') > weightOf(r, 'distorted disco bass'));
  assert.deepStrictEqual(host(r.bpm_range), [122, 130]);
  assert.strictEqual(r.source, 'local');
});

s.test('local: amapiano yields log drums and a real amapiano tempo band', () => {
  const r = dissectLocal('amapiano');
  assert.ok(tagsOf(r).includes('log drums'), `tags: ${tagsOf(r).join(', ')}`);
  assert.ok(tagsOf(r).includes('jazz chords'));
  assert.deepStrictEqual(host(r.bpm_range), [108, 115]);
  assert.ok(r.instruments.length > 0 && r.mood.length > 0);
});

s.test('local: the "neon rain" scene phrase contributes nocturnal texture', () => {
  const r = dissectLocal('a neon rain kind of night');
  assert.ok(tagsOf(r).includes('neon rain'), `tags: ${tagsOf(r).join(', ')}`);
  assert.ok(tagsOf(r).includes('rain ambience texture'));
  assert.ok(r.mood.includes('nocturnal'), `mood: ${r.mood.join(', ')}`);
  assert.ok(r.mood.includes('moody'));
  // A scene implies no tempo, and the engine must not invent one.
  assert.strictEqual(r.bpm_range, null);
});

s.test('local: a decade trigger contributes an era signature', () => {
  const r = dissectLocal('give it a 1980s sheen');
  assert.ok(tagsOf(r).includes('1980s production'), `tags: ${tagsOf(r).join(', ')}`);
  assert.ok(tagsOf(r).includes('gated reverb drums'));
  assert.ok(
    r.era.some((e) => e.indexOf('1980s') !== -1),
    `era: ${r.era.join(', ')}`
  );
  assert.strictEqual(r.bpm_range, null, 'a decade alone must not imply a tempo');
});

s.test('local: "90s" and "1990s" are the same trigger', () => {
  assert.deepStrictEqual(dissectLocal('90s rave'), dissectLocal('1990s rave'));
});

s.test('local: a multi-genre blend merges without duplicating a tag', () => {
  const r = dissectLocal('amapiano meets afro house');
  const tags = tagsOf(r);
  assert.strictEqual(new Set(tags).size, tags.length, `duplicate tag in: ${tags.join(', ')}`);
  assert.ok(tags.includes('amapiano') && tags.includes('afro house'), tags.join(', '));
  // Blended tempo must sit between amapiano (108-115) and afro house (118-124).
  assert.ok(r.bpm_range[0] > 108 && r.bpm_range[0] < 118, `blended lo: ${r.bpm_range[0]}`);
  assert.ok(r.bpm_range[1] > 115 && r.bpm_range[1] < 124, `blended hi: ${r.bpm_range[1]}`);
  // Two matches must read as more evidence than one.
  assert.ok(r.confidence > dissectLocal('amapiano').confidence);
});

s.test('local: a tag claimed by two entries is reinforced, not repeated', () => {
  // 'uplifting' is a mood of both afro house and scandinavian house.
  const one = dissectLocal('afro house');
  const both = dissectLocal('afro house and scandinavian house');
  assert.strictEqual(new Set(both.mood).size, both.mood.length, 'mood list has duplicates');
  assert.ok(both.mood.includes('uplifting'));
  assert.ok(both.genre_tokens.length > one.genre_tokens.length);
});

s.test('local: a longer phrase wins and consumes the shorter one inside it', () => {
  const r = dissectLocal('afro house all night');
  const tags = tagsOf(r);
  assert.ok(tags.includes('afro house'), tags.join(', '));
  // The standalone `house` entry must NOT also fire on the "house" inside it.
  assert.ok(!tags.includes('house'), `bare house entry leaked in: ${tags.join(', ')}`);
  assert.ok(!tags.includes('four on the floor kick'), tags.join(', '));
  assert.deepStrictEqual(host(r.bpm_range), [118, 124], 'tempo came from more than afro house alone');
});

s.test('local: the bare `house` entry still fires when nothing longer matches', () => {
  const tags = tagsOf(dissectLocal('classic house'));
  assert.ok(tags.includes('house'), tags.join(', '));
});

s.test('local: gibberish returns an empty result with confidence 0', () => {
  const r = dissectLocal('xyzzy plugh frobnicate qwertyuiop');
  assert.deepStrictEqual(host(r), {
    genre_tokens: [],
    bpm_range: null,
    instruments: [],
    mood: [],
    era: [],
    confidence: 0,
    source: 'local',
  });
});

s.test('local: empty, blank and non-string input return the same empty result', () => {
  const empty = dissectLocal('xyzzy plugh frobnicate qwertyuiop');
  assert.deepStrictEqual(dissectLocal(''), empty);
  assert.deepStrictEqual(dissectLocal('   \n\t '), empty);
  assert.deepStrictEqual(dissectLocal(null), empty);
  assert.deepStrictEqual(dissectLocal(undefined), empty);
  assert.deepStrictEqual(dissectLocal(42), empty);
  assert.deepStrictEqual(dissectLocal({ text: 'techno' }), empty);
});

s.test('local: the engine is deterministic across runs', () => {
  const text = 'progressive trance with ethereal vocal chops over a neon rain skyline, very 1990s';
  const first = JSON.stringify(dissectLocal(text));
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(JSON.stringify(dissectLocal(text)), first, `run ${i} diverged`);
  }
});

s.test('local: matching folds case and punctuation away', () => {
  const canonical = JSON.stringify(dissectLocal('french electro'));
  assert.strictEqual(JSON.stringify(dissectLocal('FRENCH-ELECTRO!!!')), canonical);
  assert.strictEqual(JSON.stringify(dissectLocal('  French   Electro  ')), canonical);
  assert.strictEqual(JSON.stringify(dissectLocal('...french/electro...')), canonical);
});

s.test('local: "drum & bass" and "drum\'n\'bass" reach the same entry', () => {
  for (const spelling of ['drum & bass', "drum'n'bass", 'DnB', 'drum and bass']) {
    const tags = tagsOf(dissectLocal(spelling));
    assert.ok(tags.includes('drum and bass'), `${spelling} -> ${tags.join(', ')}`);
  }
});

s.test('local: tokens are ordered by descending weight, ties broken alphabetically', () => {
  const r = dissectLocal('techno, progressive trance, amapiano, neon rain, 1980s, lo fi');
  for (let i = 1; i < r.genre_tokens.length; i += 1) {
    const prev = r.genre_tokens[i - 1];
    const cur = r.genre_tokens[i];
    assert.ok(prev.weight >= cur.weight, `unsorted at ${i}: ${prev.tag}=${prev.weight} then ${cur.tag}=${cur.weight}`);
    if (prev.weight === cur.weight) assert.ok(prev.tag < cur.tag, `tie not alphabetical: ${prev.tag} / ${cur.tag}`);
  }
});

s.test('local: output lists respect the clutter caps', () => {
  const r = dissectLocal(
    'techno house trance ambient synthwave amapiano afro house french electro progressive trance ' +
      'lo fi jazz classical dubstep disco funk soul metal neon rain 1980s 1990s'
  );
  assert.ok(r.genre_tokens.length <= LOCAL_MAX_TOKENS, `${r.genre_tokens.length} tokens`);
  for (const list of ['instruments', 'mood', 'era']) {
    assert.ok(r[list].length <= LOCAL_MAX_LIST, `${list} has ${r[list].length} entries`);
  }
  assert.ok(r.confidence <= 0.95, 'confidence must stay short of certainty');
});

s.test('local: a longer trigger phrase is stronger evidence than a shorter one', () => {
  // All three phrases belong to the SAME entry (progressive-trance), so the
  // only thing that can move the numbers is phrase specificity.
  const three = dissectLocal('rolling bassline trance'); // 3 words
  const two = dissectLocal('prog trance'); // 2 words
  assert.deepStrictEqual(tagsOf(three), tagsOf(two), 'the two phrases must reach the same entry');
  assert.ok(
    weightOf(three, 'progressive trance') > weightOf(two, 'progressive trance'),
    `3-word ${weightOf(three, 'progressive trance')} did not outweigh 2-word ${weightOf(two, 'progressive trance')}`
  );
  assert.ok(three.confidence > two.confidence, `${three.confidence} vs ${two.confidence}`);
  assert.strictEqual(weightOf(three, 'progressive trance'), 1, 'a fully specific phrase should score its token flat out');
});

s.test('local: confidence rises with evidence and never reaches 1', () => {
  const one = dissectLocal('techno').confidence;
  const two = dissectLocal('techno and amapiano').confidence;
  const many = dissectLocal('techno amapiano afro house neon rain 1980s progressive trance').confidence;
  assert.ok(one > 0 && one < two && two < many, `${one} / ${two} / ${many}`);
  assert.ok(many <= 0.95, `confidence ${many} exceeded the cap`);
});

/* --- prompt builders ------------------------------------------------------ */

s.test('buildDissectorPrompt embeds the text and names every schema field', () => {
  const prompt = buildDissectorPrompt('warm scandinavian house at sunset');
  assert.ok(prompt.indexOf('warm scandinavian house at sunset') !== -1, 'user text is missing');
  for (const field of ['genre_tokens', 'bpm_range', 'instruments', 'mood', 'era', 'confidence']) {
    assert.ok(prompt.indexOf(field) !== -1, `schema field "${field}" not mentioned`);
  }
  assert.ok(/ONE JSON object/i.test(prompt), 'the prompt does not demand a single JSON object');
  assert.ok(/never name a real artist/i.test(prompt), 'the copyright-safety instruction is missing (FDD.md #24)');
});

s.test('buildDissectorPrompt returns null for nothing to dissect', () => {
  assert.strictEqual(buildDissectorPrompt(''), null);
  assert.strictEqual(buildDissectorPrompt('   '), null);
  assert.strictEqual(buildDissectorPrompt(null), null);
  assert.strictEqual(buildDissectorPrompt(undefined), null);
  assert.strictEqual(buildDissectorPrompt(7), null);
});

s.test('buildBatchDissectionPrompt reproduces the §7.5 sentence verbatim for 5 tracks', () => {
  const prompt = buildBatchDissectionPrompt(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  const expected =
    'Identify the overlapping acoustic traits, median BPM, and primary genre that unites the following 5 ' +
    'tracks: 1. alpha; 2. bravo; 3. charlie; 4. delta; 5. echo. Return only the unifying traits in the JSON schema.';
  assert.strictEqual(prompt.split('\n')[0], expected);
  assert.strictEqual(prompt.indexOf(expected), 0);
});

s.test('buildBatchDissectionPrompt CLAMPS past 5 tracks rather than rejecting', () => {
  // Documented policy: a pasted 30-track playlist should still dissect, so the
  // builder truncates to the §7.5 ceiling instead of erroring.
  const prompt = buildBatchDissectionPrompt(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.ok(prompt !== null, 'an over-long list must not be rejected');
  assert.ok(prompt.indexOf('following 5 tracks') !== -1, prompt.split('\n')[0]);
  assert.ok(prompt.indexOf('5. e.') !== -1, 'the fifth track is missing');
  assert.ok(prompt.indexOf('6. f') === -1, 'a sixth track leaked past the clamp');
  assert.ok(prompt.indexOf('; g') === -1 && prompt.indexOf('; h') === -1);
});

s.test('buildBatchDissectionPrompt drops blank entries and renumbers what is left', () => {
  const prompt = buildBatchDissectionPrompt(['  ', 'one', '', '  two  ', null, 3, 'three']);
  assert.ok(prompt.indexOf('the following 3 tracks: 1. one; 2. two; 3. three.') !== -1, prompt.split('\n')[0]);
});

s.test('buildBatchDissectionPrompt returns null when there is no usable track', () => {
  assert.strictEqual(buildBatchDissectionPrompt([]), null);
  assert.strictEqual(buildBatchDissectionPrompt(['', '   ']), null);
  assert.strictEqual(buildBatchDissectionPrompt(null), null);
  assert.strictEqual(buildBatchDissectionPrompt(undefined), null);
  assert.strictEqual(buildBatchDissectionPrompt('a string is not a track list'), null);
  assert.strictEqual(buildBatchDissectionPrompt([null, 3, {}, []]), null, 'non-string entries are not tracks');
});

s.test('buildBatchDissectionPrompt carries the same JSON schema as the single-track prompt', () => {
  const batch = buildBatchDissectionPrompt(['a', 'b']);
  for (const field of ['genre_tokens', 'bpm_range', 'instruments', 'mood', 'era', 'confidence']) {
    assert.ok(batch.indexOf(field) !== -1, `schema field "${field}" missing from the batch prompt`);
  }
  assert.ok(/never name a real artist/i.test(batch));
});

/* --- parseDissectorReply -------------------------------------------------- */

s.test('parseDissectorReply: a clean JSON object normalises into the schema', () => {
  const r = parseDissectorReply(GOOD_REPLY_JSON);
  assert.deepStrictEqual(host(r), {
    genre_tokens: [
      { tag: 'techno', weight: 0.9 },
      { tag: 'hypnotic loop', weight: 0.7 },
    ],
    bpm_range: [130, 140],
    instruments: ['tr-909 kick'],
    mood: ['dark'],
    era: ['1990s'],
    confidence: 0.8,
    source: null,
  });
});

s.test('parseDissectorReply: fenced JSON parses', () => {
  const r = parseDissectorReply('```json\n' + GOOD_REPLY_JSON + '\n```');
  assert.ok(r, 'fenced JSON was rejected');
  assert.deepStrictEqual(tagsOf(r), ['techno', 'hypnotic loop']);
  assert.ok(parseDissectorReply('```\n' + GOOD_REPLY_JSON + '\n```'), 'unlabelled fence was rejected');
});

s.test('parseDissectorReply: prose-wrapped JSON parses', () => {
  const r = parseDissectorReply('Sure! Here is the dissection:\n' + GOOD_REPLY_JSON + '\nHope that helps.');
  assert.ok(r, 'prose-wrapped JSON was rejected');
  assert.strictEqual(r.bpm_range[0], 130);
});

s.test('parseDissectorReply: garbage returns null instead of an invented skeleton', () => {
  assert.strictEqual(parseDissectorReply("I'm sorry, I can't help with that."), null);
  assert.strictEqual(parseDissectorReply(''), null);
  assert.strictEqual(parseDissectorReply('   '), null);
  assert.strictEqual(parseDissectorReply(null), null);
  assert.strictEqual(parseDissectorReply(undefined), null);
  assert.strictEqual(parseDissectorReply(42), null);
  assert.strictEqual(parseDissectorReply({ genre_tokens: [] }), null, 'objects are not raw replies');
  assert.strictEqual(parseDissectorReply('{}'), null, 'an empty object carries no information');
  assert.strictEqual(parseDissectorReply('{"unrelated": true}'), null);
  assert.strictEqual(parseDissectorReply('{"genre_tokens": "not an array"'), null, 'unbalanced JSON');
});

s.test('parseDissectorReply: out-of-range weights are clamped to 0..1', () => {
  const r = parseDissectorReply(
    '{"genre_tokens":[{"tag":"techno","weight":2},{"tag":"house","weight":-3},' +
      '{"tag":"trance","weight":"loud"},{"tag":"disco"}]}'
  );
  assert.strictEqual(weightOf(r, 'techno'), 1);
  assert.strictEqual(weightOf(r, 'house'), 0);
  // A non-numeric or absent weight means "stated but unranked" -> 1.
  assert.strictEqual(weightOf(r, 'trance'), 1);
  assert.strictEqual(weightOf(r, 'disco'), 1);
});

s.test('parseDissectorReply: a 0-100 confidence folds back to 0..1', () => {
  assert.strictEqual(parseDissectorReply('{"mood":["dark"],"confidence":85}').confidence, 0.85);
  assert.strictEqual(parseDissectorReply('{"mood":["dark"],"confidence":0.85}').confidence, 0.85);
  assert.strictEqual(parseDissectorReply('{"mood":["dark"],"confidence":-4}').confidence, 0);
  assert.strictEqual(parseDissectorReply('{"mood":["dark"],"confidence":900}').confidence, 1);
  assert.strictEqual(parseDissectorReply('{"mood":["dark"]}').confidence, 0, 'an absent confidence must not be invented');
});

s.test('parseDissectorReply: bpm_range is normalised or dropped, never guessed', () => {
  assert.deepStrictEqual(host(parseDissectorReply('{"bpm_range":[140,120]}').bpm_range), [120, 140], 'not reordered');
  assert.deepStrictEqual(host(parseDissectorReply('{"bpm_range":[122.4,129.6]}').bpm_range), [122, 130]);
  assert.strictEqual(parseDissectorReply('{"bpm_range":"fast","mood":["dark"]}').bpm_range, null);
  assert.strictEqual(parseDissectorReply('{"bpm_range":[0,0],"mood":["dark"]}').bpm_range, null);
  assert.strictEqual(parseDissectorReply('{"mood":["dark"]}').bpm_range, null);
});

s.test('parseDissectorReply: plural aliases, bare strings and duplicates are handled', () => {
  const r = parseDissectorReply(
    '{"genre_tokens":["techno","techno",{"tag":"techno","weight":0.2}],' +
      '"instruments":["kick"," kick ","hats"],"moods":["dark"],"eras":["1990s"]}'
  );
  assert.deepStrictEqual(tagsOf(r), ['techno'], 'duplicate tags were not collapsed');
  assert.deepStrictEqual(host(r.instruments), ['kick', 'hats'], 'trimmed duplicates were not collapsed');
  assert.deepStrictEqual(host(r.mood), ['dark'], '"moods" alias not accepted');
  assert.deepStrictEqual(host(r.era), ['1990s'], '"eras" alias not accepted');
});

s.test('parseDissectorReply: trailing commas and braces inside strings survive', () => {
  assert.ok(parseDissectorReply('{"mood":["dark"],}'), 'trailing comma rejected');
  const r = parseDissectorReply('{"genre_tokens":[{"tag":"drum { and } bass","weight":0.5}]}');
  assert.deepStrictEqual(tagsOf(r), ['drum { and } bass'], 'a brace inside a string truncated the scan');
});

s.test('parseDissectorReply: `source` is left null for the caller to stamp', () => {
  assert.strictEqual(parseDissectorReply(GOOD_REPLY_JSON).source, null);
  assert.strictEqual(parseDissectorReply('{"source":"cloud","mood":["dark"]}').source, null);
});

/* --- the §7.3 fallback chain --------------------------------------------- */

s.test('chain: HTTP 429 falls back to local, flags fellBack and toasts once', async () => {
  const fetchFn = makeFetchFake({ status: 429, json: { error: 'rate limit' } });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'french electro', mode: 'auto', cloud: cloudConfig() });

  assert.strictEqual(out.ok, true, `error: ${out.error}`);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true);
  assert.strictEqual(out.result.source, 'local');
  assert.ok(out.result.genre_tokens.length > 0, 'the local engine produced nothing');
  assert.strictEqual(fetchFn.calls.length, 1, 'the cloud was not attempted exactly once');
  assert.deepStrictEqual(
    toast.shown.map((t) => t.message),
    [DISSECTOR_FALLBACK_TOAST]
  );
});

s.test('chain: a request that never settles times out and falls back', async () => {
  const fetchFn = makeFetchFake({ hang: true });
  const toast = makeToastSpy();
  const started = Date.now();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 25 });

  const out = await d.dissect({ text: 'amapiano', mode: 'auto', cloud: cloudConfig() });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true);
  assert.ok(Date.now() - started >= 20, 'the deadline did not actually elapse');
  assert.strictEqual(toast.shown.length, 1);
});

s.test('chain: a network-layer failure also falls back (documented extension of §7.3)', async () => {
  // §7.3 names only rate-limit and timeout. A rejected fetch — offline, DNS,
  // CORS, blocked file:// origin — is added deliberately: Auto mode exists so
  // the user always gets an answer, and an offline machine is the single most
  // likely reason a request fails (FDD.md #85, offline-first).
  const fetchFn = makeFetchFake({ reject: new TypeError('Failed to fetch') });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'techno', mode: 'auto', cloud: cloudConfig() });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true);
  assert.strictEqual(toast.shown.length, 1);
});

s.test('chain: a pinned cloud mode reports HTTP 500 instead of masking it', async () => {
  const fetchFn = makeFetchFake({ status: 500, json: { error: 'boom' } });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig() });

  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.mode, 'cloud');
  assert.strictEqual(out.fellBack, false);
  assert.ok(/HTTP 500/.test(out.error), `error was: ${out.error}`);
  assert.strictEqual(toast.shown.length, 0, 'a non-fallback failure must not toast the fallback copy');
  assert.strictEqual(out.result, undefined);
});

s.test('chain: an unauthorised key is reported, not silently routed around', async () => {
  const fetchFn = makeFetchFake({ status: 401 });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'techno', mode: 'auto', cloud: cloudConfig({ key: 'wrong' }) });

  assert.strictEqual(out.ok, false, 'a fixable misconfiguration must surface');
  assert.ok(/HTTP 401/.test(out.error), out.error);
  assert.strictEqual(toast.shown.length, 0);
});

s.test('chain: an unusable model reply is reported, not fallen back from', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply('I cannot do that.') });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500, toast: makeToastSpy() });

  const out = await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig() });

  assert.strictEqual(out.ok, false);
  assert.ok(/not usable JSON/.test(out.error), out.error);
});

s.test('chain: a malformed response body is reported', async () => {
  const fetchFn = makeFetchFake({ status: 200, badBody: true });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  const out = await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig() });

  assert.strictEqual(out.ok, false);
  assert.ok(/unreadable response body/.test(out.error), out.error);
});

s.test('chain: a successful cloud call stamps source "cloud" and does not fall back', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply('```json\n' + GOOD_REPLY_JSON + '\n```') });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'berlin techno', mode: 'auto', cloud: cloudConfig() });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'cloud');
  assert.strictEqual(out.fellBack, false);
  assert.strictEqual(out.result.source, 'cloud');
  assert.deepStrictEqual(tagsOf(out.result), ['techno', 'hypnotic loop']);
  assert.strictEqual(toast.shown.length, 0);
});

s.test('chain: Auto with no cloud endpoint runs local silently — that is not a fallback', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: {} });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast });

  const out = await d.dissect({ text: 'amapiano', mode: 'auto', cloud: { preset: 'custom', endpoint: '', key: '' } });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, false, 'nothing was busy, so nothing fell back');
  assert.strictEqual(fetchFn.calls.length, 0, 'an unconfigured cloud must not be dialled');
  assert.strictEqual(toast.shown.length, 0);
});

s.test('chain: a pinned cloud mode with no endpoint says so', async () => {
  const d = createDissector({ fetchFn: makeFetchFake({ status: 200 }) });
  const out = await d.dissect({ text: 'techno', mode: 'cloud', cloud: { preset: 'custom', endpoint: '' } });
  assert.strictEqual(out.ok, false);
  assert.ok(/no cloud endpoint configured/.test(out.error), out.error);
  assert.strictEqual(out.fellBack, false);
});

s.test('chain: empty input resolves gracefully and never touches the network', async () => {
  const fetchFn = makeFetchFake({ status: 200 });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  for (const text of ['', '   \n ', undefined, null, 12]) {
    const out = await d.dissect({ text: text, mode: 'auto', cloud: cloudConfig() });
    assert.strictEqual(out.ok, false, `text ${JSON.stringify(text)} was accepted`);
    assert.strictEqual(out.fellBack, false);
    assert.ok(/Enter a description/.test(out.error), out.error);
  }
  assert.strictEqual(fetchFn.calls.length, 0);
  const noArgs = await d.dissect();
  assert.strictEqual(noArgs.ok, false, 'dissect() with no argument must still resolve');
});

s.test('chain: an unknown mode is refused by name without throwing', async () => {
  const d = createDissector({ fetchFn: makeFetchFake({ status: 200 }) });
  const out = await d.dissect({ text: 'techno', mode: 'webgpu' });
  assert.strictEqual(out.ok, false);
  assert.ok(/unknown mode "webgpu"/.test(out.error), out.error);
  assert.strictEqual(out.fellBack, false);
});

s.test('chain: mode strings are case-insensitive and default to auto', async () => {
  const d = createDissector({ fetchFn: makeFetchFake({ status: 200 }) });
  assert.strictEqual((await d.dissect({ text: 'techno', mode: 'LOCAL' })).mode, 'local');
  assert.strictEqual((await d.dissect({ text: 'techno' })).mode, 'local', 'no mode should mean auto -> local');
});

s.test('chain: batch input uses the §7.5 batch prompt for remote modes', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({
    text: 'a\nb\nc',
    tracks: ['a', 'b', 'c'],
    mode: 'cloud',
    cloud: cloudConfig(),
  });

  const sent = fetchFn.calls[0].body.messages[0].content;
  assert.ok(sent.indexOf('the following 3 tracks: 1. a; 2. b; 3. c.') !== -1, sent.split('\n')[0]);
});

/* --- provider request shapes --------------------------------------------- */

s.test('ollama: the request hits localhost:11434 with the §7.1 sampling contract', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: { response: GOOD_REPLY_JSON, done: true } });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  const out = await d.dissect({ text: 'berlin techno', mode: 'ollama', ollama: { model: 'qwen2.5:3b' } });

  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.mode, 'ollama');
  assert.strictEqual(out.result.source, 'ollama');

  const call = fetchFn.calls[0];
  assert.strictEqual(call.url, OLLAMA_ENDPOINT);
  assert.strictEqual(call.url, 'http://localhost:11434/api/generate');
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.headers['Content-Type'], 'application/json');
  assert.strictEqual(call.body.model, 'qwen2.5:3b');
  assert.strictEqual(call.body.stream, false);
  assert.strictEqual(typeof call.body.prompt, 'string');
  assert.ok(call.body.prompt.indexOf('berlin techno') !== -1);
  assert.deepStrictEqual(call.body.options, { temperature: 0.1, top_k: 10 });
  assert.deepStrictEqual(Object.keys(call.body).sort(), ['model', 'options', 'prompt', 'stream']);
});

s.test('ollama: the default model is used when the UI supplies none', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: { response: GOOD_REPLY_JSON } });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({ text: 'techno', mode: 'ollama' });
  assert.strictEqual(fetchFn.calls[0].body.model, OLLAMA_DEFAULT_MODEL);

  await d.dissect({ text: 'techno', mode: 'ollama', ollama: { model: '   ' } });
  assert.strictEqual(fetchFn.calls[1].body.model, OLLAMA_DEFAULT_MODEL);
});

s.test('ollama: a dead server reports a network error rather than falling back', async () => {
  const fetchFn = makeFetchFake({ reject: new TypeError('Failed to fetch') });
  const toast = makeToastSpy();
  const d = createDissector({ fetchFn: fetchFn, toast: toast, timeoutMs: 500 });

  const out = await d.dissect({ text: 'techno', mode: 'ollama' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.mode, 'ollama');
  assert.ok(/network error/.test(out.error), out.error);
  assert.strictEqual(toast.shown.length, 0, 'a pinned mode does not chain');
});

s.test('cloud: the OpenAI-compatible preset shapes the body and the Authorization header', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig() });

  const call = fetchFn.calls[0];
  assert.strictEqual(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.headers.Authorization, 'Bearer sk-test-key');
  assert.strictEqual(call.headers['Content-Type'], 'application/json');
  assert.strictEqual(call.body.model, 'llama-3.1-8b-instant');
  assert.strictEqual(call.body.temperature, 0.1);
  assert.strictEqual(call.body.top_k, 10);
  assert.strictEqual(call.body.stream, false);
  assert.strictEqual(call.body.messages[0].role, 'user');
  assert.ok(call.body.messages[0].content.indexOf('techno') !== -1);
});

s.test('cloud: a bare base URL is completed with the preset basePath, a full endpoint is not', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  // Both spellings are things people paste; guessing wrong is a 404 with no
  // visible cause, which is why the UI echoes the resolved URL too.
  const cases = [
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.groq.com/openai/v1/', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1/chat/completions'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig({ endpoint: cases[i][0] }) });
    assert.strictEqual(fetchFn.calls[i].url, cases[i][1], `"${cases[i][0]}" resolved wrongly`);
  }
});

s.test('cloud: the OpenRouter preset sends X-Title and deliberately no HTTP-Referer', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  const out = await d.dissect({
    text: 'techno',
    mode: 'cloud',
    cloud: { preset: 'openrouter', endpoint: '', key: 'or-key', model: '' },
  });

  assert.strictEqual(out.ok, true, out.error);
  const call = fetchFn.calls[0];
  assert.strictEqual(call.url, CLOUD_API_PRESETS.openrouter.endpoint);
  assert.strictEqual(call.headers.Authorization, 'Bearer or-key');
  assert.strictEqual(call.headers['X-Title'], 'SunoPrompt Studio');
  // From a file:// origin the referrer is the user's own local path. Shipping
  // it to a third party to earn a leaderboard credit is not a trade this app
  // makes for the user, so the header is absent BY DESIGN, not by omission.
  assert.strictEqual(call.headers['HTTP-Referer'], undefined);
  assert.strictEqual(call.headers.Referer, undefined);
  // The preset's own default model filled in when the UI supplied none.
  assert.strictEqual(call.body.model, CLOUD_API_PRESETS.openrouter.defaultModel);
});

s.test('cloud: a user-typed endpoint overrides the preset default', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({
    text: 'techno',
    mode: 'cloud',
    cloud: cloudConfig({ preset: 'openrouter', endpoint: 'http://127.0.0.1:8080/v1/chat/completions' }),
  });
  assert.strictEqual(fetchFn.calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
});

s.test('cloud: the Gemini preset proves the adapter is provider-agnostic', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: geminiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  const out = await d.dissect({
    text: 'techno',
    mode: 'cloud',
    cloud: { preset: 'gemini', endpoint: '', key: 'goog-key', model: 'gemini-2.0-flash' },
  });

  assert.strictEqual(out.ok, true, out.error);
  const call = fetchFn.calls[0];
  // buildUrl substituted {model} into the path...
  assert.strictEqual(
    call.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
  );
  assert.strictEqual(call.url.indexOf('{model}'), -1, 'the path template was not substituted');
  // ...the key travels in a header, never a query parameter...
  assert.strictEqual(call.headers['x-goog-api-key'], 'goog-key');
  assert.strictEqual(call.headers.Authorization, undefined);
  assert.strictEqual(call.url.indexOf('goog-key'), -1, 'the key reached the URL');
  // ...and the body uses Gemini's own dialect of the §7.1 sampling contract.
  assert.strictEqual(call.body.contents[0].parts[0].text.indexOf('techno') !== -1, true);
  assert.strictEqual(call.body.generationConfig.temperature, 0.1);
  assert.strictEqual(call.body.generationConfig.topK, 10);
  assert.strictEqual(call.body.messages, undefined, 'the OpenAI shape leaked into the Gemini preset');
});

s.test('cloud: the roster is OpenRouter, Gemini and the generic OpenAI-compatible preset', () => {
  /*
   * OWNER CORRECTION (ASSUMPTIONS.md, 2026-08-25): Gemini STAYS. An earlier
   * pass of this release dropped it; the owner reversed that. It is the one
   * preset in the registry that is not OpenAI-shaped, which is exactly what
   * makes it worth keeping — it is the proof that CLOUD_API_PRESETS holds
   * adapters rather than URLs.
   */
  const ids = Object.keys(CLOUD_API_PRESETS).sort();
  assert.deepStrictEqual(ids, ['custom', 'gemini', 'openrouter']);
  // Groq DID fold in — its adapter was byte-identical to the generic one — but
  // it survives where it is actually useful: as a base URL the user can pick.
  assert.strictEqual(CLOUD_API_PRESETS.groq, undefined, 'groq folded into the generic preset');
  const suggested = CLOUD_API_PRESETS.custom.suggestions.map((entry) => entry.label);
  assert.ok(suggested.includes('Groq'), `Groq is not offered as a base URL: ${suggested.join(', ')}`);
  for (const entry of CLOUD_API_PRESETS.custom.suggestions) {
    assert.ok(/^https?:\/\//.test(entry.baseUrl), `${entry.label}: not an absolute URL`);
  }
});

s.test('cloud: an unknown preset id degrades to the generic OpenAI-compatible adapter', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  // A workspace saved by a build that had a preset this one does not.
  const out = await d.dissect({
    text: 'techno',
    mode: 'cloud',
    cloud: { preset: 'groq', endpoint: 'https://api.example.com/v1', key: 'k', model: 'm' },
  });
  assert.strictEqual(out.ok, true, out.error);
  const call = fetchFn.calls[0];
  assert.strictEqual(call.url, 'https://api.example.com/v1/chat/completions');
  assert.strictEqual(call.headers.Authorization, 'Bearer k');
  assert.ok(call.body.messages, 'the generic adapter must send an OpenAI-shaped body');
  // …and it must NOT have degraded to the one preset that is not OpenAI-shaped.
  assert.strictEqual(call.headers['x-goog-api-key'], undefined);
});

s.test('cloud: every registry preset exposes the full adapter contract', () => {
  const ids = Object.keys(CLOUD_API_PRESETS);
  assert.ok(ids.includes('custom'), 'a blank custom preset must exist so Auto can stay offline');
  assert.strictEqual(CLOUD_API_PRESETS.custom.endpoint, '');
  for (const id of ids) {
    const preset = CLOUD_API_PRESETS[id];
    assert.strictEqual(preset.id, id, `${id}: id mismatch`);
    assert.ok(preset.label, `${id}: no label`);
    assert.strictEqual(typeof preset.buildHeaders, 'function', `${id}: no buildHeaders`);
    assert.strictEqual(typeof preset.buildBody, 'function', `${id}: no buildBody`);
    assert.strictEqual(typeof preset.extractText, 'function', `${id}: no extractText`);
    const body = preset.buildBody('PROMPT', 'MODEL');
    assert.ok(body && typeof body === 'object', `${id}: buildBody returned no object`);
    assert.strictEqual(JSON.stringify(body).indexOf('PROMPT') !== -1, true, `${id}: prompt not embedded`);
    assert.strictEqual(preset.extractText({}), null, `${id}: extractText invented text from an empty reply`);
  }
});

/* --- provider seam & resiliency ------------------------------------------ */

s.test('providers: an injected provider replaces the shipped one (the WebGPU slot)', async () => {
  const seen = [];
  const fakeResult = {
    genre_tokens: [{ tag: 'from-webgpu', weight: 1 }],
    bpm_range: null,
    instruments: [],
    mood: [],
    era: [],
    confidence: 0.5,
    source: 'local',
  };
  const d = createDissector({
    fetchFn: makeFetchFake({ status: 200 }),
    providers: {
      local: function (ctx, request) {
        seen.push({ text: request.text, hasPrompt: typeof request.promptText === 'string', hasNow: typeof ctx.now === 'function' });
        return Promise.resolve({ ok: true, result: fakeResult });
      },
    },
  });

  const out = await d.dissect({ text: 'techno', mode: 'local' });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(tagsOf(out.result), ['from-webgpu']);
  assert.deepStrictEqual(seen, [{ text: 'techno', hasPrompt: true, hasNow: true }]);
});

s.test('providers: an injected cloud provider participates in the auto chain', async () => {
  const toast = makeToastSpy();
  const d = createDissector({
    toast: toast,
    providers: {
      cloud: function () {
        return Promise.resolve({ ok: false, error: 'synthetic rate limit', retryable: true });
      },
    },
  });
  const out = await d.dissect({ text: 'techno', mode: 'auto' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true);
  assert.deepStrictEqual(toast.shown.map((t) => t.message), [DISSECTOR_FALLBACK_TOAST]);
});

/* --- the local-llm tier inside the chain ---------------------------------- */

/**
 * A stand-in for createLocalLlmEngine, driven entirely by what the test wants
 * the engine's STATE to be. It never touches a network or a worker.
 */
function makeEngineFake(status, plan) {
  const calls = [];
  return {
    calls,
    status: () => status,
    statusDetail: () => 'fake engine',
    generate(request) {
      calls.push(request.promptText);
      const decision = typeof plan === 'function' ? plan(calls.length, request) : plan;
      return Promise.resolve(decision);
    },
  };
}

s.test('chain: local-llm with no weights falls through to the taxonomy engine, silently', async () => {
  const toast = makeToastSpy();
  const engine = makeEngineFake('absent', null);
  const d = createDissector({ toast, localLlm: engine, fetchFn: makeFetchFake({ status: 200 }) });

  const out = await d.dissect({ text: 'french electro', mode: 'local-llm' });

  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.mode, 'local', 'the taxonomy engine answered');
  assert.strictEqual(out.result.source, 'local');
  // The three claims that make local-llm safe as the DEFAULT mode: nothing was
  // generated, nothing was reported as a fallback, and no toast fired.
  assert.deepStrictEqual(engine.calls, []);
  assert.strictEqual(out.fellBack, false, 'an undownloaded model is not a busy provider');
  assert.strictEqual(toast.shown.length, 0);
});

s.test('chain: a ready local-llm answers and stamps the result source', async () => {
  const engine = makeEngineFake('ready', { ok: true, text: GOOD_REPLY_JSON });
  const d = createDissector({ localLlm: engine });

  const out = await d.dissect({ text: 'berlin techno', mode: 'local-llm' });

  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.mode, 'local-llm');
  assert.strictEqual(out.result.source, 'local-llm');
  assert.deepStrictEqual(tagsOf(out.result), ['techno', 'hypnotic loop']);
  // The same prompt text every other mode gets — one builder, four providers.
  assert.strictEqual(engine.calls.length, 1);
  assert.ok(engine.calls[0].indexOf('berlin techno') !== -1);
});

s.test('chain: a chatty local-llm reply earns exactly one "JSON only" retry', async () => {
  const engine = makeEngineFake('ready', (call) =>
    call === 1 ? { ok: true, text: 'Sure! Here is what I think.' } : { ok: true, text: GOOD_REPLY_JSON }
  );
  const d = createDissector({ localLlm: engine });

  const out = await d.dissect({ text: 'techno', mode: 'local-llm' });
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.result.source, 'local-llm');
  assert.strictEqual(engine.calls.length, 2, 'exactly one retry, never two');
  assert.ok(/Return ONLY the JSON object\.$/.test(engine.calls[1]), engine.calls[1].slice(-40));

  // …and a second failure is REPORTED, not retried again and not masked.
  // Retrying a third time spends another 20 seconds on the same refusal, and
  // quietly answering from the taxonomy engine instead would let a model that
  // never returns usable JSON look like one that works — the same reason the
  // chain refuses to mask a 401 from a cloud endpoint.
  const stubborn = makeEngineFake('ready', { ok: true, text: 'no json here either' });
  const out2 = await createDissector({ localLlm: stubborn }).dissect({ text: 'techno', mode: 'local-llm' });
  assert.strictEqual(stubborn.calls.length, 2, 'exactly two attempts, then an honest error');
  assert.strictEqual(out2.ok, false);
  assert.strictEqual(out2.mode, 'local-llm');
  assert.ok(/not usable JSON/.test(out2.error), out2.error);
  assert.strictEqual(out2.fellBack, false);
});

s.test('chain: a local-llm timeout is retryable, so the taxonomy engine catches it', async () => {
  const toast = makeToastSpy();
  const engine = makeEngineFake('ready', {
    ok: false,
    error: 'the on-device model ran past its 20000ms deadline',
    retryable: true,
  });
  const d = createDissector({ toast, localLlm: engine });

  const out = await d.dissect({ text: 'french electro', mode: 'local-llm' });
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true, 'a model that WAS tried and timed out IS a fallback');
  assert.deepStrictEqual(toast.shown.map((t) => t.message), [DISSECTOR_FALLBACK_TOAST]);
});

s.test('chain: auto runs cloud, then local-llm, then the taxonomy engine', async () => {
  const order = [];
  const d = createDissector({
    toast: makeToastSpy(),
    providers: {
      cloud: () => {
        order.push('cloud');
        return Promise.resolve({ ok: false, error: 'no endpoint', configured: false });
      },
      'local-llm': () => {
        order.push('local-llm');
        return Promise.resolve({ ok: false, error: 'not downloaded', configured: false });
      },
      local: (ctx, request) => {
        order.push('local');
        return Promise.resolve({ ok: true, result: { ...host(GOOD_RESULT), source: 'local' } });
      },
    },
  });

  const out = await d.dissect({ text: 'techno', mode: 'auto' });
  assert.deepStrictEqual(order, ['cloud', 'local-llm', 'local']);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.fellBack, false, 'two never-attempted tiers are not a fallback');
});

s.test('chain: pinning a mode other than local-llm still runs exactly one provider', async () => {
  for (const mode of ['local', 'cloud', 'ollama']) {
    const seen = [];
    const d = createDissector({
      fetchFn: makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) }),
      timeoutMs: 500,
      providers: {
        local: () => (seen.push('local'), Promise.resolve({ ok: true, result: host(GOOD_RESULT) })),
        'local-llm': () => (seen.push('local-llm'), Promise.resolve({ ok: false, configured: false, error: 'x' })),
        cloud: () => (seen.push('cloud'), Promise.resolve({ ok: true, result: host(GOOD_RESULT) })),
        ollama: () => (seen.push('ollama'), Promise.resolve({ ok: true, result: host(GOOD_RESULT) })),
      },
    });
    await d.dissect({ text: 'techno', mode, cloud: cloudConfig() });
    assert.deepStrictEqual(seen, [mode], `${mode} did not run alone`);
  }
});

s.test('providers: throwing, non-promise and rejecting providers all resolve as failures', async () => {
  const cases = [
    ['throws', () => { throw new Error('boom'); }, /threw: boom/],
    ['returns a non-promise', () => ({ ok: true, result: {} }), /did not return a promise/],
    ['rejects', () => Promise.reject(new Error('nope')), /rejected: nope/],
    ['resolves nothing', () => Promise.resolve(undefined), /returned no outcome/],
  ];
  for (const [label, provider, expected] of cases) {
    const d = createDissector({ providers: { local: provider } });
    const out = await d.dissect({ text: 'techno', mode: 'local' });
    assert.strictEqual(out.ok, false, `${label}: expected a failure`);
    assert.ok(expected.test(out.error), `${label}: error was "${out.error}"`);
    assert.strictEqual(out.fellBack, false);
  }
});

s.test('resiliency: dissect() resolves even with no fetch available at all', async () => {
  const toast = makeToastSpy();
  const d = createDissector({ toast: toast });
  const out = await d.dissect({ text: 'french electro', mode: 'auto', cloud: cloudConfig() });
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, false, 'an absent fetch is not a busy cloud');
  assert.strictEqual(toast.shown.length, 0);
});

s.test('resiliency: a toast host that throws cannot break the chain', async () => {
  const d = createDissector({
    fetchFn: makeFetchFake({ status: 429 }),
    toast: function () {
      throw new Error('toast host exploded');
    },
    timeoutMs: 500,
  });
  const out = await d.dissect({ text: 'techno', mode: 'auto', cloud: cloudConfig() });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'local');
  assert.strictEqual(out.fellBack, true);
});

s.test('listModes() describes every selectable mode in DISSECTOR_MODES order', () => {
  const modes = createDissector({}).listModes();
  assert.deepStrictEqual(host(modes).map((m) => m.id), host(DISSECTOR_MODES));
  for (const mode of modes) {
    assert.ok(mode.label && typeof mode.label === 'string', `${mode.id}: no label`);
    assert.ok(mode.detail && typeof mode.detail === 'string', `${mode.id}: no detail`);
  }
});

/* --- secret hygiene ------------------------------------------------------- */

s.test('secrets: an API key never reaches localStorage, sessionStorage or a URL', async () => {
  const SECRET = 'sk-super-secret-value';
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  const before = app.storage.local.writes.length + app.storage.session.writes.length;
  const out = await d.dissect({
    text: 'french electro',
    mode: 'cloud',
    cloud: cloudConfig({ key: SECRET }),
  });
  assert.strictEqual(out.ok, true, out.error);

  const writes = app.storage.local.writes.concat(app.storage.session.writes);
  assert.strictEqual(writes.length, before, `storage was written ${writes.length - before} time(s) during a dissection`);
  const dumped = JSON.stringify(writes);
  assert.strictEqual(dumped.indexOf(SECRET), -1, 'the API key was persisted');

  const call = fetchFn.calls[0];
  assert.strictEqual(call.url.indexOf(SECRET), -1, 'the API key leaked into the request URL');
  assert.strictEqual(call.rawBody.indexOf(SECRET), -1, 'the API key leaked into the request body');
  assert.strictEqual(call.headers.Authorization, 'Bearer ' + SECRET, 'the key must travel as a header');
  assert.strictEqual(JSON.stringify(out.result).indexOf(SECRET), -1, 'the API key leaked into the result');
});

s.test('secrets: the whole #app-main source writes storage only for the probe key', () => {
  const writes = app.source.match(/\.setItem\s*\(\s*(['"`])([^'"`]*)\1/g) || [];
  assert.deepStrictEqual(writes, [".setItem('suno_storage_probe'"], `unexpected storage writes: ${writes.join(' | ')}`);
});

/* --- toasts --------------------------------------------------------------- */

s.test('toasts: createToastHost degrades to a no-op host without a DOM', () => {
  for (const doc of [null, undefined, {}, { createElement: 1 }, { createElement: () => ({}) }]) {
    const host = createToastHost(doc);
    assert.strictEqual(typeof host.show, 'function');
    assert.strictEqual(host.show('anything', 'warn'), null);
    assert.strictEqual(host.count(), 0);
    host.clear();
  }
});

s.test('toasts: messages stack in one polite live region and auto-dismiss', () => {
  const doc = makeFakeDocument();
  const timers = [];
  const host = createToastHost(doc, {
    ttlMs: 4000,
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn: fn, ms: ms });
      return timers.length;
    },
  });

  const mounted = doc.body.childNodes[0];
  assert.strictEqual(mounted.className, 'toast-host');
  assert.strictEqual(mounted.getAttribute('aria-live'), 'polite');
  assert.strictEqual(mounted.getAttribute('role'), 'status');

  const first = host.show(DISSECTOR_FALLBACK_TOAST, 'warn');
  const second = host.show('second message', 'error');
  assert.strictEqual(host.count(), 2, 'toasts must stack, not replace');
  assert.strictEqual(first.textContent, DISSECTOR_FALLBACK_TOAST);
  assert.strictEqual(first.className, 'toast toast-warn');
  assert.strictEqual(second.className, 'toast toast-error');
  assert.strictEqual(host.show('plain').className, 'toast toast-info');

  assert.strictEqual(timers.length, 3);
  assert.strictEqual(timers[0].ms, 4000);
  timers[0].fn();
  assert.strictEqual(host.count(), 2, 'the auto-dismiss did not remove its toast');
  timers[0].fn();
  assert.strictEqual(host.count(), 2, 'a repeated dismiss must be harmless');

  assert.strictEqual(host.show(''), null, 'an empty message is not a toast');
  host.clear();
  assert.strictEqual(host.count(), 0);
});

s.test('toasts: the engine hands the exact §7.3 copy to the host', () => {
  const doc = makeFakeDocument();
  const host = createToastHost(doc, { setTimeoutFn: () => 1 });
  host.show(DISSECTOR_FALLBACK_TOAST, 'warn');
  assert.strictEqual(doc.body.childNodes[0].childNodes[0].textContent, 'Cloud API busy. Falling back to local offline model.');
});

/* ========================================================================== */
/* THE ARMING GATE (createCloudArming)                                        */
/*                                                                            */
/* The regression these tests exist for, in full: "Disarm" used to blank the  */
/* key field and hide the chip, and nothing else. The ENDPOINT field — which  */
/* the vault auto-fills at boot, without the user typing a character — stayed */
/* put, and cloudDissectorProvider gates on an endpoint alone. So a disarmed  */
/* Auto dissection still POSTed the user's prompt text to the remembered      */
/* provider, now with no auth header. The in-memory `cloudArmed` boolean was  */
/* written and never read.                                                    */
/*                                                                            */
/* Every test below drives the SAME assembler production uses                 */
/* (arming.config()) into the SAME engine (createDissector) with a RECORDING  */
/* fake fetch, so "zero network calls" is counted rather than asserted.       */
/* ========================================================================== */

/** An <input>/<select> stand-in: the gate only ever touches `.value`. */
function makeField(value) {
  return { value: typeof value === 'string' ? value : '' };
}

/** The four cloud fields plus the chip, wired to a real createCloudArming. */
function makeArmedPanel(options) {
  const opts = options || {};
  const fields = {
    presetSelect: makeField(opts.preset || 'custom'),
    endpointInput: makeField(opts.endpoint || ''),
    modelInput: makeField(opts.model || ''),
    keyInput: makeField(opts.key || ''),
    indicator: { hidden: true },
    label: { textContent: '' },
  };
  const arming = createCloudArming({
    presets: CLOUD_API_PRESETS,
    presetSelect: fields.presetSelect,
    endpointInput: fields.endpointInput,
    modelInput: fields.modelInput,
    keyInput: fields.keyInput,
    indicator: fields.indicator,
    label: fields.label,
  });
  return {
    arming,
    ...fields,
    /**
     * The two token-carrying calls, made with a token captured RIGHT NOW —
     * i.e. an async chain that nothing has interrupted. The race tests further
     * down deliberately do NOT use these: capturing the token early and
     * presenting it late is the whole subject there.
     */
    restoreNow(slots) {
      return arming.restoreSlot(slots, arming.token());
    },
    armVaultNow() {
      return arming.armFromVault(arming.token());
    },
  };
}

/** One remembered slot, exactly as keyVault.list() reports it. */
const GEMINI_SLOT = {
  id: 'gemini::https://generativelanguage.googleapis.com',
  presetId: 'gemini',
  endpointOrigin: 'https://generativelanguage.googleapis.com',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
  ts: 1000,
};

s.test('the arming gate is a reachable top-level factory', () => {
  assert.strictEqual(typeof createCloudArming, 'function');
});

s.test('(a) Disarm clears the key AND the endpoint AND the model, and hides the chip', () => {
  const panel = makeArmedPanel({ preset: 'gemini' });
  panel.restoreNow([GEMINI_SLOT]);
  panel.keyInput.value = 'AIza-secret';
  panel.modelInput.value = 'gemini-2.0-flash';
  panel.armVaultNow();

  assert.strictEqual(panel.indicator.hidden, false, 'an armed panel must show the chip');
  assert.strictEqual(panel.label.textContent, 'cloud armed: Google Gemini');
  assert.ok(panel.arming.config(), 'an armed panel must produce a config');

  panel.arming.disarm();

  assert.strictEqual(panel.keyInput.value, '', 'the key field survived a disarm');
  assert.strictEqual(panel.endpointInput.value, '', 'THE BUG: the endpoint survived a disarm');
  assert.strictEqual(panel.modelInput.value, '', 'the model field survived a disarm');
  assert.strictEqual(panel.arming.isArmed(), false, 'the gate is still armed');
  assert.strictEqual(panel.arming.isLive(), false);
  assert.strictEqual(panel.indicator.hidden, true, 'the chip is still up after a disarm');
  assert.strictEqual(panel.arming.config(), null, 'a disarmed gate must assemble nothing at all');
});

s.test('(b) after Disarm, cloud AND auto dissections make ZERO network calls', async () => {
  // The gemini preset on purpose: its registry entry carries a built-in
  // endpoint, and resolveCloudConfig() substitutes that for an empty one. A
  // gate that returned {preset:'gemini', endpoint:''} instead of null would
  // therefore still dial out — which is why config() returns null.
  const panel = makeArmedPanel({ preset: 'gemini' });
  panel.restoreNow([GEMINI_SLOT]);
  panel.keyInput.value = 'AIza-secret';
  panel.modelInput.value = 'gemini-2.0-flash';
  panel.armVaultNow();

  const fetchFn = makeFetchFake({ status: 200, json: geminiReply(GOOD_REPLY_JSON) });
  const engine = createDissector({ fetchFn: fetchFn, toast: makeToastSpy() });

  // Armed: the call really does go out, so the counter below means something.
  const armedOutcome = await engine.dissect({
    text: 'neon rain',
    mode: 'cloud',
    cloud: panel.arming.config(),
  });
  assert.strictEqual(armedOutcome.ok, true, JSON.stringify(armedOutcome));
  assert.strictEqual(fetchFn.calls.length, 1, 'the armed baseline never left the machine');
  assert.strictEqual(fetchFn.calls[0].headers['x-goog-api-key'], 'AIza-secret');

  panel.arming.disarm();

  const cloudAfter = await engine.dissect({
    text: 'neon rain',
    mode: 'cloud',
    cloud: panel.arming.config(),
  });
  assert.strictEqual(fetchFn.calls.length, 1, `a disarmed CLOUD dissection called out: ${JSON.stringify(fetchFn.calls[1])}`);
  assert.strictEqual(cloudAfter.ok, false);
  assert.ok(/no cloud endpoint configured/.test(cloudAfter.error), cloudAfter.error);

  const autoAfter = await engine.dissect({
    text: 'french electro with a neon rain mood',
    mode: 'auto',
    cloud: panel.arming.config(),
  });
  assert.strictEqual(fetchFn.calls.length, 1, `a disarmed AUTO dissection called out: ${JSON.stringify(fetchFn.calls[1])}`);
  // Auto still answers — from the embedded taxonomy engine, and says so.
  assert.strictEqual(autoAfter.ok, true, JSON.stringify(autoAfter));
  assert.strictEqual(autoAfter.result.source, 'local');
  assert.strictEqual(autoAfter.fellBack, false, 'a gate that was never armed is not a fallback');
});

s.test('(b) a disarmed gate is inert even with the fields refilled behind its back', async () => {
  // Belt and braces: the gate, not the emptiness of the DOM, is what stops the
  // request. If some future code path repopulates the endpoint without an
  // explicit arm, this is the test that fails.
  const panel = makeArmedPanel({ preset: 'gemini' });
  panel.restoreNow([GEMINI_SLOT]);
  panel.armVaultNow();
  panel.arming.disarm();
  panel.endpointInput.value = GEMINI_SLOT.endpoint;
  panel.keyInput.value = 'AIza-secret';

  assert.strictEqual(panel.arming.config(), null, 'a value not typed by the user must not re-arm the gate');
  assert.strictEqual(panel.indicator.hidden, true);

  const fetchFn = makeFetchFake({ status: 200, json: geminiReply(GOOD_REPLY_JSON) });
  const engine = createDissector({ fetchFn: fetchFn, toast: makeToastSpy() });
  await engine.dissect({ text: 'neon rain', mode: 'auto', cloud: panel.arming.config() });
  assert.strictEqual(fetchFn.calls.length, 0, 'the fields alone were enough to send a request');
});

s.test('(c) typing an endpoint after a disarm re-arms the gate and the call goes out', async () => {
  const panel = makeArmedPanel({ preset: 'gemini' });
  panel.restoreNow([GEMINI_SLOT]);
  panel.armVaultNow();
  panel.arming.disarm();
  assert.strictEqual(panel.arming.config(), null);

  // Exactly what the endpoint field's `input` listener does, keystroke by
  // keystroke: set the value, then tell the gate a human did it.
  panel.presetSelect.value = 'custom';
  panel.endpointInput.value = 'https://api.groq.com/openai/v1';
  panel.keyInput.value = 'sk-typed-by-hand';
  panel.arming.armFromUserEdit();

  assert.strictEqual(panel.arming.isLive(), true, 'typing is consent and must re-arm');
  assert.strictEqual(panel.indicator.hidden, false, 'the chip must come back');
  assert.strictEqual(panel.label.textContent, 'cloud armed: OpenAI-compatible (any base URL)');

  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const engine = createDissector({ fetchFn: fetchFn, toast: makeToastSpy() });
  const outcome = await engine.dissect({ text: 'neon rain', mode: 'cloud', cloud: panel.arming.config() });

  assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
  assert.strictEqual(fetchFn.calls.length, 1);
  assert.strictEqual(fetchFn.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(fetchFn.calls[0].headers.Authorization, 'Bearer sk-typed-by-hand');
});

s.test('(d) a reload re-populates the one remembered slot, and the chip returns with the key', () => {
  // Boot order, exactly as restoreRememberedSlot() runs it: fields first…
  const panel = makeArmedPanel();
  const applied = panel.restoreNow([GEMINI_SLOT]);

  assert.ok(applied, 'a single remembered slot must be restored');
  assert.strictEqual(applied.presetId, 'gemini');
  assert.strictEqual(panel.presetSelect.value, 'gemini');
  assert.strictEqual(
    panel.endpointInput.value,
    CLOUD_API_PRESETS.gemini.endpoint,
    'the preset endpoint wins over the bare origin, so the {model} template survives'
  );
  // …and NOT armed yet: the key has not been decrypted at this point, and a
  // filled-in endpoint is not consent on its own.
  assert.strictEqual(panel.arming.isArmed(), false);
  assert.strictEqual(panel.indicator.hidden, true);
  assert.strictEqual(panel.arming.config(), null);

  // …then the successful recall arms it, which is where the chip comes from.
  panel.keyInput.value = 'AIza-secret';
  panel.armVaultNow();
  assert.strictEqual(panel.indicator.hidden, false);
  assert.strictEqual(panel.label.textContent, 'cloud armed: Google Gemini');
  const config = panel.arming.config();
  assert.strictEqual(config.preset, 'gemini');
  assert.strictEqual(config.endpoint, CLOUD_API_PRESETS.gemini.endpoint);
  assert.strictEqual(config.key, 'AIza-secret');
});

s.test('(d) two remembered slots restore NOTHING — guessing would arm the wrong host', () => {
  const panel = makeArmedPanel();
  const second = { id: 'openrouter::https://openrouter.ai', presetId: 'openrouter', endpointOrigin: 'https://openrouter.ai', endpoint: 'https://openrouter.ai/api/v1/chat/completions', ts: 2000 };
  assert.strictEqual(panel.restoreNow([GEMINI_SLOT, second]), null);
  assert.strictEqual(panel.restoreNow([]), null);
  assert.strictEqual(panel.restoreNow(null), null);
  assert.strictEqual(panel.endpointInput.value, '', 'a field was filled from an ambiguous vault');
  assert.strictEqual(panel.arming.config(), null);
});

s.test('an armed gate with an empty endpoint is NOT live (no preset-default dial-out)', async () => {
  const panel = makeArmedPanel({ preset: 'gemini', key: 'AIza-secret' });
  panel.arming.armFromUserEdit();

  assert.strictEqual(panel.arming.isArmed(), true);
  assert.strictEqual(panel.arming.isLive(), false, 'no endpoint means nothing is live');
  assert.strictEqual(panel.indicator.hidden, true, 'the chip must not claim an armed cloud with no endpoint');
  assert.strictEqual(panel.arming.config(), null);

  const fetchFn = makeFetchFake({ status: 200, json: geminiReply(GOOD_REPLY_JSON) });
  const engine = createDissector({ fetchFn: fetchFn, toast: makeToastSpy() });
  await engine.dissect({ text: 'neon rain', mode: 'auto', cloud: panel.arming.config() });
  assert.strictEqual(fetchFn.calls.length, 0, 'an emptied endpoint field silently used the preset default');
});

s.test('STATIC: the disarm handler clears the endpoint, and nothing else assembles a cloud request', () => {
  const source = app.source;

  // 1. The Disarm click handler goes through the gate…
  const handler = /disarmBtn\.addEventListener\(\s*'click',\s*function \(\) \{([\s\S]*?)\n    \}\);/.exec(source);
  assert.ok(handler, 'the Disarm click handler could not be located');
  assert.ok(
    /cloudArming\.disarm\(\)/.test(handler[1]),
    `the Disarm handler does not call the gate:\n${handler[1]}`
  );

  // 2. …and the gate's disarm() clears all three fields. Asserted on the
  //    implementation because this is the exact line the review found missing:
  //    a disarm that leaves `endpointInput` set is the whole bug.
  const disarm = /disarm: function \(\) \{([\s\S]*?)\n    \},/.exec(source);
  assert.ok(disarm, 'createCloudArming.disarm could not be located');
  for (const field of ['keyInput', 'endpointInput', 'modelInput']) {
    assert.ok(
      new RegExp(`setField\\(${field}, ''\\)`).test(disarm[1]),
      `disarm() does not clear ${field}:\n${disarm[1]}`
    );
  }
  assert.ok(/armed = false;/.test(disarm[1]), 'disarm() does not lower the gate itself');

  // 3. There is exactly ONE assembler. A second `cloud: {` literal anywhere in
  //    #app-main would be a request built straight from the DOM again.
  const assemblers = source.match(/cloud:\s*\{/g) || [];
  assert.strictEqual(
    assemblers.length,
    0,
    `a cloud request is being assembled from a literal in ${assemblers.length} place(s), not through cloudArming.config()`
  );
  assert.ok(/cloud: cloudArming\.config\(\),/.test(source), 'runDissection does not use the gate');

  // 4. The boolean the review found decorative is gone by name, so nobody can
  //    read a stale copy of the gate.
  assert.strictEqual(/\bcloudArmed\b/.test(source), false, '`cloudArmed` shadow state is back');
  assert.strictEqual(/function setArmed\b/.test(source), false, '`setArmed` shadow state is back');
});

/* ========================================================================== */
/* THE EPOCH GUARD — arming races (createVaultRestore + createCloudArming)     */
/*                                                                            */
/* The two blocking races found in round-2 review, both in the gaps between   */
/* the vault chain's awaits:                                                  */
/*                                                                            */
/*   A. An explicit Disarm click landing while the boot-time restore chain    */
/*      was in flight got OVERWRITTEN milliseconds later: the continuation    */
/*      refilled endpoint, model and the real plaintext key and armed the     */
/*      gate again. There was no staleness token of any kind.                 */
/*   B. boot()'s tail called applyPreset(), which was also the preset-CHANGE  */
/*      handler, so armFromUserEdit() ran on EVERY reload — the armed flag    */
/*      set by UI initialization rather than by consent.                      */
/*                                                                            */
/* Neither was expressible as a test before: the chain was two closures deep  */
/* inside boot(), reachable only through a real browser with a real IndexedDB */
/* and a real clock. It is now createVaultRestore(deps), and everything it    */
/* needs — the gate, the vault — is injected, so the tests below land a       */
/* Disarm (or a preset change) at a chosen instant INSIDE the chain.          */
/* ========================================================================== */

/** A promise whose settlement the test owns. */
function defer() {
  let resolve = null;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A keyVault stand-in whose list() and recall() hang until the test settles
 * them. That is the whole point: every interesting instant in the chain is a
 * moment where one of these two promises is outstanding.
 */
function makeFakeVault(options) {
  const opts = options || {};
  const listCalls = [];
  const recallCalls = [];
  let pendingLists = [];
  let pendingRecalls = [];

  const api = {
    supported: () => opts.supported !== false,
    /** The real slotId shape: presetId::origin, origin empty when unparseable. */
    slotId(preset, endpoint) {
      let origin = '';
      try {
        origin = endpoint ? new URL(endpoint).origin : '';
      } catch (err) {
        origin = '';
      }
      return `${preset}::${origin}`;
    },
    list() {
      listCalls.push(true);
      const d = defer();
      pendingLists.push(d);
      return d.promise;
    },
    recall(slot) {
      recallCalls.push(slot);
      const d = defer();
      pendingRecalls.push(d);
      return d.promise;
    },
  };

  return {
    api,
    listCalls,
    recallCalls,
    /** Settle every outstanding list(), then let the continuations run. */
    async settleList(slots) {
      const waiting = pendingLists;
      pendingLists = [];
      for (const d of waiting) d.resolve(slots);
      await drain();
    },
    /** Settle every outstanding recall(), then let the continuations run. */
    async settleRecall(outcome) {
      const waiting = pendingRecalls;
      pendingRecalls = [];
      for (const d of waiting) d.resolve(outcome);
      await drain();
    },
  };
}

/**
 * The REAL gate, wrapped so every call and every return value is recorded.
 * The wrapper adds nothing and decides nothing — it exists so a test can say
 * "the gate answered {stale:true} to exactly this call", which is the
 * observable the mechanism is built around.
 */
function recordGate(arming) {
  const calls = [];
  const wrapped = { calls };
  for (const name of Object.keys(arming)) {
    const member = arming[name];
    if (typeof member !== 'function') {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = function (...args) {
      const out = member.apply(arming, args);
      calls.push({ name, args, out });
      return out;
    };
  }
  return wrapped;
}

/** The gate + the vault + the restore chain, wired the way boot() wires them. */
function makeRestoreRig(options) {
  const panel = makeArmedPanel(options);
  const gate = recordGate(panel.arming);
  const vault = makeFakeVault(options);
  const chrome = {
    rememberBox: { checked: false },
    keyForgetBtn: { hidden: true },
    presets: [],
    syncs: 0,
    status: [],
  };
  const restore = createVaultRestore({
    arming: gate,
    vault: () => vault.api,
    rememberBox: chrome.rememberBox,
    keyForgetBtn: chrome.keyForgetBtn,
    onPreset: (preset) => chrome.presets.push(preset.id),
    onSync: () => {
      chrome.syncs += 1;
    },
    onStatus: (message, kind) => chrome.status.push({ message, kind }),
  });
  return { panel, gate, vault, chrome, restore };
}

/** The names of the gate calls that were REFUSED, in order. */
function refusals(rig) {
  return rig.gate.calls.filter((c) => c.out && c.out.stale === true).map((c) => c.name);
}

/**
 * The gate's refusal, asserted by shape rather than by deepStrictEqual: the
 * object is minted inside the vm realm, so its prototype is not this realm's
 * Object.prototype and reference-equality of prototypes would fail on a
 * correct answer.
 */
function assertRefused(result, label) {
  assert.ok(result && result.stale === true, `${label}: expected {stale:true}, got ${JSON.stringify(result)}`);
  assert.deepStrictEqual(Object.keys(result), ['stale'], `${label}: a refusal must carry nothing but the flag`);
}

/**
 * Await a chain that is supposed to be FINISHED by now.
 *
 * A chain that is secretly still in flight would otherwise hang this suite
 * forever, and a hung suite exits 0 — which is how a broken epoch guard could
 * masquerade as a green run. Waiting for a chain here is a failure, not a wait.
 */
async function settled(promise, label) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: the chain was still in flight — the refusal never happened`)),
      500
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

s.test('the vault restore chain is a reachable top-level factory', () => {
  assert.strictEqual(typeof createVaultRestore, 'function');
});

s.test('(RACE a) Disarm lands mid-restore: the whole chain is abandoned, fields stay empty', async () => {
  const rig = makeRestoreRig({ preset: 'custom' });

  // The chain starts and captures the epoch, then waits on the database.
  const chain = rig.restore.restore();
  assert.strictEqual(rig.vault.listCalls.length, 1, 'restore() never read the vault');

  // …and HERE is the click. Everything below is the in-flight continuation
  // waking up into a world where the user has said no.
  rig.panel.arming.disarm();

  await rig.vault.settleList([GEMINI_SLOT]);

  assert.deepStrictEqual(
    refusals(rig),
    ['restoreSlot'],
    `expected the gate to refuse exactly the restore; it recorded ${JSON.stringify(rig.gate.calls.map((c) => c.name))}`
  );
  assert.strictEqual(rig.vault.recallCalls.length, 0, 'a refused chain went on to decrypt a key anyway');
  assert.strictEqual(await settled(chain, 'RACE a'), false, 'a stale chain must resolve as "did nothing"');
  assert.strictEqual(rig.panel.presetSelect.value, 'custom', 'a stale chain switched the provider');
  assert.strictEqual(rig.panel.endpointInput.value, '', 'THE RACE: the endpoint came back after a Disarm');
  assert.strictEqual(rig.panel.modelInput.value, '');
  assert.strictEqual(rig.panel.keyInput.value, '');
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'THE RACE: the gate re-armed itself after a Disarm');
  assert.strictEqual(rig.panel.indicator.hidden, true, 'the chip came back after a Disarm');
  assert.strictEqual(rig.panel.arming.config(), null);
});

s.test('(RACE b) Disarm lands between the restore and the decrypt: no plaintext key, no arm', async () => {
  const rig = makeRestoreRig({ preset: 'custom' });
  const chain = rig.restore.restore();

  await rig.vault.settleList([GEMINI_SLOT]);
  // The restore half really did land — this is the state the user then rejects.
  assert.strictEqual(rig.panel.presetSelect.value, 'gemini');
  assert.strictEqual(rig.panel.endpointInput.value, CLOUD_API_PRESETS.gemini.endpoint);
  assert.strictEqual(rig.panel.modelInput.value, CLOUD_API_PRESETS.gemini.defaultModel);
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'restoreSlot must never arm on its own');
  assert.strictEqual(rig.vault.recallCalls.length, 1, 'the decrypt was never attempted');

  const staleToken = rig.panel.arming.token();
  rig.panel.arming.disarm();

  await rig.vault.settleRecall({ ok: true, key: 'AIza-real-plaintext' });

  assert.strictEqual(rig.panel.keyInput.value, '', 'THE RACE: a decrypted key landed in a cleared field');
  assert.strictEqual(await settled(chain, 'RACE b'), false);
  assert.strictEqual(rig.panel.endpointInput.value, '');
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'THE RACE: the recall re-armed after a Disarm');
  assert.strictEqual(rig.panel.arming.config(), null);
  assert.strictEqual(rig.chrome.rememberBox.checked, false);
  assert.strictEqual(rig.chrome.keyForgetBtn.hidden, true);

  // The refusal is the FIELD WRITE, and it short-circuits before the arm — the
  // key never even gets as far as being a thing the gate could arm on.
  assert.deepStrictEqual(refusals(rig), ['fillFromVault'], JSON.stringify(rig.gate.calls.map((c) => c.name)));

  // And the arm the chain would have made next is refused just as flatly, so
  // no ordering inside the continuation can smuggle it through.
  assertRefused(rig.panel.arming.armFromVault(staleToken), 'armFromVault on a stale token');
  assertRefused(rig.panel.arming.fillFromVault({ key: 'x' }, staleToken), 'fillFromVault on a stale token');
  assert.strictEqual(rig.panel.keyInput.value, '');
});

s.test('(RACE c) a provider the user picks DURING a restore beats the restore', async () => {
  const rig = makeRestoreRig({ preset: 'custom' });
  const chain = rig.restore.restore();

  await rig.vault.settleList([GEMINI_SLOT]);
  assert.strictEqual(rig.panel.presetSelect.value, 'gemini');
  assert.strictEqual(rig.vault.recallCalls.length, 1);

  // The user picks OpenRouter while Gemini's key is still decrypting. This is
  // exactly what onPresetChange() does: fill and arm in one gated call.
  rig.panel.presetSelect.value = 'openrouter';
  rig.panel.arming.armFromUserEdit({
    endpoint: CLOUD_API_PRESETS.openrouter.endpoint,
    model: CLOUD_API_PRESETS.openrouter.defaultModel,
  });

  await rig.vault.settleRecall({ ok: true, key: 'AIza-belongs-to-gemini' });

  assert.strictEqual(rig.panel.keyInput.value, '', 'THE RACE: a stale chain wrote its key into another panel');
  assert.strictEqual(await settled(chain, 'RACE c'), false);
  assert.strictEqual(rig.panel.presetSelect.value, 'openrouter', 'the stale chain re-selected its own provider');
  assert.strictEqual(rig.panel.endpointInput.value, CLOUD_API_PRESETS.openrouter.endpoint);
  assert.deepStrictEqual(refusals(rig), ['fillFromVault']);

  // The consequence that matters: Gemini's key must never become the
  // Authorization header on a request to OpenRouter.
  const cfg = rig.panel.arming.config();
  assert.strictEqual(cfg.preset, 'openrouter');
  assert.strictEqual(cfg.key, '', "a remembered provider's key was carried into another provider's panel");
  assert.strictEqual(rig.panel.arming.isArmed(), true, 'the user edit itself must still arm');

  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const engine = createDissector({ fetchFn: fetchFn, toast: makeToastSpy() });
  await engine.dissect({ text: 'neon rain', mode: 'cloud', cloud: rig.panel.arming.config() });
  assert.strictEqual(fetchFn.calls.length, 1);
  assert.strictEqual(fetchFn.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const sent = JSON.stringify(fetchFn.calls[0].headers) + String(fetchFn.calls[0].rawBody);
  assert.strictEqual(
    sent.indexOf('AIza-belongs-to-gemini'),
    -1,
    `a Gemini key was posted to OpenRouter: ${JSON.stringify(fetchFn.calls[0].headers)}`
  );
  assert.strictEqual(
    fetchFn.calls[0].headers.Authorization,
    undefined,
    'an empty key must not become an Authorization header at all'
  );
});

s.test('(RACE d) boot arms NOTHING — the flag waits for a user edit or a real decrypt', async () => {
  // 1. STATIC: boot()'s tail paints the panel; it does not run the change
  //    handler. This is finding B, asserted at the line that caused it.
  const source = app.source;
  assert.ok(
    /\n    renderPresetUi\(\);\n    syncModeUi\(\);/.test(source),
    "boot()'s tail must call renderPresetUi(), the paint-only half"
  );
  assert.strictEqual(/\bapplyPreset\b/.test(source), false, 'applyPreset() — the conflated function — is back');

  const paint = /\n    function renderPresetUi\(\) \{([\s\S]*?)\n    \}\n/.exec(source);
  assert.ok(paint, 'renderPresetUi() could not be located');
  assert.strictEqual(/armFrom/.test(paint[1]), false, `renderPresetUi() arms the gate:\n${paint[1]}`);
  assert.strictEqual(/\.value\s*=[^=]/.test(paint[1]), false, `renderPresetUi() writes a cloud field:\n${paint[1]}`);
  assert.strictEqual(/recallKeyForSlot/.test(paint[1]), false, 'renderPresetUi() must not start a vault chain');

  // 2. BEHAVIOURAL: a freshly built gate is not armed, and stays that way
  //    through a complete restore chain over an empty vault.
  const rig = makeRestoreRig({ preset: 'custom' });
  assert.strictEqual(rig.panel.arming.isArmed(), false);
  const empty = rig.restore.restore();
  await rig.vault.settleList([]);
  assert.strictEqual(await settled(empty, 'RACE d empty vault'), false);
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'an empty vault armed the gate');
  assert.strictEqual(rig.vault.recallCalls.length, 0, 'an empty endpoint addressed a slot');
  assert.strictEqual(rig.panel.indicator.hidden, true);

  // 3. …and a successful recall — armFromVault with a fresh token — is the
  //    thing that finally arms it.
  const live = makeRestoreRig({ preset: 'custom' });
  const chain = live.restore.restore();
  await live.vault.settleList([GEMINI_SLOT]);
  assert.strictEqual(live.panel.arming.isArmed(), false, 'the fields were filled AND armed in one step');
  await live.vault.settleRecall({ ok: true, key: 'AIza-secret' });
  assert.strictEqual(await settled(chain, 'RACE d live recall'), true);
  assert.strictEqual(live.panel.keyInput.value, 'AIza-secret');
  assert.strictEqual(live.panel.arming.isArmed(), true);
  assert.strictEqual(live.panel.indicator.hidden, false);
  assert.strictEqual(live.panel.label.textContent, 'cloud armed: Google Gemini');
  assert.deepStrictEqual(refusals(live), [], 'an uninterrupted chain must not be refused anything');
  assert.strictEqual(live.chrome.rememberBox.checked, true);
  assert.strictEqual(live.chrome.keyForgetBtn.hidden, false);
});

s.test('(RACE e) a second restore chain cannot resurrect a disarmed panel', async () => {
  const rig = makeRestoreRig({ preset: 'custom' });

  // Two chains in flight at once — a double attachAiStorage(), a re-init,
  // whatever produced it. Both captured the same epoch.
  const first = rig.restore.restore();
  const second = rig.restore.restore();
  assert.strictEqual(rig.vault.listCalls.length, 2);

  rig.panel.arming.disarm();
  await rig.vault.settleList([GEMINI_SLOT]);

  assert.deepStrictEqual(refusals(rig), ['restoreSlot', 'restoreSlot'], 'one of the two chains got through');
  assert.strictEqual(rig.vault.recallCalls.length, 0);
  assert.deepStrictEqual(
    [await settled(first, 'RACE e chain 1'), await settled(second, 'RACE e chain 2')],
    [false, false]
  );
  assert.strictEqual(rig.panel.endpointInput.value, '');
  assert.strictEqual(rig.panel.keyInput.value, '');
  assert.strictEqual(rig.panel.arming.isArmed(), false);
  assert.strictEqual(rig.panel.arming.config(), null);

  // A chain that STARTS after the disarm is a different matter: it holds a
  // current token, so it may refill the fields — that is the documented
  // per-session convenience — but filling is still not arming.
  const third = rig.restore.restore();
  await rig.vault.settleList([GEMINI_SLOT]);
  assert.strictEqual(rig.panel.endpointInput.value, CLOUD_API_PRESETS.gemini.endpoint);
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'a restore armed without a decrypt');
  await rig.vault.settleRecall({ ok: false, absent: true });
  assert.strictEqual(await settled(third, 'RACE e chain 3'), false);
  assert.strictEqual(rig.panel.arming.isArmed(), false, 'an absent key armed the gate');
  assert.strictEqual(rig.panel.arming.config(), null);
});

s.test('the epoch guard refuses a missing token as hard as a stale one', () => {
  const panel = makeArmedPanel({ preset: 'gemini' });
  // Forgetting the argument entirely is the failure mode a future call site is
  // most likely to have, so it must fail CLOSED.
  assertRefused(panel.arming.restoreSlot([GEMINI_SLOT]), 'restoreSlot with no token');
  assertRefused(panel.arming.armFromVault(), 'armFromVault with no token');
  assertRefused(panel.arming.fillFromVault({ key: 'sk-nope' }), 'fillFromVault with no token');
  assert.strictEqual(panel.endpointInput.value, '');
  assert.strictEqual(panel.keyInput.value, '');
  assert.strictEqual(panel.arming.isArmed(), false);

  // And the epoch really is monotonic, moved by the two acts of human intent
  // and by nothing else.
  const start = panel.arming.token();
  assert.strictEqual(panel.arming.token(), start, 'reading the token must not move it');
  panel.restoreNow([GEMINI_SLOT]);
  assert.strictEqual(panel.arming.token(), start, 'a vault restore is not a human intent');
  panel.armVaultNow();
  assert.strictEqual(panel.arming.token(), start, 'a vault arm is not a human intent');
  panel.arming.armFromUserEdit();
  assert.strictEqual(panel.arming.token(), start + 1, 'a user edit must move the epoch');
  panel.arming.disarm();
  assert.strictEqual(panel.arming.token(), start + 2, 'a disarm must move the epoch');
  assert.strictEqual(panel.arming.isFresh(start), false);
  assert.strictEqual(panel.arming.isFresh(start + 2), true);
});

s.test('STATIC: only the gate writes the four cloud fields, and only user events arm', () => {
  const source = app.source;

  /*
   * 1. THE FIELD-WRITE ALLOWLIST.
   *
   * `keyInput.value = outcome.key` in the recall continuation is what let a
   * decrypted plaintext key land in a field the user had just cleared: a
   * direct DOM poke is a write the gate has no opportunity to refuse. The cure
   * is that NOTHING outside createCloudArming assigns to any of the four. One
   * site survives, and it is enumerated here by name with its reason.
   */
  const ALLOWED_FIELD_WRITES = [
    {
      write: "presetSelect.value = 'custom';",
      why:
        'building the <select>: picks the blank OpenAI-compatible preset while the options are being ' +
        'appended, before the gate exists and before any field can hold a vault-sourced value.',
    },
  ];
  const fieldWrites = (
    source.match(/\b(?:presetSelect|endpointInput|modelInput|keyInput)\.value\s*=[^=][^\n]*/g) || []
  ).map((w) => w.trim());
  assert.deepStrictEqual(
    fieldWrites,
    ALLOWED_FIELD_WRITES.map((a) => a.write),
    `a cloud field is written outside createCloudArming. Allowed: ${ALLOWED_FIELD_WRITES.map((a) => a.write).join(
      ' | '
    )}. Found: ${fieldWrites.join(' | ')}`
  );

  // …and inside the gate there is exactly ONE writer, so "which code can fill
  // the endpoint box" has one answer with one guard in front of it.
  const gateBody = /\nfunction createCloudArming\(deps\) \{([\s\S]*?)\n\}\n/.exec(source);
  assert.ok(gateBody, 'createCloudArming could not be located');
  const gateWrites = gateBody[1].match(/\.value\s*=[^=]/g) || [];
  assert.strictEqual(
    gateWrites.length,
    1,
    `createCloudArming must funnel every field write through setField(); found ${gateWrites.length}`
  );
  assert.ok(/function setField\(el, value\) \{\n\s*if \(el\) el\.value = value;/.test(gateBody[1]));
  assert.ok(/function writeFields\(fields\) \{/.test(gateBody[1]), 'the gated multi-field writer is gone');

  // The restore chain never reaches for a field at all — it only has the gate.
  const chainBody = /\nfunction createVaultRestore\(deps\) \{([\s\S]*?)\n\}\n/.exec(source);
  assert.ok(chainBody, 'createVaultRestore could not be located');
  assert.strictEqual(
    /\.value\s*=[^=]/.test(chainBody[1]),
    false,
    `createVaultRestore writes a field directly:\n${chainBody[1]}`
  );

  /*
   * 2. THE ARM CALL SITES. armFromUserEdit() means "a human just stated an
   * intent", so every call must sit in a function a real input/change/click
   * event is the only way to reach.
   */
  const armSites = [];
  const armRe = /cloudArming\.armFromUserEdit\(/g;
  let hit;
  while ((hit = armRe.exec(source)) !== null) {
    const declared = source.slice(0, hit.index).match(/function [A-Za-z0-9_$]+\(/g) || [];
    armSites.push(declared[declared.length - 1].slice('function '.length, -1));
  }
  assert.deepStrictEqual(
    armSites.slice().sort(),
    ['onCloudFieldEdit', 'onPresetChange'],
    `armFromUserEdit() is reachable from ${armSites.join(', ')}`
  );
  assert.ok(
    /presetSelect\.addEventListener\('change', onPresetChange\);/.test(source),
    'onPresetChange is not bound to the dropdown'
  );
  for (const field of ['endpointInput', 'modelInput', 'keyInput']) {
    assert.ok(
      new RegExp(`${field}\\.addEventListener\\('input', onCloudFieldEdit\\);`).test(source),
      `onCloudFieldEdit is not bound to ${field}`
    );
  }
  // Two mentions of onPresetChange (declaration + listener) and four of
  // onCloudFieldEdit (declaration + three listeners): neither is called from
  // anywhere else, so boot() cannot reach either of them.
  assert.strictEqual((source.match(/\bonPresetChange\b/g) || []).length, 2, 'onPresetChange is called from somewhere else');
  assert.strictEqual(
    (source.match(/\bonCloudFieldEdit\b/g) || []).length,
    4,
    'onCloudFieldEdit is called from somewhere else'
  );

  /*
   * 3. EVERY TOKEN-CARRYING CALL CARRIES ONE. The gate fails closed on a
   * missing token at runtime, so this only catches the mistake earlier — but a
   * silently refused arm is a confusing bug to chase, and this is cheap.
   */
  const tokened = [
    { re: /\.restoreSlot\(([^)]*)\)/g, args: 2 },
    { re: /\.fillFromVault\(\{[^}]*\},([^)]*)\)/g, args: 1 },
    { re: /\.armFromVault\(([^)]*)\)/g, args: 1 },
  ];
  for (const { re, args } of tokened) {
    const found = source.match(re) || [];
    assert.ok(found.length > 0, `no call sites matched ${re}`);
    for (const call of found) {
      const inside = call.slice(call.indexOf('(') + 1, -1);
      assert.ok(inside.trim() !== '', `${call} passes no token at all`);
      if (args === 2) {
        assert.ok(inside.indexOf(',') !== -1, `${call} passes slots but no token`);
      }
    }
  }
});

/* --- the guard ------------------------------------------------------------ */

s.test('no unhandled promise rejection escaped this suite (§2.3)', async () => {
  await drain();
  await drain();
  await drain();
  if (unhandled.length) {
    throw new Error(
      `${unhandled.length} unhandled rejection(s):\n` + unhandled.map((u) => '  ' + u.reason).join('\n')
    );
  }
});

module.exports = { loadAppSandbox };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
