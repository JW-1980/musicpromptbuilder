'use strict';
/*
 * tests/local-llm.test.js — the on-device LLM tier (Mode 1b).
 *
 * WHAT IS COVERED
 *   - pickModelVariant: a PURE function, driven against faked capability
 *     objects. Choosing the wrong quantization costs the user a ~500 MB
 *     download twice, so the choice is tested rather than trusted.
 *   - probeWebGpu: always resolves, for every way a browser can say no.
 *   - LOCAL_MODEL_SOURCES: the runtime entry is really pinned, and the byte
 *     counts the consent card prints are real numbers, not placeholders.
 *   - createLocalLlmEngine's CONSENT GATE. The central claim of this feature
 *     is "nothing is downloaded until you click". It is tested the only way
 *     that claim can be tested: with an injected fetch recorder and an
 *     injected worker factory, asserting BOTH counters are still zero.
 *   - The quota refusal, the persistence warning, the manifest, remove().
 *   - The #ai-worker-src protocol on a node:vm sandbox, including the
 *     integrity gate REFUSING a tampered payload — the one behaviour that
 *     makes fetching third-party code acceptable at all.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Any real download, import or inference. Those need a network and half a
 *     gigabyte; the offline-first test policy forbids the first and common
 *     sense the second. Every network path here runs against a fake, which is
 *     exactly why the engine and the worker both take their inputs by
 *     injection or by message.
 *
 * Node built-ins only: path, assert, vm, crypto.
 */

const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* -------------------------------------------------------------------------- */
/* Unhandled-rejection guard                                                  */
/* -------------------------------------------------------------------------- */

const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push({ reason: (reason && reason.stack) || String(reason) });
});

/* -------------------------------------------------------------------------- */
/* Sandboxes                                                                  */
/* -------------------------------------------------------------------------- */

/** A recording localStorage stand-in, so "nothing was persisted" is provable. */
function makeRecordingStorage() {
  const writes = [];
  const store = new Map();
  return {
    writes,
    api: {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem(k, v) {
        writes.push({ key: String(k), value: String(v) });
        store.set(String(k), String(v));
      },
      removeItem: (k) => store.delete(String(k)),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
    },
  };
}

function loadAppSandbox() {
  const source = extractScriptById(INDEX, 'app-main');
  const local = makeRecordingStorage();
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Promise,
    URL,
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
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    localStorage: local.api,
    sessionStorage: makeRecordingStorage().api,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'index.html#app-main' });
  return { sandbox, source, storage: local, evaluate: (e) => vm.runInContext(e, sandbox, { filename: 'eval' }) };
}

const app = loadAppSandbox();
const {
  LOCAL_MODEL_SOURCES,
  pickModelVariant,
  probeWebGpu,
  createLocalLlmEngine,
  createIdbStore,
  localModelIds,
  formatBytes,
  IDB_MODEL_CACHE,
  LOCAL_LLM_MANIFEST_ID,
  LOCAL_LLM_MAX_TOKENS,
  LOCAL_LLM_TIMEOUT_MS,
} = app.sandbox;

