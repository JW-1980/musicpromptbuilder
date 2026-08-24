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

/** A cloud config that is complete enough to actually be attempted. */
function cloudConfig(overrides) {
  const base = {
    preset: 'groq',
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
  assert.deepStrictEqual(host(DISSECTOR_MODES), ['auto', 'local', 'cloud', 'ollama']);
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

s.test('cloud: the Groq preset shapes the body and the Authorization header', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({ text: 'techno', mode: 'cloud', cloud: cloudConfig({ preset: 'groq', endpoint: '' }) });

  const call = fetchFn.calls[0];
  assert.strictEqual(call.url, CLOUD_API_PRESETS.groq.endpoint);
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
  // ...and the body uses Gemini's own dialect of the §7.1 sampling contract.
  assert.strictEqual(call.body.contents[0].parts[0].text.indexOf('techno') !== -1, true);
  assert.strictEqual(call.body.generationConfig.temperature, 0.1);
  assert.strictEqual(call.body.generationConfig.topK, 10);
  assert.strictEqual(call.body.messages, undefined, 'the OpenAI shape leaked into the Gemini preset');
});

s.test('cloud: a user-typed endpoint overrides the preset default', async () => {
  const fetchFn = makeFetchFake({ status: 200, json: openAiReply(GOOD_REPLY_JSON) });
  const d = createDissector({ fetchFn: fetchFn, timeoutMs: 500 });

  await d.dissect({
    text: 'techno',
    mode: 'cloud',
    cloud: cloudConfig({ preset: 'groq', endpoint: 'http://127.0.0.1:8080/v1/chat/completions' }),
  });
  assert.strictEqual(fetchFn.calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
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

s.test('listModes() describes the four selectable modes in DISSECTOR_MODES order', () => {
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