/** Copy a sandbox value into this realm so deepStrictEqual can see it. */
function host(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait for the worker to post something matching `predicate`, draining the
 * queue between checks.
 *
 * A FIXED number of drain() calls is a race, and it lost one: the init chain
 * is a dozen promises deep, one of them a dynamic import that rejects on its
 * own schedule, and under the load of a full nightly run a fixed count can
 * come up a turn short. Polling for the CONDITION is faster in the normal case
 * and immune to that.
 */
async function waitFor(worker, predicate, label) {
  for (let turn = 0; turn < 500; turn += 1) {
    const hits = worker.replies.filter(predicate);
    if (hits.length) return hits;
    await drain();
  }
  throw new Error('timed out waiting for ' + label + '; saw: ' + JSON.stringify(worker.replies));
}

/** Every error the worker has posted so far, once at least one has arrived. */
function waitForError(worker, label) {
  return waitFor(worker, (r) => r.type === 'error', label || 'an error reply');
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A navigator with exactly the capabilities a test wants it to have. */
function makeNavigator(options) {
  const opts = options || {};
  const nav = {};
  if (opts.gpu !== undefined) nav.gpu = opts.gpu;
  if (opts.storage !== undefined) nav.storage = opts.storage;
  return nav;
}

function makeAdapter(features) {
  return {
    features: {
      forEach(fn) {
        (features || []).forEach(fn);
      },
    },
  };
}

/** A fetch that records every call and, by default, is never allowed to run. */
function makeFetchRecorder() {
  const calls = [];
  const fn = function (url, options) {
    calls.push({ url, options });
    return Promise.reject(new Error('this test forbids network access'));
  };
  fn.calls = calls;
  return fn;
}

/**
 * A Worker stand-in. Records what it was told and lets the test play the
 * worker's part by pushing messages back.
 */
function makeWorkerFake() {
  const posted = [];
  const handlers = { message: [], error: [] };
  const handle = {
    posted,
    terminated: 0,
    postMessage(message) {
      posted.push(message);
    },
    terminate() {
      handle.terminated += 1;
    },
    addEventListener(name, fn) {
      if (handlers[name]) handlers[name].push(fn);
    },
    /** Play the worker: deliver one message to the engine. */
    emit(data) {
      for (const fn of handlers.message) fn({ data });
    },
  };
  return handle;
}

function makeSpawnFake() {
  const workers = [];
  const spawn = function (options) {
    const worker = makeWorkerFake();
    worker.spawnOptions = options;
    workers.push(worker);
    return worker;
  };
  spawn.workers = workers;
  return spawn;
}

/**
 * The browser capabilities the engine feature-detects on. Declared explicitly
 * rather than faked onto a global: this object IS the test's statement of
 * which browser it is standing in for.
 */
function makeEnvironment(overrides) {
  const base = {
    Worker: function Worker() {},
    WebAssembly: {},
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    crypto: webcrypto,
  };
  if (!overrides) return base;
  return Object.assign(base, overrides);
}

/** A live in-memory createIdbStore — real copy()/rawStore semantics, no DB. */
function makeStore() {
  return createIdbStore({ indexedDB: null });
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

const s = suite('local-llm (Mode 1b: registry, variant picker, engine, worker)');

/* --- the registry --------------------------------------------------------- */

s.test('every Mode 1b factory is a reachable top-level declaration', () => {
  for (const name of ['pickModelVariant', 'probeWebGpu', 'createLocalLlmEngine', 'localModelIds', 'formatBytes']) {
    assert.strictEqual(typeof app.sandbox[name], 'function', `${name} is not a top-level function`);
  }
  assert.strictEqual(typeof LOCAL_MODEL_SOURCES, 'object');
});

s.test('LOCAL_MODEL_SOURCES pins the runtime and declares real asset sizes', () => {
  const runtime = LOCAL_MODEL_SOURCES.runtime;
  assert.strictEqual(runtime.kind, 'code');
  assert.ok(/^https:\/\//.test(runtime.url), `runtime url: ${runtime.url}`);
  // The pin is what makes runtime-fetched CODE acceptable. A base64 SHA-256
  // digest is 44 characters; anything shorter is not one.
  assert.ok(/^sha256-[A-Za-z0-9+/]{43}=$/.test(runtime.integrity), `integrity: ${runtime.integrity}`);
  assert.ok(runtime.bytes > 100000, `a ~1 MB runtime cannot be ${runtime.bytes} bytes`);

  assert.strictEqual(LOCAL_MODEL_SOURCES.wasm.kind, 'binary');
  assert.ok(/\/$/.test(LOCAL_MODEL_SOURCES.wasm.baseUrl), 'wasmPaths must end in a slash to resolve against');

  const weights = LOCAL_MODEL_SOURCES.weights;
  assert.strictEqual(weights.kind, 'weights');
  assert.ok(/^https:\/\//.test(weights.host));
  assert.ok(Object.prototype.hasOwnProperty.call(weights.models, weights.defaultModelId));
});

s.test('both FDD-named models are offered, each with a GPU and a CPU variant', () => {
  const ids = host(localModelIds());
  assert.deepStrictEqual(ids, ['qwen2.5-0.5b', 'smollm2-360m']);
  assert.strictEqual(LOCAL_MODEL_SOURCES.weights.defaultModelId, 'qwen2.5-0.5b', 'the stronger model is the default');

  for (const id of ids) {
    const model = LOCAL_MODEL_SOURCES.weights.models[id];
    assert.ok(model.label && model.repo && model.note, `${id}: incomplete entry`);
    assert.ok(/^[\w.-]+\/[\w.-]+$/.test(model.repo), `${id}: "${model.repo}" is not an owner/name repo id`);
    for (const key of ['q4f16', 'int8']) {
      const variant = model.variants[key];
      assert.ok(variant, `${id}: no ${key} variant`);
      assert.ok(variant.bytes > 1e8, `${id}.${key}: ${variant.bytes} bytes is not a real model`);
      assert.ok(variant.label && variant.dtype && variant.device, `${id}.${key}: incomplete`);
    }
    // The lighter model must actually be lighter, or the picker is a lie.
    assert.ok(
      model.variants.q4f16.bytes < model.variants.int8.bytes,
      `${id}: the 4-bit build is not smaller than the 8-bit one`
    );
  }
  const qwen = LOCAL_MODEL_SOURCES.weights.models['qwen2.5-0.5b'];
  const smol = LOCAL_MODEL_SOURCES.weights.models['smollm2-360m'];
  assert.ok(
    smol.variants.q4f16.bytes < qwen.variants.q4f16.bytes,
    'the "lighter option" must be the smaller download'
  );
});

/* --- the variant picker --------------------------------------------------- */

s.test('pickModelVariant takes q4f16/WebGPU ONLY when shader-f16 is reported', () => {
  const withF16 = pickModelVariant({ webgpu: true, features: ['shader-f16', 'timestamp-query'] });
  assert.strictEqual(withF16.dtype, 'q4f16');
  assert.strictEqual(withF16.device, 'webgpu');
  assert.strictEqual(withF16.bytes, LOCAL_MODEL_SOURCES.weights.models['qwen2.5-0.5b'].variants.q4f16.bytes);
  assert.ok(/shader-f16/.test(withF16.reason), withF16.reason);
});

s.test('pickModelVariant falls back to int8/WASM for every "no" a browser can give', () => {
  const cases = [
    ['no caps at all', undefined],
    ['null caps', null],
    ['WebGPU present, no features enumerated', { webgpu: true, features: [] }],
    ['WebGPU present without shader-f16', { webgpu: true, features: ['timestamp-query'] }],
    // The dangerous one: a features list that LOOKS right on a machine that
    // never granted an adapter. Both halves must hold, not either.
    ['shader-f16 claimed but no adapter', { webgpu: false, features: ['shader-f16'] }],
    ['garbage features', { webgpu: true, features: 'shader-f16' }],
  ];
  for (const [label, caps] of cases) {
    const pick = pickModelVariant(caps);
    assert.strictEqual(pick.dtype, 'int8', `${label}: chose ${pick.dtype}`);
    assert.strictEqual(pick.device, 'wasm', `${label}: chose ${pick.device}`);
  }
});

s.test('pickModelVariant honours the model id, and refuses an unknown one honestly', () => {
  const smol = pickModelVariant({ webgpu: true, features: ['shader-f16'] }, 'smollm2-360m');
  assert.strictEqual(smol.modelId, 'smollm2-360m');
  assert.strictEqual(smol.repo, 'HuggingFaceTB/SmolLM2-360M-Instruct');

  // An unknown id falls back to the default rather than throwing or, worse,
  // producing a variant with an undefined repo that would 404 mid-download.
  for (const bogus of ['llama-405b', '', null, 42, {}]) {
    const pick = pickModelVariant({}, bogus);
    assert.strictEqual(pick.modelId, LOCAL_MODEL_SOURCES.weights.defaultModelId, `"${bogus}" was not rejected`);
    assert.ok(pick.repo, 'a fallback variant with no repo would 404 at download time');
  }
});

s.test('pickModelVariant is pure: it touches no network and no globals it does not own', () => {
  const before = app.storage.writes.length;
  for (let i = 0; i < 50; i += 1) pickModelVariant({ webgpu: i % 2 === 0, features: ['shader-f16'] });
  assert.strictEqual(app.storage.writes.length, before);
  // Same input, same answer, every time.
  const a = host(pickModelVariant({ webgpu: true, features: ['shader-f16'] }));
  const b = host(pickModelVariant({ webgpu: true, features: ['shader-f16'] }));
  assert.deepStrictEqual(a, b);
});

/* --- the capability probe -------------------------------------------------- */

s.test('probeWebGpu always resolves, and says why, for every kind of "no"', async () => {
  const cases = [
    ['no navigator', null, /no WebGPU adapter/],
    ['no gpu object', makeNavigator({}), /no WebGPU adapter/],
    ['gpu without requestAdapter', makeNavigator({ gpu: {} }), /no WebGPU adapter/],
    [
      'requestAdapter throws',
      makeNavigator({
        gpu: {
          requestAdapter() {
            throw new Error('denied');
          },
        },
      }),
      /threw: denied/,
    ],
    [
      'requestAdapter returns a non-promise',
      makeNavigator({ gpu: { requestAdapter: () => 'nope' } }),
      /did not return a promise/,
    ],
    [
      'requestAdapter rejects',
      makeNavigator({ gpu: { requestAdapter: () => Promise.reject(new Error('gpu process gone')) } }),
      /request failed: gpu process gone/,
    ],
    ['no adapter granted', makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }), /no adapter/],
  ];
  for (const [label, nav, expected] of cases) {
    const caps = await probeWebGpu(nav);
    assert.strictEqual(caps.webgpu, false, `${label}: claimed WebGPU`);
    assert.strictEqual(caps.shaderF16, false, `${label}: claimed shader-f16`);
    assert.ok(expected.test(caps.reason), `${label}: reason was "${caps.reason}"`);
    // And the picker must survive whatever the probe produced.
    assert.strictEqual(pickModelVariant(caps).device, 'wasm', `${label}: picked a GPU build anyway`);
  }
});

s.test('probeWebGpu reports the features an adapter really has', async () => {
  const withF16 = await probeWebGpu(
    makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(makeAdapter(['shader-f16', 'depth-clip-control'])) } })
  );
  assert.strictEqual(withF16.webgpu, true);
  assert.strictEqual(withF16.shaderF16, true);
  assert.deepStrictEqual(host(withF16.features), ['shader-f16', 'depth-clip-control']);
  assert.strictEqual(pickModelVariant(withF16).device, 'webgpu');

  const without = await probeWebGpu(
    makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(makeAdapter(['depth-clip-control'])) } })
  );
  assert.strictEqual(without.webgpu, true);
  assert.strictEqual(without.shaderF16, false);
  assert.strictEqual(pickModelVariant(without).device, 'wasm');
});

s.test('an adapter that refuses to enumerate its features is treated as a CPU adapter', async () => {
  const caps = await probeWebGpu(
    makeNavigator({
      gpu: {
        requestAdapter: () =>
          Promise.resolve({
            get features() {
              throw new Error('sealed');
            },
          }),
      },
    })
  );
  assert.strictEqual(caps.webgpu, true);
  assert.strictEqual(caps.shaderF16, false);
  assert.strictEqual(pickModelVariant(caps).dtype, 'int8');
});

/* --- THE CONSENT GATE ------------------------------------------------------ */

s.test('THE GATE: without consent the engine fetches nothing and spawns nothing', async () => {
  const fetchFn = makeFetchRecorder();
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    fetchFn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(makeAdapter(['shader-f16'])) } }),
  });

  assert.strictEqual(engine.status(), 'absent', 'a fresh engine must not claim readiness');

  // Everything a caller can do short of consenting.
  await engine.refresh();
  const outcome = await engine.ensureReady({});
  await engine.ensureReady({ consent: false });
  await engine.ensureReady({ modelId: 'smollm2-360m' });
  const generated = await engine.generate({ promptText: 'techno' });

  assert.strictEqual(outcome.ready, false);
  assert.strictEqual(outcome.reason, 'not-downloaded');
  assert.strictEqual(generated.ok, false);
  assert.strictEqual(generated.configured, false, 'the chain must read this as never-attempted');

  assert.strictEqual(fetchFn.calls.length, 0, `${fetchFn.calls.length} network call(s) without consent`);
  assert.strictEqual(spawn.workers.length, 0, `${spawn.workers.length} worker(s) spawned without consent`);
  assert.strictEqual(engine.status(), 'absent');
});

s.test('WITH consent the worker is spawned once and told exactly what to fetch', async () => {
  const fetchFn = makeFetchRecorder();
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    fetchFn,
    storage: makeStore(),
    navigator: makeNavigator({
      gpu: { requestAdapter: () => Promise.resolve(makeAdapter(['shader-f16'])) },
      storage: { estimate: () => Promise.resolve({ quota: 5e9, usage: 1e8 }), persist: () => Promise.resolve(true) },
    }),
  });

  const pending = engine.ensureReady({ consent: true });
  await drain();
  await drain();

  assert.strictEqual(spawn.workers.length, 1);
  const worker = spawn.workers[0];
  const init = worker.posted[0];
  assert.strictEqual(init.type, 'init');
  assert.strictEqual(init.sources.runtime.integrity, LOCAL_MODEL_SOURCES.runtime.integrity);
  assert.strictEqual(init.variant.dtype, 'q4f16', 'the probe ran BEFORE the choice');
  assert.strictEqual(init.variant.device, 'webgpu');
  assert.strictEqual(engine.status(), 'downloading');

  // The main thread still made no request of its own: the worker owns that.
  assert.strictEqual(fetchFn.calls.length, 0);
  // …and it was handed the injected fetch, which is what lets a test double
  // stand in for the worker and prove the same claim end to end.
  assert.strictEqual(worker.spawnOptions.fetchFn, fetchFn);

  worker.emit({ type: 'ready', device: 'webgpu', dtype: 'q4f16', ms: 4200 });
  const outcome = await pending;
  assert.strictEqual(outcome.ready, true);
  assert.strictEqual(outcome.ms, 4200);
  assert.strictEqual(engine.status(), 'ready');
});

s.test('a manifest is written on success, and status() reads it back offline', async () => {
  const store = makeStore();
  const spawn = makeSpawnFake();
  const nav = makeNavigator({
    gpu: { requestAdapter: () => Promise.resolve(null) },
    storage: { estimate: () => Promise.resolve({ quota: 5e9, usage: 0 }), persist: () => Promise.resolve(true) },
  });

  const first = createLocalLlmEngine({ environment: makeEnvironment(), spawn, storage: store, navigator: nav });
  const pending = first.ensureReady({ consent: true, modelId: 'smollm2-360m' });
  await drain();
  await drain();
  spawn.workers[0].emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 900 });
  await pending;

  const manifest = await store.get(IDB_MODEL_CACHE, LOCAL_LLM_MANIFEST_ID);
  assert.ok(manifest, 'no manifest record was written');
  assert.strictEqual(manifest.modelId, 'smollm2-360m');
  assert.strictEqual(manifest.dtype, 'int8');
  assert.ok(manifest.consentedAt > 0, 'the manifest must record that consent happened');

  // A SECOND engine over the same storage — a page reload. It must know the
  // model is downloaded WITHOUT a network call and without a second consent.
  const fetchFn = makeFetchRecorder();
  const spawn2 = makeSpawnFake();
  const reloaded = createLocalLlmEngine({ environment: makeEnvironment(), spawn: spawn2, fetchFn, storage: store, navigator: nav });
  assert.strictEqual(reloaded.status(), 'absent', 'status is absent until the manifest is read');
  const status = await reloaded.refresh();
  assert.strictEqual(status, 'ready');
  assert.strictEqual(reloaded.modelId(), 'smollm2-360m', 'the remembered model, not the default');
  assert.strictEqual(fetchFn.calls.length, 0, 'refresh() must never touch the network');
  assert.strictEqual(spawn2.workers.length, 0, 'refresh() must not spawn a worker either');
});

s.test('a short quota is refused honestly, before anything is spawned', async () => {
  const fetchFn = makeFetchRecorder();
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    fetchFn,
    storage: makeStore(),
    navigator: makeNavigator({
      gpu: { requestAdapter: () => Promise.resolve(null) },
      // 300 MB free against a ~512 MB model plus 20% headroom.
      storage: { estimate: () => Promise.resolve({ quota: 1e9, usage: 7e8 }), persist: () => Promise.resolve(true) },
    }),
  });

  const outcome = await engine.ensureReady({ consent: true });
  assert.strictEqual(outcome.ready, false);
  assert.strictEqual(outcome.reason, 'quota');
  assert.ok(/free storage/.test(outcome.detail), outcome.detail);
  assert.ok(/nothing was downloaded/.test(outcome.detail), outcome.detail);
  assert.strictEqual(spawn.workers.length, 0, 'a refused download must not spawn a worker');
  assert.strictEqual(fetchFn.calls.length, 0);
});

s.test('an unknown quota is not a refusal — some browsers simply do not answer', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  engine.ensureReady({ consent: true });
  await drain();
  await drain();
  assert.strictEqual(spawn.workers.length, 1, 'a missing estimate() must not block the download');
});

s.test('a refused persist() is reported as an eviction risk, not swallowed', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({
      gpu: { requestAdapter: () => Promise.resolve(null) },
      storage: { estimate: () => Promise.resolve({ quota: 5e9, usage: 0 }), persist: () => Promise.resolve(false) },
    }),
  });
  const pending = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  spawn.workers[0].emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 10 });
  const outcome = await pending;
  assert.strictEqual(outcome.ready, true);
  assert.strictEqual(outcome.persisted, false);
  assert.strictEqual(outcome.persistenceKnown, true, 'the UI needs to know this was a real "no"');
});

s.test('an unsupported context says so once and never pretends otherwise', async () => {
  const engine = createLocalLlmEngine({ spawn: null, storage: makeStore(), navigator: null });
  assert.strictEqual(engine.status(), 'unsupported');
  assert.ok(engine.statusDetail().length > 0, 'unsupported must come with a reason');

  const outcome = await engine.ensureReady({ consent: true });
  assert.strictEqual(outcome.ready, false);
  assert.strictEqual(outcome.reason, 'unsupported');
  const generated = await engine.generate({ promptText: 'techno' });
  assert.strictEqual(generated.ok, false);
  assert.strictEqual(engine.status(), 'unsupported', 'consent cannot make an unsupported browser supported');
});

/* --- generation, progress, teardown ---------------------------------------- */

s.test('generate() carries the §7.1 budget and resolves with the worker reply', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  const ready = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  const worker = spawn.workers[0];
  worker.emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 10 });
  await ready;

  const pending = engine.generate({ promptText: 'PROMPT' });
  await drain();
  const request = worker.posted[worker.posted.length - 1];
  assert.strictEqual(request.type, 'generate');
  assert.strictEqual(request.promptText, 'PROMPT');
  assert.strictEqual(request.maxNewTokens, LOCAL_LLM_MAX_TOKENS);
  assert.strictEqual(request.deadlineMs, LOCAL_LLM_TIMEOUT_MS);

  worker.emit({ type: 'reply', id: request.id, text: '{"ok":1}', ms: 1200 });
  const outcome = await pending;
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.text, '{"ok":1}');
});

s.test('a timeout from the worker is classified retryable; a bad prompt is not', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  const ready = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  const worker = spawn.workers[0];
  worker.emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 10 });
  await ready;

  const cases = [
    ['timeout', 'ran past its deadline', true],
    ['generate', 'WebGPU out of memory', true],
    ['prompt', 'the chat template could not be applied', false],
  ];
  for (const [stage, message, retryable] of cases) {
    const pending = engine.generate({ promptText: 'x' });
    await drain();
    const request = worker.posted[worker.posted.length - 1];
    worker.emit({ type: 'error', id: request.id, stage, message });
    const outcome = await pending;
    assert.strictEqual(outcome.ok, false, `${stage}: expected a failure`);
    assert.strictEqual(outcome.retryable, retryable, `${stage}: retryable was ${outcome.retryable}`);
    assert.strictEqual(outcome.error, message);
  }
});

s.test('progress events reach a listener verbatim, and unsubscribing works', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  const seen = [];
  const off = engine.on('progress', (update) => seen.push(update));
  engine.ensureReady({ consent: true });
  await drain();
  await drain();

  const worker = spawn.workers[0];
  worker.emit({ type: 'progress', phase: 'runtime', file: 'inference runtime', loaded: 5000, total: 888173 });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].phase, 'runtime');
  assert.strictEqual(seen[0].loaded, 5000);
  assert.strictEqual(engine.lastProgress().total, 888173);

  off();
  worker.emit({ type: 'progress', phase: 'weights', loaded: 1, total: 2 });
  assert.strictEqual(seen.length, 1, 'the listener was not removed');
});

s.test('a listener that throws cannot break the engine', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  engine.on('progress', () => {
    throw new Error('listener exploded');
  });
  const pending = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  spawn.workers[0].emit({ type: 'progress', phase: 'runtime', loaded: 1, total: 2 });
  spawn.workers[0].emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 5 });
  const outcome = await pending;
  assert.strictEqual(outcome.ready, true);
});

s.test('remove() terminates the worker, clears the cache and returns to absent', async () => {
  const store = makeStore();
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: store,
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  const ready = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  spawn.workers[0].emit({ type: 'ready', device: 'wasm', dtype: 'int8', ms: 10 });
  await ready;
  assert.strictEqual(engine.status(), 'ready');

  const outcome = await engine.remove();
  assert.strictEqual(outcome.removed, true);
  assert.strictEqual(engine.status(), 'absent');
  assert.strictEqual(spawn.workers[0].terminated, 1, 'the worker must actually be terminated');
  assert.strictEqual(await store.get(IDB_MODEL_CACHE, LOCAL_LLM_MANIFEST_ID), null, 'the manifest survived remove()');

  // And the next use asks for consent again, exactly as if it never happened.
  const after = await engine.ensureReady({});
  assert.strictEqual(after.reason, 'not-downloaded');
});

s.test('a worker error during load fails honestly instead of hanging', async () => {
  const spawn = makeSpawnFake();
  const engine = createLocalLlmEngine({
    environment: makeEnvironment(),
    spawn,
    storage: makeStore(),
    navigator: makeNavigator({ gpu: { requestAdapter: () => Promise.resolve(null) } }),
  });
  const pending = engine.ensureReady({ consent: true });
  await drain();
  await drain();
  spawn.workers[0].emit({
    type: 'error',
    stage: 'integrity',
    message: 'the downloaded runtime does not match its pinned digest',
  });
  const outcome = await pending;
  assert.strictEqual(outcome.ready, false);
  assert.strictEqual(outcome.reason, 'failed');
  assert.ok(/pinned digest/.test(outcome.detail), outcome.detail);
  assert.strictEqual(engine.status(), 'failed');
});

s.test('formatBytes prints sizes a person can compare against their disk', () => {
  assert.strictEqual(formatBytes(483003582), '483 MB');
  assert.strictEqual(formatBytes(888173), '888 KB');
  assert.strictEqual(formatBytes(2.4e9), '2.4 GB');
  assert.strictEqual(formatBytes(0), '0 bytes');
  assert.strictEqual(formatBytes(-1), '0 bytes');
  assert.strictEqual(formatBytes(undefined), '0 bytes');
});

/* --- the worker protocol, on a node:vm sandbox ----------------------------- */

/**
 * Load #ai-worker-src into a sandbox with exactly the browser surface it uses.
 * `fetchPlan(url)` decides what bytes come back, so the integrity gate can be
 * driven with both a matching and a tampered payload.
 */
function loadAiWorker(fetchPlan) {
  const source = extractScriptById(INDEX, 'ai-worker-src');
  const replies = [];
  const fetchCalls = [];

  const self = {
    postMessage: (payload) => replies.push(payload),
    onmessage: null,
    btoa: (binary) => Buffer.from(binary, 'binary').toString('base64'),
  };

  const sandbox = {
    self,
    console,
    Math,
    Date,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    Uint8Array,
    ArrayBuffer,
    isFinite,
    isNaN,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    URL: {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: () => {},
    },
    Blob: function Blob() {},
    Response: function Response() {},
    indexedDB: null,
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return Promise.resolve(fetchPlan(url));
    },
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'index.html#ai-worker-src' });

  return {
    sandbox,
    replies,
    fetchCalls,
    send(message) {
      sandbox.self.onmessage({ data: message });
    },
    evaluate: (expression) => vm.runInContext(expression, sandbox, { filename: 'ai-worker#evaluate' }),
  };
}

/** A Response-alike carrying `bytes`, with no streaming body. */
function bodylessResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-length' ? String(bytes.length) : null) },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

/** The registry the worker is initialised with, with a digest we control. */
function sourcesWithIntegrity(integrity) {
  return {
    runtime: { kind: 'code', url: 'https://cdn.example.com/runtime.js', integrity, bytes: 4 },
    wasm: { kind: 'binary', baseUrl: 'https://cdn.example.com/' },
    weights: { kind: 'weights', host: 'https://models.example.com/' },
  };
}

async function digestOf(bytes) {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + Buffer.from(digest).toString('base64');
}

s.test('the worker declares the SAME database contract as #app-main', () => {
  // Two independent openers of one database. A version skew here would make
  // every transaction from the other thread fail with a VersionError.
  assert.strictEqual(app.evaluate('IDB_NAME'), loadAiWorker(() => null).evaluate('AI_IDB_NAME'));
  assert.strictEqual(app.evaluate('IDB_VERSION'), loadAiWorker(() => null).evaluate('AI_IDB_VERSION'));
  assert.strictEqual(app.evaluate('IDB_MODEL_CACHE'), loadAiWorker(() => null).evaluate('AI_IDB_MODEL_CACHE'));
  assert.deepStrictEqual(
    host(app.evaluate('IDB_STORES')),
    host(loadAiWorker(() => null).evaluate('AI_IDB_STORES')),
    'the worker would create a different schema than #app-main expects'
  );
  // The sampling contract is mirrored too, and must not drift.
  const worker = loadAiWorker(() => null);
  assert.strictEqual(worker.evaluate('AI_TEMPERATURE'), app.evaluate('DISSECTOR_TEMPERATURE'));
  assert.strictEqual(worker.evaluate('AI_TOP_K'), app.evaluate('DISSECTOR_TOP_K'));
  assert.strictEqual(worker.evaluate('AI_MAX_NEW_TOKENS'), LOCAL_LLM_MAX_TOKENS);
  assert.strictEqual(worker.evaluate('AI_DEADLINE_MS'), LOCAL_LLM_TIMEOUT_MS);
});

s.test('the worker fetches NOTHING until it is told to init', async () => {
  const worker = loadAiWorker(() => bodylessResponse(new Uint8Array([1, 2, 3, 4])));
  await drain();
  assert.strictEqual(worker.fetchCalls.length, 0, 'the worker made a request just by being loaded');
  worker.send({ type: 'cancel', id: 'nope' });
  worker.send({ type: 'dispose' });
  assert.strictEqual(worker.fetchCalls.length, 0);
});

s.test('THE INTEGRITY GATE: a tampered runtime is refused and never executed', async () => {
  const tampered = new Uint8Array([9, 9, 9, 9]);
  const worker = loadAiWorker(() => bodylessResponse(tampered));
  // A digest for DIFFERENT bytes: exactly what a swapped CDN payload looks like.
  const honest = await digestOf(new Uint8Array([1, 2, 3, 4]));

  worker.send({ type: 'init', sources: sourcesWithIntegrity(honest), variant: { repo: 'x/y', dtype: 'int8', device: 'wasm' } });
  const errors = await waitFor(worker, (r) => r.type === 'error', 'the refusal');
  assert.strictEqual(errors.length, 1, `expected one refusal, saw: ${JSON.stringify(worker.replies)}`);
  assert.strictEqual(errors[0].stage, 'integrity', 'the refusal must be attributed to the digest check');
  assert.ok(/does not match its pinned digest/.test(errors[0].message), errors[0].message);
  assert.ok(/was NOT executed/.test(errors[0].message), 'the message must say the code did not run');
  // Both digests are named, so the failure is diagnosable rather than mystical.
  assert.ok(errors[0].message.indexOf(honest.slice(7)) !== -1, 'the expected digest is not in the message');
  // Nothing claimed readiness.
  assert.strictEqual(worker.replies.filter((r) => r.type === 'ready').length, 0);
});

s.test('THE INTEGRITY GATE: matching bytes pass the digest and reach the import step', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const worker = loadAiWorker(() => bodylessResponse(bytes));
  const matching = await digestOf(bytes);

  worker.send({ type: 'init', sources: sourcesWithIntegrity(matching), variant: { repo: 'x/y', dtype: 'int8', device: 'wasm' } });
  const errors = await waitForError(worker);
  assert.strictEqual(errors.length, 1);
  // node:vm cannot run a dynamic import, so the import itself fails — which is
  // the point: the run reached IMPORT, so the digest check passed. A stage of
  // 'integrity' here would mean matching bytes were rejected.
  assert.strictEqual(errors[0].stage, 'import', `stopped at "${errors[0].stage}": ${errors[0].message}`);
  assert.ok(/could not be imported/.test(errors[0].message), errors[0].message);
});

/* --- the import ladder ----------------------------------------------------- */

/*
 * THE REGRESSION THESE GUARD. Rung 2 used to be `import(url)` — a raw dynamic
 * import of the pinned CDN URL, taken whenever the blob: import failed. A
 * second GET can return a different body than the one the digest was taken
 * over, so that rung executed bytes NOBODY VERIFIED, contradicting both the
 * worker's own "nothing executes on mismatch" promise and the download card's
 * "checked against a digest … before they are allowed to run".
 *
 * The ladder is now pure data (buildRuntimeImportCandidates), which is what
 * makes the decisive assertion a cheap one: no rung is a network URL.
 */

/** Bytes that exercise the full 0..255 range and cross the base64 chunk size. */
function ladderBytes(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7 + 13) % 256;
  return out;
}

s.test('the import ladder is pure, and both rungs carry the SAME verified bytes', () => {
  const worker = loadAiWorker(() => null);
  // 100 000 bytes: past the 32 Ki base64 chunk, so a broken chunk boundary
  // shows up here rather than in a browser at 1 MB.
  const bytes = ladderBytes(100000);
  worker.sandbox.__verified = bytes;
  const candidates = worker.evaluate('buildRuntimeImportCandidates(__verified)');

  assert.strictEqual(candidates.length, 2, 'the ladder must have exactly two rungs');
  // Compared one by one rather than with deepStrictEqual: these arrays come
  // from the vm realm and would fail a prototype check for the wrong reason.
  assert.strictEqual(candidates[0].kind, 'blob', 'blob: must be the first rung — cheapest, no copy');
  assert.strictEqual(candidates[1].kind, 'data', 'data: must be the second rung');

  // Rung 1 hands the very same buffer on — not a copy, not a re-read.
  assert.strictEqual(candidates[0].bytes, bytes, 'the blob rung does not carry the verified bytes');
  assert.strictEqual(candidates[1].bytes, bytes, 'the data rung does not carry the verified bytes');

  // Rung 2's payload round-trips byte for byte. If this fails, the data:
  // module would execute something OTHER than what was digested.
  const decoded = new Uint8Array(Buffer.from(candidates[1].base64, 'base64'));
  assert.strictEqual(decoded.length, bytes.length, 'the base64 payload changed length');
  assert.ok(Buffer.from(decoded).equals(Buffer.from(bytes)), 'the base64 payload is not the verified bytes');
});

s.test('NO rung of the import ladder is a network URL', () => {
  const worker = loadAiWorker(() => null);
  worker.sandbox.__verified = ladderBytes(64);
  const candidates = worker.evaluate('buildRuntimeImportCandidates(__verified)');

  for (const candidate of candidates) {
    // Everything except the byte payload itself, which is binary and may hold
    // any sequence at all.
    const described = JSON.stringify({
      kind: candidate.kind,
      label: candidate.label,
      mime: candidate.mime,
      url: candidate.url === undefined ? null : candidate.url,
      base64: candidate.base64 === undefined ? null : candidate.base64.slice(0, 0),
    });
    assert.strictEqual(described.indexOf('http'), -1, `a candidate names a network URL: ${described}`);
    assert.strictEqual(described.indexOf('//'), -1, `a candidate names a network URL: ${described}`);
  }

  // And the URL each descriptor is actually materialised into.
  worker.sandbox.__candidates = candidates;
  const urls = worker.evaluate(
    '__candidates.map(function (c) { var h = materializeCandidate(c); var u = h.url; h.release(); return u; })'
  );
  assert.strictEqual(urls[0], 'blob:fake', 'the blob rung must mint an object URL');
  assert.ok(/^data:text\/javascript;base64,/.test(urls[1]), `the data rung produced: ${urls[1].slice(0, 40)}`);
  for (const url of urls) {
    assert.strictEqual(/^https?:/.test(url), false, `an import target is a network URL: ${url.slice(0, 60)}`);
  }
});

s.test('rung 3 is an honest terminal error naming both rungs — never a re-download', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const worker = loadAiWorker(() => bodylessResponse(bytes));
  const matching = await digestOf(bytes);

  worker.send({
    type: 'init',
    sources: sourcesWithIntegrity(matching),
    variant: { repo: 'x/y', dtype: 'int8', device: 'wasm' },
  });
  const errors = await waitForError(worker);
  const message = errors[0].message;

  assert.strictEqual(errors[0].stage, 'import', `stopped at "${errors[0].stage}": ${message}`);
  assert.ok(/blob: module/.test(message), `the blob rung is not named: ${message}`);
  assert.ok(/data: module/.test(message), `the data rung is not named: ${message}`);
  assert.ok(/NOT re-fetched/.test(message), `the message must say the URL was not re-fetched: ${message}`);
  assert.strictEqual(message.indexOf('cdn.example.com'), -1, 'the terminal error leaks the pinned URL as a suggestion');

  // THE COUNT THAT MATTERS: one fetch, the verified download. A ladder that
  // fell back to the network would show two.
  assert.strictEqual(
    worker.fetchCalls.length,
    1,
    `the ladder went back to the network: ${JSON.stringify(worker.fetchCalls.map((c) => c.url))}`
  );
  assert.strictEqual(worker.replies.filter((r) => r.type === 'ready').length, 0);
});

s.test('STATIC: no import() in the worker can be handed the remote URL', () => {
  const source = extractScriptById(INDEX, 'ai-worker-src');

  // Exactly one dynamic import in the whole worker, and it is the isolated
  // one-liner whose argument is its own parameter.
  // Comments are scanned too, deliberately: an `import(` spelled out in prose
  // is either a second rung waiting to be uncommented or a comment describing
  // something this worker no longer does. Neither belongs here.
  const bare = source.match(/(?:^|[^\w$.])import\s*\(/g) || [];
  assert.strictEqual(
    bare.length,
    1,
    `${bare.length} occurrences of "import(" in the worker (code AND comments); there must be exactly one`
  );
  assert.ok(
    /function importModule\((\w+)\)\s*\{\s*return import\(\1\);\s*\}/.test(source),
    'importModule is no longer the single, isolated dynamic import'
  );

  // Its declaration plus its ONE call site. `handle.url` can only come from
  // materializeCandidate, which only ever sees a descriptor.
  const importModuleArgs = [...source.matchAll(/importModule\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(
    importModuleArgs,
    ['url', 'handle.url'],
    'importModule gained a call site whose argument is not a materialised candidate'
  );

  // importRuntime no longer even RECEIVES a URL, so there is nothing in scope
  // to re-fetch. Declaration parameter, then the single call site.
  const importRuntimeArgs = [...source.matchAll(/importRuntime\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(
    importRuntimeArgs,
    ['verifiedBuffer', 'buffer'],
    'importRuntime is being handed something besides the verified buffer'
  );

  // The pinned URL is read in exactly one place: the download.
  const urlReads = source.match(/state\.sources\.runtime\.url/g) || [];
  assert.strictEqual(urlReads.length, 1, `the pinned URL is read ${urlReads.length} times; only the fetch may read it`);
  assert.ok(
    /fetchWithProgress\(state\.sources\.runtime\.url/.test(source),
    'the one read of the pinned URL is not the download'
  );
});

s.test('a build with no pinned digest refuses to run the runtime at all', async () => {
  for (const integrity of ['', 'sha256-', undefined, 'trust-me']) {
    const worker = loadAiWorker(() => bodylessResponse(new Uint8Array([1, 2, 3, 4])));
    worker.send({ type: 'init', sources: sourcesWithIntegrity(integrity), variant: { repo: 'x/y' } });
    const errors = await waitForError(worker);
    assert.strictEqual(errors.length, 1, `integrity "${integrity}": expected a refusal`);
    assert.ok(/pins no SHA-256 digest/.test(errors[0].message), errors[0].message);
  }
});

s.test('the worker reports download progress from the response, not from the registry', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const worker = loadAiWorker(() => bodylessResponse(bytes));
  worker.send({
    type: 'init',
    sources: sourcesWithIntegrity('sha256-' + 'A'.repeat(43) + '='),
    variant: { repo: 'x/y' },
  });
  await waitForError(worker);
  const progress = worker.replies.filter((r) => r.type === 'progress');
  assert.ok(progress.length >= 2, `expected a start and an end, saw ${progress.length}`);
  assert.strictEqual(progress[0].phase, 'runtime');
  assert.strictEqual(progress[0].loaded, 0);
  // Content-Length said 4; the registry claimed 4 too, but the header wins.
  assert.strictEqual(progress[0].total, 4);
  assert.strictEqual(progress[progress.length - 1].loaded, 4);
});

s.test('a failed download is reported as a download failure, not as a bad digest', async () => {
  const worker = loadAiWorker(() => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
    body: null,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }));
  worker.send({ type: 'init', sources: sourcesWithIntegrity('sha256-' + 'A'.repeat(43) + '='), variant: { repo: 'x/y' } });
  const errors = await waitForError(worker);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].stage, 'runtime');
  assert.ok(/HTTP 503/.test(errors[0].message), errors[0].message);
});

s.test('generate before init is refused rather than answered', async () => {
  const worker = loadAiWorker(() => null);
  worker.send({ type: 'generate', id: 'g1', promptText: 'techno' });
  const errors = worker.replies.filter((r) => r.type === 'error');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].id, 'g1');
  assert.ok(/not loaded/.test(errors[0].message), errors[0].message);
  assert.strictEqual(worker.replies.filter((r) => r.type === 'reply').length, 0, 'a reply was invented');
});

s.test('an unknown message type is named, and a hostile one cannot kill the pump', () => {
  const worker = loadAiWorker(() => null);
  worker.send({ type: 'nonsense' });
  assert.strictEqual(worker.replies[0].stage, 'protocol');
  assert.ok(/nonsense/.test(worker.replies[0].message));
  // Null, a string and a number must all be survivable.
  worker.send(null);
  worker.send('init');
  worker.send(42);
  assert.strictEqual(worker.replies.length, 1, 'a malformed message produced noise');
});

/* --- the guard ------------------------------------------------------------- */

s.test('no unhandled promise rejection escaped this suite (§2.3)', async () => {
  await drain();
  await drain();
  assert.deepStrictEqual(unhandled, [], `unhandled rejection(s):\n${unhandled.map((u) => u.reason).join('\n')}`);
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
