'use strict';
/*
 * tests/persistence.test.js — state persistence, virtualization and backup.
 *
 *   docs/FDD.md #21  DOM Virtualization        -> virtualWindow/createVirtualList
 *   docs/FDD.md #74  Local History & Favouriting -> createHistoryRecord + friends
 *   docs/FDD.md #77  Workspace Profiling       -> createProfileStore, DEFAULT_PROFILES
 *   docs/FDD.md #85  Offline-First Storage     -> createIdbStore
 *   docs/FDD.md #86  JSON Preset Backup        -> serializePresetExport/planPresetImport
 *   docs/FDD.md #93  Clipboard JSON Export     -> the same export, copied
 *   over docs/FEATURE-MECHANICS.md §6.2 (profiles in localStorage['suno_profiles'])
 *   and §6.4 (an async vanilla-Promise IndexedDB wrapper for presets and
 *   prompt_history; localStorage strictly for lightweight UI state).
 *
 * THE DOCUMENT CONFLICT THIS SUITE PINS DOWN
 * FDD #74 says the history bank lives "in localStorage"; FEATURE-MECHANICS §6.4
 * says localStorage is reserved for lightweight UI state and mandates an
 * IndexedDB wrapper for `presets` and `prompt_history`. §6.4 wins (it is the
 * mechanics blueprint and the more specific rule), and PROFILES stay in
 * localStorage because §6.2 names the key 'suno_profiles' verbatim. The tests
 * below assert both halves of that resolution rather than leaving it to prose.
 *
 * WHAT IS COVERED
 *   - createIdbStore() driven against a hand-written fake IndexedDB with the
 *     REAL event model (onupgradeneeded/onsuccess/onerror, transactions that
 *     settle on oncomplete), plus the unavailable and open-fails paths;
 *   - serializeWorkspace/restoreWorkspace round-trip identity over REAL
 *     createPromptState/createExclusionState/createStructureState instances,
 *     18 hostile payloads, and the "validate before mutating" guarantee;
 *   - the history rules: FIFO cap, favourite float, search filter;
 *   - the window arithmetic and a real createVirtualList over a fake DOM;
 *   - profiles: seeding, no-reseed, round-trip, SYNCHRONOUS apply, validation;
 *   - the DEFAULT_PROFILES <-> tests/e2e/profiles.json equivalence, using the
 *     very function tests/e2e/nightly.js runs — not a second copy of it;
 *   - export/import shape, counting, collision renaming and the paste path;
 *   - the static markup, id and wiring contracts of the three new cards.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - A real browser IndexedDB, a real clipboard write and a real data: URL
 *     download. Those are browser surfaces; the fake below implements the
 *     specified event model, and tests/e2e/nightly.js carries the honest
 *     pending note about the rest.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');
const nightly = require('./e2e/nightly.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const PROFILES_JSON = path.resolve(__dirname, 'e2e', 'profiles.json');

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

const app = loadAppSandbox();
const {
  createIdbStore,
  createVirtualList,
  virtualWindow,
  sortNewestFirst,
  makeRecordId,
  serializeWorkspace,
  validateWorkspaceSnapshot,
  restoreWorkspace,
  createHistoryRecord,
  sortHistoryRecords,
  filterHistoryRecords,
  capHistoryRecords,
  relativeTimeText,
  validatePresetName,
  uniquePresetName,
  createPresetRecord,
  buildPresetExport,
  serializePresetExport,
  presetBackupFilename,
  planPresetImport,
  validateProfileName,
  normalizeProfile,
  createProfileStore,
  profileFromWorkspace,
  applyProfileToWorkspace,
  createDebouncer,
  createPromptState,
  createExclusionState,
  createStructureState,
  buildFinalPrompt,
  DEFAULT_PROFILES,
  PROFILES_KEY,
  IDB_NAME,
  IDB_VERSION,
  IDB_PRESETS,
  IDB_HISTORY,
  IDB_SESSION,
  IDB_KEYS,
  IDB_DEVICE_KEY,
  IDB_MODEL_CACHE,
  IDB_STORES,
  IDB_RAW_STORES,
  IDB_TS_INDEX,
  AUTOSAVE_ID,
  HISTORY_CAP,
  WORKSPACE_VERSION,
  PRESET_NAME_MAX,
  PRESET_EXPORT_SCHEMA,
  PRESET_EXPORT_VERSION,
  AUTOSAVE_DEBOUNCE_MS,
  VIRTUAL_ROW_HEIGHT,
  VIRTUAL_OVERSCAN_DEFAULT,
  VIRTUAL_LIST_THRESHOLD,
  SLIDER_AXES,
  SLIDER_DEFAULT,
} = app.sandbox;

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return m[1];
}

/**
 * Normalise a value that crossed the vm boundary into THIS realm.
 * `deepStrictEqual` compares prototypes, and an array or object literal built
 * inside a vm context carries that context's intrinsics — so without this every
 * structural comparison fails with "same structure but not reference-equal",
 * which says nothing at all about the code under test. Same helper, same
 * reasoning, as tests/theming.test.js.
 */
function realm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** assert.deepStrictEqual with both sides normalised into this realm first. */
function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(realm(actual), realm(expected), message);
}

/* -------------------------------------------------------------------------- */
/* A hand-written fake IndexedDB with the real event model                    */
/* -------------------------------------------------------------------------- */

/**
 * Faithful enough to be worth testing against:
 *   - open() returns a request and fires onupgradeneeded (synchronously inside
 *     the open task, as the spec does) then onsuccess, both asynchronously;
 *   - every store request is its own object with .result/.error and
 *     onsuccess/onerror, delivered in a later task;
 *   - a transaction fires oncomplete only once every request it issued has
 *     settled — including requests issued from inside an onsuccess handler,
 *     which is exactly what the wrapper's delete() does;
 *   - getAll() returns records in KEY order and index('ts').getAll() in index
 *     order (ascending), so the wrapper's own newest-first sort is what is
 *     really under test;
 *   - a request that throws aborts the transaction.
 *
 * PRE-SEEDING. `options.seed` stands a database up at an EARLIER version with
 * records already in it — the only way to test an upgrade the way a real user
 * meets it, which is with a year of their presets already inside:
 *
 *   makeFakeIndexedDB({ seed: { name: 'sunoprompt', version: 1,
 *                               stores: { presets: [record, …] } } })
 *
 * Every seeded store gets keyPath 'id' and a 'ts' index, because that is what
 * the 0.16.0 (v1) upgrade handler created. Records are cloned on the way in,
 * so the test's own objects cannot be mutated by the store under test.
 */
function makeFakeIndexedDB(options) {
  const opts = options || {};
  /** name -> {version, stores: {name: {keyPath, indexes, data}}} */
  const databases = Object.create(null);
  const log = { opens: 0, upgrades: 0, transactions: 0, closes: 0 };

  function schedule(fn) {
    setTimeout(fn, 0);
  }

  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function orderedKeys(store) {
    return Object.keys(store.data).sort();
  }

  /*
   * The fake's stand-in for IndexedDB's own STRUCTURED CLONE. It used to be a
   * JSON round-trip, which was close enough while every record was plain data
   * — but structured clone carries a CryptoKey and an ArrayBuffer through
   * intact and JSON destroys both, so a JSON-cloning fake would have hidden
   * the exact bug IDB_RAW_STORES exists to prevent.
   */
  function platformClone(value) {
    if (value === undefined || value === null) return value;
    try {
      return structuredClone(value);
    } catch (err) {
      // structuredClone refuses functions and a few exotic values; nothing a
      // record should hold, but a fake must not be the thing that throws.
      return JSON.parse(JSON.stringify(value));
    }
  }

  function makeStoreHandle(storeState, tx) {
    function enqueue(work) {
      if (!tx) throw new Error('this object store handle is upgrade-only');
      return tx.enqueue(work);
    }
    return {
      name: storeState.name,
      keyPath: storeState.keyPath,
      indexNames: {
        contains(name) {
          return Object.prototype.hasOwnProperty.call(storeState.indexes, name);
        },
      },
      createIndex(name, keyPath, params) {
        storeState.indexes[name] = { keyPath, unique: !!(params && params.unique) };
        return { name, keyPath };
      },
      index(name) {
        if (!Object.prototype.hasOwnProperty.call(storeState.indexes, name)) {
          throw new Error(`no index "${name}"`);
        }
        const definition = storeState.indexes[name];
        return {
          name,
          getAll() {
            return enqueue(() =>
              orderedKeys(storeState)
                .map((k) => storeState.data[k])
                .slice()
                .sort((a, b) => {
                  const av = a[definition.keyPath];
                  const bv = b[definition.keyPath];
                  if (av === bv) return String(a[storeState.keyPath]) < String(b[storeState.keyPath]) ? -1 : 1;
                  return av < bv ? -1 : 1;
                })
                .map((r) => platformClone(r))
            );
          },
        };
      },
      put(value) {
        return enqueue(() => {
          const key = value[storeState.keyPath];
          if (key === undefined || key === null) throw new Error('record has no key');
          storeState.data[key] = platformClone(value);
          return key;
        });
      },
      get(key) {
        return enqueue(() => {
          const hit = storeState.data[key];
          return hit === undefined ? undefined : platformClone(hit);
        });
      },
      delete(key) {
        return enqueue(() => {
          delete storeState.data[key];
          return undefined;
        });
      },
      count() {
        return enqueue(() => Object.keys(storeState.data).length);
      },
      clear() {
        return enqueue(() => {
          for (const k of Object.keys(storeState.data)) delete storeState.data[k];
          return undefined;
        });
      },
      getAll() {
        return enqueue(() =>
          orderedKeys(storeState).map((k) => platformClone(storeState.data[k]))
        );
      },
    };
  }

  function makeTransaction(dbState, name, mode) {
    log.transactions += 1;
    if (!Object.prototype.hasOwnProperty.call(dbState.stores, name)) {
      throw new Error(`no object store "${name}"`);
    }
    const tx = {
      mode,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      _pending: 0,
      _settled: false,
    };

    function fail(err, kind) {
      if (tx._settled) return;
      tx._settled = true;
      tx.error = err;
      const handler = kind === 'abort' ? tx.onabort : tx.onerror;
      if (typeof handler === 'function') handler({ target: tx });
    }

    function maybeComplete() {
      schedule(() => {
        if (tx._settled || tx._pending > 0) return;
        tx._settled = true;
        if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
      });
    }

    tx.enqueue = function (work) {
      const request = makeRequest();
      tx._pending += 1;
      schedule(() => {
        if (tx._settled) {
          tx._pending -= 1;
          return;
        }
        let threw = null;
        try {
          request.result = work();
        } catch (err) {
          threw = err;
        }
        if (threw) {
          request.error = threw;
          if (typeof request.onerror === 'function') request.onerror({ target: request });
          tx._pending -= 1;
          fail(threw, 'error');
          return;
        }
        try {
          if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
        } catch (err) {
          tx._pending -= 1;
          fail(err, 'error');
          return;
        }
        tx._pending -= 1;
        maybeComplete();
      });
      return request;
    };

    tx.objectStore = function (wanted) {
      if (wanted !== name) throw new Error(`store "${wanted}" is not in this transaction`);
      return makeStoreHandle(dbState.stores[name], tx);
    };

    tx.abort = function () {
      fail(new Error('aborted'), 'abort');
    };

    return tx;
  }

  function makeDbHandle(dbState) {
    return {
      name: dbState.name,
      get version() {
        return dbState.version;
      },
      objectStoreNames: {
        contains(name) {
          return Object.prototype.hasOwnProperty.call(dbState.stores, name);
        },
        get length() {
          return Object.keys(dbState.stores).length;
        },
      },
      createObjectStore(name, params) {
        const keyPath = (params && params.keyPath) || 'id';
        dbState.stores[name] = {
          name,
          keyPath,
          indexes: Object.create(null),
          data: Object.create(null),
        };
        return makeStoreHandle(dbState.stores[name], null);
      },
      transaction(name, mode) {
        return makeTransaction(dbState, name, mode || 'readonly');
      },
      close() {
        log.closes += 1;
      },
    };
  }

  /* Stand a database up at an earlier version, as a previous release left it.
   * Done before the first open() so the very next open sees an EXISTING
   * database with an oldVersion, not a fresh one. */
  if (opts.seed) {
    const seedName = opts.seed.name || 'sunoprompt';
    const seeded = { name: seedName, version: opts.seed.version || 1, stores: Object.create(null) };
    const tables = opts.seed.stores || {};
    for (const storeName of Object.keys(tables)) {
      const table = {
        name: storeName,
        keyPath: 'id',
        indexes: Object.create(null),
        data: Object.create(null),
      };
      // The v1 handler declared a ts index on every store it created.
      table.indexes.ts = { keyPath: 'ts', unique: false };
      for (const record of tables[storeName] || []) {
        table.data[record.id] = platformClone(record);
      }
      seeded.stores[storeName] = table;
    }
    databases[seedName] = seeded;
  }

  return {
    open(name, version) {
      log.opens += 1;
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      schedule(() => {
        if (opts.failOpen) {
          request.error = new Error(opts.failReason || 'open denied by the browser');
          if (typeof request.onerror === 'function') request.onerror({ target: request });
          return;
        }
        if (opts.blockOpen) {
          if (typeof request.onblocked === 'function') request.onblocked({ target: request });
          return;
        }
        let state = databases[name];
        if (!state) {
          state = databases[name] = { name, version: 0, stores: Object.create(null) };
        }
        const oldVersion = state.version;
        const target = typeof version === 'number' ? version : state.version || 1;
        request.result = makeDbHandle(state);
        if (target > oldVersion) {
          state.version = target;
          log.upgrades += 1;
          if (typeof request.onupgradeneeded === 'function') {
            request.onupgradeneeded({ target: request, oldVersion, newVersion: target });
          }
        }
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });
      return request;
    },
    _databases: databases,
    _log: log,
  };
}

/* -------------------------------------------------------------------------- */
/* A minimal fake DOM for the virtual list                                    */
/* -------------------------------------------------------------------------- */

function makeFakeDocument() {
  const doc = {
    activeElement: null,
    createElement(tag) {
      return makeFakeElement(tag, doc);
    },
  };
  return doc;
}

function makeFakeElement(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc || null,
    parentNode: null,
    children: [],
    attributes: Object.create(null),
    style: {},
    className: '',
    scrollTop: 0,
    clientHeight: 0,
    listeners: [],
    removedListeners: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at !== -1) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    contains(node) {
      let walk = node;
      while (walk) {
        if (walk === this) return true;
        walk = walk.parentNode;
      }
      return false;
    },
    addEventListener(type, fn) {
      this.listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      for (let i = 0; i < this.listeners.length; i += 1) {
        if (this.listeners[i].type === type && this.listeners[i].fn === fn) {
          this.removedListeners.push(this.listeners.splice(i, 1)[0]);
          return;
        }
      }
    },
    focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    /** Supports `[attr="value"]` and `[attr="v"] [attr2="w"]` only. */
    querySelector(selector) {
      const steps = String(selector).trim().split(/\s+(?=\[)/);
      const match = (node, step) => {
        const m = /^\[([-a-zA-Z0-9_]+)="([^"]*)"\]$/.exec(step);
        if (!m) return false;
        return node.getAttribute && node.getAttribute(m[1]) === m[2];
      };
      const search = (node, index) => {
        for (const child of node.children) {
          if (match(child, steps[index])) {
            if (index === steps.length - 1) return child;
            const deeper = search(child, index + 1);
            if (deeper) return deeper;
          }
          const found = search(child, index);
          if (found) return found;
        }
        return null;
      };
      return search(this, 0);
    },
    /** Emit an event the way a browser would for the listeners registered. */
    fire(type) {
      for (const entry of this.listeners.slice()) {
        if (entry.type === type) entry.fn({ type, target: this });
      }
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return el.children.map((c) => c.textContent || '').join('');
    },
    set(value) {
      el.children.length = 0;
      if (value) el._text = String(value);
      else el._text = '';
    },
    configurable: true,
  });
  return el;
}

/** A fake localStorage that records every mutation. */
function makeFakeStorage(seed) {
  const data = Object.assign(Object.create(null), seed || {});
  const writes = [];
  const removed = [];
  return {
    data,
    writes,
    removed,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      writes.push({ key, value });
      data[key] = String(value);
    },
    removeItem(key) {
      removed.push(key);
      delete data[key];
    },
    keysWritten() {
      return writes.map((w) => w.key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Workspace fixtures                                                          */
/* -------------------------------------------------------------------------- */

/** A registry over REAL stores plus a slider bank that records its writes. */
function makeRegistry(initialSliders) {
  const sliders = Object.assign({ energy: SLIDER_DEFAULT, warmth: SLIDER_DEFAULT, density: SLIDER_DEFAULT }, initialSliders || {});
  const setCalls = [];
  return {
    promptState: createPromptState(),
    exclusions: createExclusionState(),
    structure: createStructureState(),
    sliders: {
      get(axis) {
        return sliders[axis];
      },
      set(axis, value) {
        setCalls.push({ axis, value });
        sliders[axis] = value;
      },
    },
    values: sliders,
    setCalls,
  };
}

/** Fill a registry with a realistic, non-trivial workspace. */
function populate(registry) {
  registry.promptState.add({ section: 'genre', tag: 'french electro', source: 'manual', weight: 0.9 });
  registry.promptState.add({ section: 'genre', tag: 'techno', source: 'dissector', weight: 0.75 });
  registry.promptState.add({ section: 'mood', tag: 'nocturnal', source: 'scene' });
  registry.promptState.add({ section: 'instrument', tag: 'analog bass', source: 'manual' });
  registry.promptState.add({ section: 'scene', tag: 'neon rain', source: 'scene' });
  registry.promptState.add({ section: 'era', tag: '2007 blog house', source: 'manual' });
  registry.promptState.setSource('slider-energy', ['high energy', 'driving rhythm']);

  registry.exclusions.add('male vocals');
  registry.exclusions.add('acoustic guitar');

  const intro = registry.structure.addBlock('[Intro]');
  registry.structure.setModifiers(intro, ['sparse', 'filtered']);
  const chorus = registry.structure.addBlock('[Chorus]');
  registry.structure.setLyrics(chorus, 'lights over the rooftops');
  registry.structure.addBlock('[Outro]');

  registry.sliders.set('energy', 86);
  registry.sliders.set('warmth', 32);
  registry.sliders.set('density', 74);
  return registry;
}

/** A snapshot of every observable piece of a registry, for "did not mutate". */
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

const s = suite('persistence (IndexedDB, virtual lists, profiles, backup)');

/* ========================================================================== */
/* 1. The IndexedDB wrapper (FEATURE-MECHANICS §6.4)                          */
/* ========================================================================== */

s.test('the persistence layer is reachable as top-level function declarations', () => {
  for (const name of [
    'createIdbStore',
    'createVirtualList',
    'virtualWindow',
    'serializeWorkspace',
    'restoreWorkspace',
    'validateWorkspaceSnapshot',
    'createProfileStore',
    'applyProfileToWorkspace',
    'planPresetImport',
    'createDebouncer',
  ]) {
    assert.strictEqual(app.evaluate(`typeof ${name}`), 'function', `${name} is not a top-level function`);
  }
});

s.test('the schema constants match the §6.4 contract', () => {
  assert.strictEqual(IDB_NAME, 'sunoprompt');
  // CONSCIOUSLY RAISED TO 2 (0.17.0): three additive stores for the on-device
  // model and the opt-in key vault. Additive means an existing v1 database
  // keeps presets, history and the autosave through the upgrade. The proof is
  // the "a v1 database FULL OF RECORDS survives the upgrade to v2" test in
  // this file, which seeds a v1 database and reopens it at v2; the tests
  // immediately below this one only cover a database created fresh at v2, and
  // an earlier version of this comment claimed otherwise.
  assert.strictEqual(IDB_VERSION, 2);
  assert.strictEqual(IDB_PRESETS, 'presets');
  assert.strictEqual(IDB_HISTORY, 'prompt_history');
  // A THIRD store for the autosave, documented: an autosave is not a preset,
  // and keeping it out of `presets` keeps it out of every JSON export.
  assert.strictEqual(IDB_SESSION, 'session');
  assert.notStrictEqual(IDB_SESSION, IDB_PRESETS);
  // …and the three the v2 upgrade added. `secrets` is deliberately NOT one of
  // the names: the unknown-store negative test below uses that literal, and a
  // store answering to it would quietly turn that test into a no-op.
  assert.strictEqual(IDB_KEYS, 'api_keys');
  assert.strictEqual(IDB_DEVICE_KEY, 'device_key');
  assert.strictEqual(IDB_MODEL_CACHE, 'model_cache');
  deepEqual(IDB_STORES, [
    'presets',
    'prompt_history',
    'session',
    'api_keys',
    'device_key',
    'model_cache',
  ]);
  // The raw lane is exactly the two stores whose values JSON cannot carry.
  deepEqual(IDB_RAW_STORES, ['device_key', 'model_cache']);
  assert.strictEqual(IDB_STORES.indexOf('secrets'), -1);
  assert.strictEqual(HISTORY_CAP, 100, 'ASSUMPTIONS.md caps the history bank at 100');
  assert.strictEqual(WORKSPACE_VERSION, 1);
  // §6.2 names this key verbatim.
  assert.strictEqual(PROFILES_KEY, 'suno_profiles');
});

s.test('the upgrade path creates both tables plus the session store and a ts index', async () => {
  const fake = makeFakeIndexedDB();
  const store = createIdbStore({ indexedDB: fake });
  const state = await store.ready();

  assert.strictEqual(state.persistent, true, 'a working IndexedDB must report persistent:true');
  assert.strictEqual(fake._log.upgrades, 1, 'the upgrade handler must have run exactly once');

  const db = fake._databases[IDB_NAME];
  assert.ok(db, 'no database was created');
  assert.strictEqual(db.version, IDB_VERSION);
  for (const name of [IDB_PRESETS, IDB_HISTORY, IDB_SESSION]) {
    assert.ok(db.stores[name], `object store "${name}" was not created`);
    assert.strictEqual(db.stores[name].keyPath, 'id', `"${name}" must key on id`);
    assert.ok(db.stores[name].indexes[IDB_TS_INDEX], `"${name}" is missing the ${IDB_TS_INDEX} index`);
    assert.strictEqual(db.stores[name].indexes[IDB_TS_INDEX].keyPath, 'ts');
  }
});

s.test('a v1 database FULL OF RECORDS survives the upgrade to v2, byte for byte', async () => {
  /*
   * The upgrade a real user meets: 0.16.0 left a v1 database holding their
   * presets, their copied-prompt history and their autosave, and 0.17.0 opens
   * it at v2 to add three stores. "Additive" is a claim about THEIR data, so
   * it is tested with their data in place rather than against an empty
   * database created fresh at v2 (which is all the tests around this one do).
   *
   * Records are compared field for field after the reopen: a v2 upgrade that
   * recreated a store instead of leaving it alone would still produce a
   * database with the right store NAMES, and would have silently deleted
   * everything in them.
   */
  const seededPresets = [
    { id: 'p-1', name: 'Neon Rain', ts: 111, favorite: true, tags: ['techno', 'dark'], sliders: { energy: 86 } },
    { id: 'p-2', name: 'Tape Room', ts: 222, favorite: false, tags: [], sliders: { warmth: 12 } },
  ];
  const seededHistory = [
    { id: 'h-1', ts: 333, text: 'techno, dark, tr-909 kick', favorite: false },
    { id: 'h-2', ts: 444, text: 'french electro, neon rain', favorite: true },
  ];
  const seededSession = [{ id: 'autosave', ts: 555, snapshot: { version: 1, prompt: ['techno'] } }];

  const fake = makeFakeIndexedDB({
    seed: {
      name: IDB_NAME,
      version: 1,
      stores: { presets: seededPresets, prompt_history: seededHistory, session: seededSession },
    },
  });

  // The database really is at v1 with records in it before anything opens it.
  assert.strictEqual(fake._databases[IDB_NAME].version, 1);
  assert.strictEqual(Object.keys(fake._databases[IDB_NAME].stores).length, 3, 'v1 had exactly three stores');
  assert.strictEqual(fake._log.upgrades, 0, 'the seed must not count as an upgrade');

  const store = createIdbStore({ indexedDB: fake });
  const state = await store.ready();
  assert.strictEqual(state.persistent, true, 'the upgrade must not degrade the store to memory');
  assert.strictEqual(fake._log.upgrades, 1, 'v1 -> v2 must run the upgrade handler exactly once');

  const db = fake._databases[IDB_NAME];
  assert.strictEqual(db.version, 2);

  // 1. Every seeded record is still there, unchanged.
  deepEqual(await store.getAll(IDB_PRESETS), [...seededPresets].reverse(), 'a preset was lost or altered by the upgrade');
  deepEqual(await store.getAll(IDB_HISTORY), [...seededHistory].reverse(), 'a history entry was lost or altered by the upgrade');
  deepEqual(await store.getAll(IDB_SESSION), seededSession, 'the autosave was lost or altered by the upgrade');
  deepEqual(await store.get(IDB_PRESETS, 'p-1'), seededPresets[0], 'a preset came back with different fields');
  assert.strictEqual(await store.count(IDB_HISTORY), 2);

  // 2. The three v1 stores kept their keyPath and their ts index — they were
  //    left alone, not dropped and rebuilt.
  for (const name of [IDB_PRESETS, IDB_HISTORY, IDB_SESSION]) {
    assert.strictEqual(db.stores[name].keyPath, 'id', `"${name}" was rebuilt with a different keyPath`);
    assert.ok(db.stores[name].indexes[IDB_TS_INDEX], `"${name}" lost its ${IDB_TS_INDEX} index`);
  }

  // 3. …and the three stores the upgrade exists to add are now present, with
  //    the same shape every other store has.
  for (const name of [IDB_KEYS, IDB_DEVICE_KEY, IDB_MODEL_CACHE]) {
    assert.ok(db.stores[name], `the v2 upgrade did not create "${name}"`);
    assert.strictEqual(db.stores[name].keyPath, 'id', `"${name}" must key on id`);
    assert.strictEqual(Object.keys(db.stores[name].data).length, 0, `"${name}" was created with records in it`);
  }
  assert.strictEqual(Object.keys(db.stores).length, IDB_STORES.length, 'the upgrade created a store nobody declared');

  // 4. The new stores work, and using them leaves the old data alone.
  await store.put(IDB_KEYS, { id: 'openrouter::https://openrouter.ai', ts: 666, cipher: [1, 2, 3] });
  assert.strictEqual(await store.count(IDB_KEYS), 1);
  assert.strictEqual(await store.count(IDB_PRESETS), 2, 'writing a key disturbed the presets');
  assert.strictEqual(fake._log.upgrades, 1, 'a later write must not trigger another upgrade');
});

s.test('a second open of the same database does not re-run the upgrade', async () => {
  const fake = makeFakeIndexedDB();
  await createIdbStore({ indexedDB: fake }).ready();
  await createIdbStore({ indexedDB: fake }).ready();
  assert.strictEqual(fake._log.upgrades, 1, 'the upgrade must not run again at the same version');
  assert.strictEqual(fake._log.opens, 2);
});

s.test('put/get round-trip, and an absent id is minted rather than refused', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });

  const explicit = await store.put(IDB_PRESETS, { id: 'fixed-1', name: 'Neon', ts: 10 });
  assert.strictEqual(explicit, 'fixed-1');

  const minted = await store.put(IDB_HISTORY, { text: 'techno, driving rhythm' });
  assert.strictEqual(typeof minted, 'string');
  assert.ok(minted.length > 8, `a minted id is a ULID-ish string, got "${minted}"`);

  const back = await store.get(IDB_PRESETS, 'fixed-1');
  assert.strictEqual(back.name, 'Neon');
  const banked = await store.get(IDB_HISTORY, minted);
  assert.strictEqual(banked.text, 'techno, driving rhythm');
  assert.strictEqual(typeof banked.ts, 'number', 'a record with no ts is stamped on the way in');

  assert.strictEqual(await store.get(IDB_PRESETS, 'nothing-here'), null, 'a miss is null, never undefined');
});

s.test('a stored record is a COPY — editing it afterwards cannot reach the table', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  const record = { id: 'p1', name: 'Neon', workspace: { prompt: [{ tag: 'techno' }] } };
  await store.put(IDB_PRESETS, record);
  record.name = 'edited behind the store';
  record.workspace.prompt[0].tag = 'polka';
  const back = await store.get(IDB_PRESETS, 'p1');
  assert.strictEqual(back.name, 'Neon');
  assert.strictEqual(back.workspace.prompt[0].tag, 'techno');
});

s.test('getAll comes back NEWEST FIRST even when the table hands it over ascending', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  await store.put(IDB_HISTORY, { id: 'b', ts: 200, text: 'second' });
  await store.put(IDB_HISTORY, { id: 'a', ts: 100, text: 'first' });
  await store.put(IDB_HISTORY, { id: 'c', ts: 300, text: 'third' });

  const all = await store.getAll(IDB_HISTORY);
  deepEqual(all.map((r) => r.id), ['c', 'b', 'a']);
});

s.test('records sharing a millisecond still have a total order (id descending)', () => {
  const ordered = sortNewestFirst([
    { id: 'h-002', ts: 5 },
    { id: 'h-003', ts: 5 },
    { id: 'h-001', ts: 5 },
    { id: 'h-004', ts: 9 },
  ]);
  deepEqual(ordered.map((r) => r.id), ['h-004', 'h-003', 'h-002', 'h-001']);
});

s.test('delete reports honestly whether anything was there, in ONE transaction', async () => {
  const fake = makeFakeIndexedDB();
  const store = createIdbStore({ indexedDB: fake });
  await store.put(IDB_HISTORY, { id: 'gone', ts: 1 });

  const before = fake._log.transactions;
  assert.strictEqual(await store.delete(IDB_HISTORY, 'gone'), true);
  assert.strictEqual(
    fake._log.transactions - before,
    1,
    'the read and the delete must share one transaction, or the answer can go stale between them'
  );
  assert.strictEqual(await store.delete(IDB_HISTORY, 'gone'), false, 'a second delete found nothing');
  assert.strictEqual(await store.get(IDB_HISTORY, 'gone'), null);
});

s.test('count and clear report real numbers', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  assert.strictEqual(await store.count(IDB_PRESETS), 0);
  for (let i = 0; i < 4; i += 1) await store.put(IDB_PRESETS, { id: `p${i}`, ts: i });
  assert.strictEqual(await store.count(IDB_PRESETS), 4);
  assert.strictEqual(await store.clear(IDB_PRESETS), 4, 'clear() reports how many it dropped');
  assert.strictEqual(await store.count(IDB_PRESETS), 0);
  assert.strictEqual(await store.clear(IDB_PRESETS), 0);
});

s.test('a rawStore record keeps values JSON cannot carry (a CryptoKey survives)', async () => {
  /*
   * The reason IDB_RAW_STORES exists. copy() is JSON.parse(JSON.stringify()),
   * and a CryptoKey has no enumerable own properties, so it round-trips to
   * `{}` — silently. A vault built on that would encrypt with nothing and
   * report success. The raw lane detaches the RECORD without touching what is
   * inside it, and this test is the only thing standing between the two.
   */
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });

  await store.put(IDB_DEVICE_KEY, { id: 'k', key, ts: 1 });
  const read = await store.get(IDB_DEVICE_KEY, 'k');
  // IndexedDB structured-clones, so this is a DIFFERENT CryptoKey object with
  // the same key material — which is exactly what the vault needs on the next
  // page load. A JSON round-trip would have handed back `{}`.
  assert.strictEqual(typeof read.key.algorithm, 'object', 'the CryptoKey did not survive put/get');
  assert.strictEqual(read.key.algorithm.name, 'AES-GCM');
  assert.strictEqual(read.key.extractable, false);

  // The proof that the key material really came back: the clone decrypts what
  // the original encrypted.
  const iv = new Uint8Array(12);
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([7, 7, 7]));
  const plain = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, read.key, cipher));
  deepEqual(Array.from(plain), [7, 7, 7], 'the restored key could not open what the original sealed');

  await store.put(IDB_MODEL_CACHE, { id: 'weights', body: buffer, ts: 2 });
  const cached = await store.get(IDB_MODEL_CACHE, 'weights');
  assert.ok(cached.body instanceof ArrayBuffer, 'an ArrayBuffer came back as something else');
  assert.strictEqual(cached.body.byteLength, 4, 'a JSON round-trip would have made this an object of digits');
  deepEqual(Array.from(new Uint8Array(cached.body)), [1, 2, 3, 4]);

  // The record itself is still detached: editing what came back cannot reach
  // into the table, which is the guarantee copy() was there to provide.
  read.id = 'mutated';
  read.extra = 'added later';
  const again = await store.get(IDB_DEVICE_KEY, 'k');
  assert.strictEqual(again.id, 'k');
  assert.strictEqual(again.extra, undefined);
});

s.test('a NORMAL store still deep-copies, so the raw lane changed nothing else', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  const nested = { id: 'p-1', name: 'Neon', ts: 1, workspace: { tags: ['techno'] } };
  await store.put(IDB_PRESETS, nested);

  // Mutating the object we handed in must not reach the table…
  nested.workspace.tags.push('house');
  const read = await store.get(IDB_PRESETS, 'p-1');
  deepEqual(read.workspace.tags, ['techno'], 'the store kept a reference instead of a deep copy');
  // …and mutating what came back must not reach it either.
  read.workspace.tags.push('trance');
  const again = await store.get(IDB_PRESETS, 'p-1');
  deepEqual(again.workspace.tags, ['techno']);
  assert.notStrictEqual(read.workspace, again.workspace, 'two reads shared one object');
});

s.test('an unknown object store rejects instead of inventing one', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  await assert.rejects(() => store.put('secrets', { id: 'x' }), /unknown object store/);
  await assert.rejects(() => store.getAll('secrets'), /unknown object store/);
});

s.test('put() refuses anything that is not a record object', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  for (const hostile of [null, undefined, 42, 'text', [1, 2, 3]]) {
    await assert.rejects(() => store.put(IDB_PRESETS, hostile), /needs a record object/);
  }
});

s.test('NO IndexedDB at all → the same API out of memory, and persistent:false', async () => {
  const degrades = [];
  const store = createIdbStore({
    indexedDB: null,
    onDegrade: (reason) => degrades.push(reason),
  });

  assert.strictEqual(store.persistent, false, 'the flag must be false the moment it is known');
  assert.strictEqual(store.isPersistent(), false);
  assert.strictEqual(degrades.length, 1, 'the UI is told once, honestly');
  assert.ok(/IndexedDB/i.test(degrades[0]), `the reason must name the missing API: "${degrades[0]}"`);

  const state = await store.ready();
  deepEqual({ persistent: state.persistent }, { persistent: false });
  assert.ok(state.reason, 'ready() carries the reason too');

  // Every operation still works — that is what "same api" means.
  const id = await store.put(IDB_HISTORY, { id: 'a', ts: 100, text: 'still usable' });
  assert.strictEqual((await store.get(IDB_HISTORY, id)).text, 'still usable');
  await store.put(IDB_HISTORY, { id: 'z', ts: 999, text: 'newest' });
  deepEqual((await store.getAll(IDB_HISTORY)).map((r) => r.text), ['newest', 'still usable']);
  // A record handed no ts at all is still stamped on the way in.
  const stamped = await store.put(IDB_HISTORY, { text: 'no timestamp given' });
  assert.strictEqual(typeof (await store.get(IDB_HISTORY, stamped)).ts, 'number');
  assert.strictEqual(await store.delete(IDB_HISTORY, stamped), true);
  assert.strictEqual(await store.count(IDB_HISTORY), 2);
  assert.strictEqual(await store.delete(IDB_HISTORY, 'z'), true);
  assert.strictEqual(await store.clear(IDB_HISTORY), 1);
});

s.test('an IndexedDB that EXISTS but refuses to open degrades once, not per call', async () => {
  const degrades = [];
  const fake = makeFakeIndexedDB({ failOpen: true, failReason: 'private browsing blocks this origin' });
  const store = createIdbStore({ indexedDB: fake, onDegrade: (r) => degrades.push(r) });

  assert.strictEqual(store.persistent, true, 'nothing is known until the first open resolves');
  const state = await store.ready();
  assert.strictEqual(state.persistent, false);
  assert.strictEqual(store.persistent, false, 'the live flag follows the degrade');
  assert.strictEqual(state.reason, 'private browsing blocks this origin');

  await store.put(IDB_PRESETS, { id: 'a', ts: 1 });
  await store.put(IDB_PRESETS, { id: 'b', ts: 2 });
  assert.strictEqual(await store.count(IDB_PRESETS), 2, 'the memory fallback took the writes');
  assert.strictEqual(fake._log.opens, 1, 'the failed open must not be retried on every call');
  assert.strictEqual(degrades.length, 1);
});

s.test('a blocked open is a failed open, not a promise that never settles', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB({ blockOpen: true }) });
  const state = await store.ready();
  assert.strictEqual(state.persistent, false);
  assert.ok(/blocked/i.test(state.reason), `the reason must say blocked: "${state.reason}"`);
});

s.test('a throwing indexedDB.open is caught, not propagated', async () => {
  const store = createIdbStore({
    indexedDB: {
      open() {
        throw new Error('SecurityError: the operation is insecure');
      },
    },
  });
  const state = await store.ready();
  assert.strictEqual(state.persistent, false);
  assert.ok(/insecure/.test(state.reason));
  assert.strictEqual(await store.count(IDB_HISTORY), 0, 'the memory fallback is live');
});

s.test('an onDegrade listener that throws cannot break the store', async () => {
  const store = createIdbStore({
    indexedDB: null,
    onDegrade() {
      throw new Error('a broken listener');
    },
  });
  assert.strictEqual(store.persistent, false);
  assert.strictEqual(await store.put(IDB_HISTORY, { id: 'ok', ts: 1 }), 'ok');
});

s.test('every operation returns a real promise whose rejection is observable', async () => {
  const store = createIdbStore({ indexedDB: makeFakeIndexedDB() });
  const pending = store.put('not-a-store', { id: 'x' });
  assert.strictEqual(typeof pending.then, 'function');
  assert.strictEqual(typeof pending.catch, 'function');
  let caught = null;
  await pending.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof Error, 'the rejection is catchable at the call site');
});

s.test('makeRecordId is unique, fixed-width and time-ordered', () => {
  const ids = [];
  for (let i = 0; i < 500; i += 1) ids.push(makeRecordId('h'));
  assert.strictEqual(new Set(ids).size, 500, 'ids collided');
  const widths = new Set(ids.map((id) => id.length));
  assert.strictEqual(widths.size, 1, `ids must be fixed width, saw ${[...widths].join(', ')}`);
  for (const id of ids) assert.ok(/^h-[0-9a-z]+$/.test(id), `unexpected id shape: ${id}`);
  const sorted = ids.slice().sort();
  deepEqual(sorted, ids, 'minting order must equal lexicographic order');
});

/* ========================================================================== */
/* 2. Workspace serialization (FDD #85/#86)                                   */
/* ========================================================================== */

s.test('a populated workspace round-trips to an identical serialization', () => {
  const source = populate(makeRegistry());
  const first = serializeWorkspace(source, { savedAt: 1000 });

  const target = makeRegistry();
  const outcome = restoreWorkspace(first, target);
  assert.strictEqual(outcome.ok, true, outcome.reason);

  const second = serializeWorkspace(target, { savedAt: 1000 });
  deepEqual(second, first, 'the snapshot did not survive its own restore');

  // And the live stores really do agree, not just their serializations.
  assert.strictEqual(target.promptState.draftText(), source.promptState.draftText());
  deepEqual(target.exclusions.list(), source.exclusions.list());
  assert.strictEqual(target.structure.compile(), source.structure.compile());
  assert.strictEqual(target.sliders.get('energy'), 86);
  assert.strictEqual(target.sliders.get('warmth'), 32);
  assert.strictEqual(target.sliders.get('density'), 74);
});

s.test('the snapshot carries its version and exactly the documented fields', () => {
  const snapshot = serializeWorkspace(populate(makeRegistry()));
  assert.strictEqual(snapshot.workspaceVersion, WORKSPACE_VERSION);
  deepEqual(
    Object.keys(snapshot).sort(),
    ['exclusions', 'prompt', 'savedAt', 'sliders', 'structure', 'workspaceVersion'],
    'the snapshot grew or lost a top-level field'
  );
  deepEqual(Object.keys(snapshot.sliders).sort(), ['density', 'energy', 'warmth']);
  for (const entry of snapshot.prompt) {
    assert.strictEqual(entry.id, undefined, 'store-internal ids must not be serialized');
  }
});

s.test('NO key material can reach a snapshot — the serializer is never handed one', () => {
  const SECRET = 'sk-live-do-not-persist-4711';
  const registry = populate(makeRegistry());
  // Exactly the shape the boot code holds a cloud provider config in, hung off
  // the same object the serializer is given. It must be ignored entirely.
  registry.cloud = { endpoint: 'https://api.example.com/v1/chat/completions', key: SECRET, model: 'gpt-4o-mini' };
  registry.dissectKeyInput = { value: SECRET };

  const json = JSON.stringify(serializeWorkspace(registry));
  assert.strictEqual(json.indexOf(SECRET), -1, 'the API key reached the snapshot');
  assert.strictEqual(json.indexOf('api.example.com'), -1, 'the endpoint reached the snapshot');
  assert.strictEqual(json.indexOf('cloud'), -1, 'an unknown registry field was serialized');

  // And a snapshot of the same workspace WITHOUT the config is byte-identical.
  const clean = populate(makeRegistry());
  deepEqual(
    serializeWorkspace(registry, { savedAt: 7 }),
    serializeWorkspace(clean, { savedAt: 7 })
  );
});

s.test('serializeWorkspace survives an empty or absent registry', () => {
  for (const registry of [undefined, null, {}, { promptState: null }]) {
    const snapshot = serializeWorkspace(registry, { savedAt: 1 });
    assert.strictEqual(snapshot.workspaceVersion, WORKSPACE_VERSION);
    deepEqual(snapshot.prompt, []);
    deepEqual(snapshot.exclusions, []);
    deepEqual(snapshot.sliders, { energy: 50, warmth: 50, density: 50 });
  }
});

s.test('18 hostile payloads are all refused, and NOTHING is partially applied', () => {
  const good = serializeWorkspace(populate(makeRegistry()), { savedAt: 42 });

  const hostile = [
    [null, 'null'],
    [undefined, 'undefined'],
    [42, 'a number'],
    ['{"workspaceVersion":1}', 'a JSON string rather than an object'],
    [[], 'an array'],
    [{}, 'an object with no version'],
    [Object.assign({}, good, { workspaceVersion: 2 }), 'a future version'],
    [Object.assign({}, good, { workspaceVersion: '1' }), 'a stringified version'],
    [Object.assign({}, good, { sliders: [] }), 'sliders as an array'],
    [Object.assign({}, good, { sliders: { energy: 'hot' } }), 'a non-numeric slider'],
    [Object.assign({}, good, { sliders: { energy: 200 } }), 'a slider out of range'],
    [Object.assign({}, good, { sliders: { energy: NaN } }), 'a NaN slider'],
    [Object.assign({}, good, { prompt: 'techno' }), 'prompt as a string'],
    [Object.assign({}, good, { prompt: [{ tag: '   ' }] }), 'a blank tag'],
    [Object.assign({}, good, { prompt: [{ tag: 'x', section: 'lyrics' }] }), 'an unknown section'],
    [Object.assign({}, good, { prompt: [{ tag: 'x', source: 'evil' }] }), 'an unknown source'],
    [Object.assign({}, good, { prompt: [{ tag: 'x', weight: 'heavy' }] }), 'a non-numeric weight'],
    [Object.assign({}, good, { exclusions: 'male vocals' }), 'exclusions as a string'],
    [Object.assign({}, good, { exclusions: ['   '] }), 'an unusable exclusion'],
    [Object.assign({}, good, { structure: 7 }), 'structure as a number'],
    [Object.assign({}, good, { structure: { blocks: 'Intro' } }), 'blocks as a string'],
    [Object.assign({}, good, { structure: { blocks: [{ section: '' }] } }), 'a blank section'],
    [Object.assign({}, good, { structure: { blocks: [{ section: 'Intro', modifiers: 'sparse' }] } }), 'modifiers as a string'],
  ];
  assert.ok(hostile.length >= 12, 'the contract asks for at least a dozen hostile variants');

  for (const [payload, label] of hostile) {
    const registry = populate(makeRegistry());
    const before = snapshotOf(registry);

    const verdict = validateWorkspaceSnapshot(payload);
    assert.strictEqual(verdict.ok, false, `${label} was accepted by the validator`);
    assert.strictEqual(typeof verdict.reason, 'string');
    assert.ok(verdict.reason.length > 0, `${label} produced an empty reason`);

    const outcome = restoreWorkspace(payload, registry);
    assert.strictEqual(outcome.ok, false, `${label} was applied`);
    assert.strictEqual(outcome.reason, verdict.reason);
    assert.strictEqual(snapshotOf(registry), before, `${label} left the workspace partially mutated`);
  }
});

s.test('restore is TOLERANT: unknown fields are ignored, absent optional ones default', () => {
  const registry = makeRegistry();
  const outcome = restoreWorkspace(
    {
      workspaceVersion: WORKSPACE_VERSION,
      somethingFromALaterBuild: { deep: [1, 2, 3] },
      prompt: [{ tag: 'afro house', section: 'genre', source: 'manual' }],
      // no sliders, no exclusions, no structure
    },
    registry
  );
  assert.strictEqual(outcome.ok, true, outcome.reason);
  assert.strictEqual(outcome.applied.tags, 1);
  deepEqual(registry.exclusions.list(), []);
  deepEqual(registry.structure.blocks(), []);
  assert.strictEqual(registry.sliders.get('energy'), SLIDER_DEFAULT);
});

s.test('a restore REPLACES the workspace rather than merging into it', () => {
  const registry = populate(makeRegistry());
  const outcome = restoreWorkspace(
    { workspaceVersion: WORKSPACE_VERSION, prompt: [{ tag: 'ambient', section: 'genre', source: 'manual' }] },
    registry
  );
  assert.strictEqual(outcome.ok, true, outcome.reason);
  const tags = registry.promptState.list().map((e) => e.tag);
  assert.ok(tags.indexOf('ambient') !== -1);
  assert.strictEqual(tags.indexOf('french electro'), -1, 'the old genre survived a restore');
  deepEqual(registry.exclusions.list(), [], 'the old exclusions survived a restore');
  deepEqual(registry.structure.blocks(), [], 'the old song flow survived a restore');
});

s.test('a restore publishes ONE prompt-store notification, not one per tag', () => {
  const registry = makeRegistry();
  const source = serializeWorkspace(populate(makeRegistry()));
  let notifications = 0;
  registry.promptState.subscribe(() => {
    notifications += 1;
  });
  restoreWorkspace(source, registry);
  // One for the batched clear+add, then one per slider axis (each is a real,
  // separate user-visible change published by setSource).
  assert.ok(notifications >= 1, 'the restore published nothing at all');
  assert.ok(
    notifications <= 1 + SLIDER_AXES.length,
    `the restore published ${notifications} times — the tag rebuild is not batched`
  );
});

/* ========================================================================== */
/* 3. History rules (FDD #74)                                                 */
/* ========================================================================== */

s.test('a history record carries the text, the count, the time and a full snapshot', () => {
  const snapshot = serializeWorkspace(populate(makeRegistry()));
  const record = createHistoryRecord('techno, driving rhythm', snapshot, { tagCount: 7, ts: 12345 });
  assert.strictEqual(record.text, 'techno, driving rhythm');
  assert.strictEqual(record.tagCount, 7);
  assert.strictEqual(record.ts, 12345);
  assert.strictEqual(record.favorite, false, 'a new entry is never pre-starred');
  assert.strictEqual(record.snapshot.workspaceVersion, WORKSPACE_VERSION);
  assert.ok(record.id, 'a history record needs an id');
});

s.test('the FIFO cap keeps the newest 100 and drops the oldest 5 of 105', () => {
  const records = [];
  for (let i = 0; i < 105; i += 1) {
    records.push(createHistoryRecord(`prompt ${i}`, null, { ts: 1000 + i }));
  }
  const capped = capHistoryRecords(records, HISTORY_CAP);
  assert.strictEqual(capped.keep.length, HISTORY_CAP);
  assert.strictEqual(capped.drop.length, 5);
  deepEqual(
    capped.drop.map((r) => r.text).sort(),
    ['prompt 0', 'prompt 1', 'prompt 2', 'prompt 3', 'prompt 4'].sort(),
    'the FIFO cap dropped the wrong end'
  );
  assert.strictEqual(capped.keep[0].text, 'prompt 104', 'kept records come back newest-first');
  assert.strictEqual(capped.keep[HISTORY_CAP - 1].text, 'prompt 5');
});

s.test('the cap is blind to favourites — a starred entry cannot dodge the quota', () => {
  const records = [];
  for (let i = 0; i < 105; i += 1) {
    records.push(createHistoryRecord(`prompt ${i}`, null, { ts: 1000 + i, favorite: i < 3 }));
  }
  const capped = capHistoryRecords(records, HISTORY_CAP);
  assert.strictEqual(capped.keep.length, HISTORY_CAP);
  assert.strictEqual(capped.drop.filter((r) => r.favorite).length, 3, 'the oldest three were starred and still went');
});

s.test('favourites float above the rest, both groups newest-first', () => {
  const records = [
    createHistoryRecord('old star', null, { ts: 100, favorite: true }),
    createHistoryRecord('new plain', null, { ts: 900 }),
    createHistoryRecord('new star', null, { ts: 800, favorite: true }),
    createHistoryRecord('old plain', null, { ts: 200 }),
  ];
  deepEqual(
    sortHistoryRecords(records).map((r) => r.text),
    ['new star', 'old star', 'new plain', 'old plain']
  );
});

s.test('search is a case-insensitive substring over the text, and an empty query filters nothing', () => {
  const records = [
    createHistoryRecord('French Electro, sidechain pumping', null, { ts: 3 }),
    createHistoryRecord('afro house, log drums', null, { ts: 2 }),
    createHistoryRecord('progressive trance', null, { ts: 1 }),
  ];
  deepEqual(filterHistoryRecords(records, 'ELECTRO').map((r) => r.ts), [3]);
  deepEqual(filterHistoryRecords(records, 'house').map((r) => r.ts), [2]);
  deepEqual(filterHistoryRecords(records, 'log drums').map((r) => r.ts), [2]);
  assert.strictEqual(filterHistoryRecords(records, '').length, 3);
  assert.strictEqual(filterHistoryRecords(records, '   ').length, 3);
  assert.strictEqual(filterHistoryRecords(records, 'polka').length, 0);
  assert.strictEqual(filterHistoryRecords(null, 'x').length, 0);
});

s.test('relative time reads in plain words and never goes backwards', () => {
  const now = 1000000000;
  assert.strictEqual(relativeTimeText(now, now), 'just now');
  assert.strictEqual(relativeTimeText(now - 44 * 1000, now), 'just now');
  assert.strictEqual(relativeTimeText(now - 4 * 60 * 1000, now), '4 min ago');
  assert.strictEqual(relativeTimeText(now - 3 * 3600 * 1000, now), '3 h ago');
  assert.strictEqual(relativeTimeText(now - 2 * 86400 * 1000, now), '2 d ago');
  assert.strictEqual(relativeTimeText(now + 5000, now), 'just now', 'a clock skew must not read as the future');
});

/* ========================================================================== */
/* 4. Virtualization (FDD #21, ENGINEERING-STANDARD §2.2)                     */
/* ========================================================================== */

s.test('§2.2 thresholds and the shared row height are declared, not guessed', () => {
  assert.strictEqual(VIRTUAL_LIST_THRESHOLD, 50, 'ENGINEERING-STANDARD §2.2 names 50 items');
  assert.strictEqual(VIRTUAL_OVERSCAN_DEFAULT, 5);
  assert.strictEqual(typeof VIRTUAL_ROW_HEIGHT, 'number');
  const css = readStyle();
  const rule = /\.vrow\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the stylesheet has no .vrow rule');
  const height = /height:\s*(\d+)px/.exec(rule[1]);
  assert.ok(height, '.vrow must pin its height — the spacer arithmetic depends on it');
  assert.strictEqual(
    Number(height[1]),
    VIRTUAL_ROW_HEIGHT,
    'the CSS row height and VIRTUAL_ROW_HEIGHT have drifted apart'
  );
});

s.test('the window arithmetic covers the top, the middle and a clamped end', () => {
  const rowHeight = 50;
  const viewport = 200; // four rows visible
  const overscan = 5;

  // At the top: nothing above to overscan into.
  deepEqual(virtualWindow(0, viewport, rowHeight, 120, overscan), {
    start: 0,
    end: 9,
    count: 9,
    total: 120,
  });

  // Mid-list: five rows of overscan on each side of the four visible.
  deepEqual(virtualWindow(1000, viewport, rowHeight, 120, overscan), {
    start: 15,
    end: 29,
    count: 14,
    total: 120,
  });

  // Scrolled to the very bottom: the end CLAMPS to the item count.
  const bottom = virtualWindow(120 * rowHeight - viewport, viewport, rowHeight, 120, overscan);
  assert.strictEqual(bottom.end, 120, 'the end must clamp to the total');
  assert.strictEqual(bottom.start, 111);

  // Empty and smaller-than-the-window lists.
  deepEqual(virtualWindow(0, viewport, rowHeight, 0, overscan), { start: 0, end: 0, count: 0, total: 0 });
  deepEqual(virtualWindow(0, viewport, rowHeight, 3, overscan), { start: 0, end: 3, count: 3, total: 3 });

  // A container that has not been laid out yet still renders the overscan.
  deepEqual(virtualWindow(0, 0, rowHeight, 40, overscan), { start: 0, end: 5, count: 5, total: 40 });

  // Nonsense in, defined behaviour out.
  for (const bad of [NaN, -1, undefined, null, 'x']) {
    const out = virtualWindow(bad, viewport, rowHeight, 10, overscan);
    assert.ok(out.start >= 0 && out.end <= 10 && out.start <= out.end, `virtualWindow broke on ${String(bad)}`);
  }
});

s.test('a scroll position past a SHRUNKEN list collapses onto the new end', () => {
  const rowHeight = 50;
  const viewport = 200;
  // scrollTop is where a 120-row list left it, but only 8 rows remain.
  const out = virtualWindow(5800, viewport, rowHeight, 8, 5);
  assert.strictEqual(out.total, 8);
  assert.strictEqual(out.end, 8);
  assert.strictEqual(out.start, 8, 'the window collapses rather than asking for rows 116-124');
  assert.strictEqual(out.count, 0);
});

s.test('120 items put a fraction of that in the DOM, with spacers holding the geometry', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 340;

  const items = [];
  for (let i = 0; i < 120; i += 1) items.push({ id: `h-${i}`, text: `prompt ${i}` });

  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN_DEFAULT,
    label: 'Copied prompt history',
    document: doc,
    keyOf: (item) => item.id,
    renderRow: (item) => {
      const row = doc.createElement('div');
      row.className = 'vrow';
      row.setAttribute('data-test-id', item.id);
      return row;
    },
  });

  assert.strictEqual(container.getAttribute('role'), 'list', 'the scroller must be a labelled list');
  assert.strictEqual(container.getAttribute('aria-label'), 'Copied prompt history');

  list.setItems(items);
  const rows = container.children.filter((c) => c.className === 'vrow');
  assert.ok(rows.length < 30, `${rows.length} rows are mounted for 120 items — that is not virtualization`);
  assert.ok(rows.length > 0, 'nothing was rendered at all');
  assert.strictEqual(
    container.children.length,
    rows.length + 2,
    'the window must be wrapped in exactly two spacer divs'
  );

  const top = container.children[0];
  const bottom = container.children[container.children.length - 1];
  assert.strictEqual(top.getAttribute('aria-hidden'), 'true', 'spacers must be hidden from the a11y tree');
  assert.strictEqual(top.style.height, '0px', 'at scrollTop 0 nothing sits above the window');
  const range = list.renderedRange();
  assert.strictEqual(bottom.style.height, `${(120 - range.end) * VIRTUAL_ROW_HEIGHT}px`);
  assert.strictEqual(
    Number(top.style.height.replace('px', '')) +
      rows.length * VIRTUAL_ROW_HEIGHT +
      Number(bottom.style.height.replace('px', '')),
    120 * VIRTUAL_ROW_HEIGHT,
    'the spacers plus the mounted rows must add up to the full scroll height'
  );

  // Scrolling swaps the window rather than growing the DOM.
  container.scrollTop = 3000;
  container.fire('scroll');
  const scrolled = list.renderedRange();
  assert.ok(scrolled.start > range.start, 'the window did not move with the scroll');
  const rowsAfter = container.children.filter((c) => c.className === 'vrow');
  assert.ok(rowsAfter.length < 30, 'the DOM grew instead of the window sliding');
  assert.strictEqual(rowsAfter[0].getAttribute('data-test-id'), `h-${scrolled.start}`);
});

s.test('every mounted row announces its real position in the whole list', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 200;
  const items = [];
  for (let i = 0; i < 80; i += 1) items.push({ id: `p-${i}` });

  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    keyOf: (item) => item.id,
    renderRow: () => doc.createElement('div'),
  });
  list.setItems(items);

  const range = list.renderedRange();
  const rows = container.children.slice(1, container.children.length - 1);
  assert.strictEqual(rows.length, range.count);
  rows.forEach((row, i) => {
    assert.strictEqual(row.getAttribute('role'), 'listitem');
    assert.strictEqual(row.getAttribute('tabindex'), '-1', 'a row must be able to hold focus');
    assert.strictEqual(row.getAttribute('aria-setsize'), '80', 'a screen reader is told the REAL total');
    assert.strictEqual(row.getAttribute('aria-posinset'), String(range.start + i + 1));
    assert.strictEqual(row.getAttribute('data-row-key'), `p-${range.start + i}`);
  });
});

s.test('focus survives a refresh via the stable focus key', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 340;
  const items = [];
  for (let i = 0; i < 60; i += 1) items.push({ id: `h-${i}` });

  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    keyOf: (item) => item.id,
    renderRow: (item) => {
      const row = doc.createElement('div');
      const star = doc.createElement('button');
      star.setAttribute('data-focus-key', 'star');
      star.setAttribute('data-item', item.id);
      row.appendChild(star);
      return row;
    },
  });
  list.setItems(items);

  // Focus the Star button of the third rendered row, then rebuild.
  const rows = container.children.slice(1, container.children.length - 1);
  const target = rows[2].children[0];
  target.focus();
  assert.strictEqual(doc.activeElement, target);

  list.refresh();
  assert.notStrictEqual(doc.activeElement, target, 'the old node really was unmounted');
  assert.ok(doc.activeElement, 'focus was dropped on the floor');
  assert.strictEqual(doc.activeElement.getAttribute('data-focus-key'), 'star');
  assert.strictEqual(
    doc.activeElement.getAttribute('data-item'),
    target.getAttribute('data-item'),
    'focus landed on a different row'
  );
});

s.test('shrinking the list under a deep scroll pulls the viewport back onto the content', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 340;
  const many = [];
  for (let i = 0; i < 120; i += 1) many.push({ id: `h-${i}` });

  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    keyOf: (item) => item.id,
    renderRow: () => doc.createElement('div'),
  });
  list.setItems(many);
  container.scrollTop = 120 * VIRTUAL_ROW_HEIGHT - 340;
  container.fire('scroll');
  assert.ok(list.renderedRange().end === 120);

  // Now the search box filters it down to three matches.
  list.setItems(many.slice(0, 3));
  const range = list.renderedRange();
  deepEqual({ start: range.start, end: range.end, total: range.total }, { start: 0, end: 3, total: 3 });
  assert.strictEqual(container.scrollTop, 0, 'the scroller was left pointing past the content');
  const rows = container.children.filter((c) => c.getAttribute('role') === 'listitem');
  assert.strictEqual(rows.length, 3);
});

s.test('an empty list renders nothing but two zero-height spacers', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 200;
  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    renderRow: () => doc.createElement('div'),
  });
  list.setItems([]);
  deepEqual(list.renderedRange(), { start: 0, end: 0, count: 0, total: 0 });
  assert.strictEqual(container.children.length, 2);
  assert.strictEqual(container.children[0].style.height, '0px');
  assert.strictEqual(container.children[1].style.height, '0px');
  assert.strictEqual(list.itemCount(), 0);
});

s.test('a renderRow that throws costs that row, not the list', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 200;
  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    renderRow: (item) => {
      if (item.bad) throw new Error('cannot render this one');
      return doc.createElement('div');
    },
  });
  list.setItems([{ id: 1 }, { bad: true }, { id: 3 }]);
  const rows = container.children.filter((c) => c.getAttribute('role') === 'listitem');
  assert.strictEqual(rows.length, 2, 'the two good rows must still be there');
});

s.test('destroy() removes the scroll listener and empties the container, idempotently', () => {
  const doc = makeFakeDocument();
  const container = makeFakeElement('div', doc);
  container.clientHeight = 200;
  const list = createVirtualList({
    container,
    rowHeight: VIRTUAL_ROW_HEIGHT,
    document: doc,
    renderRow: () => doc.createElement('div'),
  });
  list.setItems([{ id: 1 }, { id: 2 }]);
  assert.strictEqual(container.listeners.length, 1, 'exactly one scroll listener is attached');

  list.destroy();
  assert.strictEqual(container.listeners.length, 0, 'the scroll listener leaked');
  assert.strictEqual(container.removedListeners.length, 1);
  assert.strictEqual(container.removedListeners[0].type, 'scroll');
  assert.strictEqual(container.children.length, 0);
  deepEqual(list.renderedRange(), { start: 0, end: 0, count: 0, total: 0 });

  list.destroy();
  assert.strictEqual(container.removedListeners.length, 1, 'destroy() must be idempotent');

  // A destroyed list is inert, not broken.
  list.setItems([{ id: 3 }]);
  assert.strictEqual(container.children.length, 0);
});

/* ========================================================================== */
/* 5. Workspace profiles (FDD #77, FEATURE-MECHANICS §6.2)                    */
/* ========================================================================== */

s.test('seeding writes the two defaults to suno_profiles when the key is empty', () => {
  const storage = makeFakeStorage();
  const store = createProfileStore({ storage, defaults: DEFAULT_PROFILES });

  const outcome = store.seedDefaults();
  assert.strictEqual(outcome.seeded, true);
  assert.strictEqual(outcome.persisted, true);
  deepEqual(outcome.names.slice().sort(), ['Aetheris', 'Neon']);

  deepEqual(
    Object.keys(storage.data),
    [PROFILES_KEY],
    'profiles must be the ONLY key this store writes'
  );
  const stored = JSON.parse(storage.data[PROFILES_KEY]);
  deepEqual(Object.keys(stored).sort(), ['Aetheris', 'Neon']);
  // §6.2 shape: sliders, genres (genre-section tags), metatags, savedAt.
  for (const name of ['Neon', 'Aetheris']) {
    const profile = stored[name];
    assert.strictEqual(profile.name, name);
    deepEqual(Object.keys(profile.sliders).sort(), ['density', 'energy', 'warmth']);
    assert.ok(profile.genres.length >= 4, `${name} must carry at least four genre tags`);
    assert.ok(profile.metatags.length > 0, `${name} must carry metatags`);
    assert.strictEqual(typeof profile.savedAt, 'number');
  }
});

s.test('seeding NEVER runs a second time — a deleted profile stays deleted', () => {
  const storage = makeFakeStorage();
  createProfileStore({ storage, defaults: DEFAULT_PROFILES }).seedDefaults();

  const second = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
  const writesBefore = storage.writes.length;
  const outcome = second.seedDefaults();
  assert.strictEqual(outcome.seeded, false, 'the defaults were seeded over an existing library');
  assert.strictEqual(storage.writes.length, writesBefore, 'a no-op seed must not write');
  assert.strictEqual(second.count(), 2);

  // Delete one, reload: it stays gone.
  second.remove('Neon');
  const third = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
  assert.strictEqual(third.seedDefaults().seeded, false);
  deepEqual(third.list().map((p) => p.name), ['Aetheris']);
});

s.test('an empty, corrupt, foreign or hostile stored record re-seeds instead of throwing', () => {
  for (const raw of ['', '{', 'null', '[]', '"a string"', '{"Neon":42}', '{"":{"name":""}}', '{"x":{"name":"   "}}']) {
    const storage = makeFakeStorage({ [PROFILES_KEY]: raw });
    const store = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
    assert.doesNotThrow(() => store.load(), `load() threw on ${JSON.stringify(raw)}`);
    const outcome = store.seedDefaults();
    assert.strictEqual(outcome.seeded, true, `${JSON.stringify(raw)} should have re-seeded`);
    assert.strictEqual(store.count(), 2);
  }
});

s.test('a missing or hostile storage never breaks the profile store', () => {
  for (const storage of [
    null,
    undefined,
    {},
    { getItem: 1, setItem: 2 },
    {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    },
  ]) {
    const store = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
    const outcome = store.seedDefaults();
    // The profiles still exist for this session; they just may not persist.
    assert.strictEqual(outcome.seeded, true);
    assert.strictEqual(store.count(), 2);
    assert.strictEqual(store.get('Neon').name, 'Neon');
  }
});

s.test('a profile round-trips through the store and back into a workspace', () => {
  const storage = makeFakeStorage();
  const store = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
  store.seedDefaults();

  const source = populate(makeRegistry());
  const profile = profileFromWorkspace('My club bed', source);
  assert.ok(profile, 'profileFromWorkspace returned nothing');
  deepEqual(profile.sliders, { energy: 86, warmth: 32, density: 74 });
  deepEqual(profile.genres.map((g) => g.tag), ['french electro', 'techno']);
  deepEqual(profile.metatags, ['[Intro]', '[Chorus]', '[Outro]']);

  assert.strictEqual(store.save(profile).ok, true);
  const reloaded = createProfileStore({ storage, defaults: DEFAULT_PROFILES }).get('My club bed');
  deepEqual(reloaded.sliders, profile.sliders);
  deepEqual(reloaded.genres, profile.genres);
  deepEqual(reloaded.metatags, profile.metatags);

  const target = makeRegistry();
  const applied = applyProfileToWorkspace(reloaded, target);
  assert.strictEqual(applied.ok, true, applied.reason);
  deepEqual(target.promptState.list('genre').map((e) => e.tag), ['french electro', 'techno']);
  deepEqual(
    target.structure.blocks().map((b) => b.section),
    ['Intro', 'Chorus', 'Outro']
  );
  deepEqual(
    { e: target.sliders.get('energy'), w: target.sliders.get('warmth'), d: target.sliders.get('density') },
    { e: 86, w: 32, d: 74 }
  );
});

s.test('loading a profile REPLACES the genre section rather than merging into it', () => {
  const registry = populate(makeRegistry());
  const neon = normalizeProfile(DEFAULT_PROFILES[0]);
  applyProfileToWorkspace(neon, registry);
  const genres = registry.promptState.list('genre').map((e) => e.tag);
  deepEqual(genres, neon.genres.map((g) => g.tag));
  assert.strictEqual(genres.indexOf('french electro') !== -1, true, 'Neon carries french electro itself');
  // Everything OUTSIDE the genre section is a profile's business no more.
  assert.ok(
    registry.promptState.list('mood').length > 0,
    'a profile must not wipe sections it does not own'
  );
});

s.test('§6.2: a profile load recomputes the character budget SYNCHRONOUSLY', () => {
  const registry = makeRegistry();
  const notifications = [];
  const budgets = [];
  let microtaskRan = false;

  registry.promptState.subscribe(() => {
    notifications.push('prompt');
    // This is the real gauge computation the style card's subscriber performs.
    budgets.push(buildFinalPrompt(registry.promptState, registry.exclusions.list()).length);
  });

  Promise.resolve().then(() => {
    microtaskRan = true;
  });

  const outcome = applyProfileToWorkspace(normalizeProfile(DEFAULT_PROFILES[0]), registry);

  assert.strictEqual(outcome.ok, true, outcome.reason);
  assert.ok(notifications.length > 0, 'the prompt store never published during the load');
  assert.ok(budgets.length > 0, 'the character budget was never recomputed');
  assert.ok(budgets[budgets.length - 1] > 0, 'the recomputed budget is empty');
  assert.strictEqual(
    microtaskRan,
    false,
    'the recompute was deferred — §6.2 requires it in the same task, not even a microtask later'
  );
  assert.strictEqual(registry.setCalls.length, SLIDER_AXES.length, 'every slider must be written');
  deepEqual(registry.setCalls.map((c) => c.axis), SLIDER_AXES.slice());
});

s.test('profile names are validated the same way going in and coming back', () => {
  assert.strictEqual(validateProfileName('Neon').ok, true);
  assert.strictEqual(validateProfileName('  Neon  ').value, 'Neon');
  for (const bad of ['', '   ', null, undefined, 42, {}, 'x'.repeat(61)]) {
    const verdict = validateProfileName(bad);
    assert.strictEqual(verdict.ok, false, `${JSON.stringify(bad)} was accepted as a profile name`);
    assert.ok(verdict.reason);
  }
  assert.strictEqual(validateProfileName('x'.repeat(60)).ok, true, '60 characters is the limit, not past it');

  const store = createProfileStore({ storage: makeFakeStorage(), defaults: [] });
  assert.strictEqual(store.save({ name: '' }).ok, false);
  assert.strictEqual(store.save({ name: 'x'.repeat(61) }).ok, false);
  assert.strictEqual(store.save(null).ok, false);
});

s.test('deleting a profile removes exactly that one, and reports honestly', () => {
  const storage = makeFakeStorage();
  const store = createProfileStore({ storage, defaults: DEFAULT_PROFILES });
  store.seedDefaults();
  assert.strictEqual(store.remove('Neon'), true);
  assert.strictEqual(store.remove('Neon'), false, 'a second delete found nothing');
  assert.strictEqual(store.remove('never existed'), false);
  deepEqual(store.list().map((p) => p.name), ['Aetheris']);
  deepEqual(Object.keys(JSON.parse(storage.data[PROFILES_KEY])), ['Aetheris']);
});

s.test('applyProfileToWorkspace refuses anything that is not a profile', () => {
  const registry = populate(makeRegistry());
  const before = snapshotOf(registry);
  for (const bad of [null, undefined, 42, 'Neon', [], {}, { name: '' }]) {
    const outcome = applyProfileToWorkspace(bad, registry);
    assert.strictEqual(outcome.ok, false, `${JSON.stringify(bad)} was applied`);
    assert.strictEqual(snapshotOf(registry), before, 'a refused profile mutated the workspace');
  }
});

/* --- DEFAULT_PROFILES <-> tests/e2e/profiles.json ------------------------- */

s.test('DEFAULT_PROFILES is musically equivalent to tests/e2e/profiles.json', () => {
  const seed = JSON.parse(fs.readFileSync(PROFILES_JSON, 'utf8'));
  // The VERY function tests/e2e/nightly.js runs — not a second copy of it, so
  // the two can never disagree about what "equivalent" means.
  const verdict = nightly.validateSeededDefaults(DEFAULT_PROFILES, seed);
  assert.strictEqual(verdict.ok, true, `nightly would fail:\n  - ${verdict.errors.join('\n  - ')}`);
  assert.strictEqual(verdict.checked, nightly.REQUIRED_PROFILES.length);
  for (const required of nightly.REQUIRED_PROFILES) {
    assert.ok(verdict.names.includes(required), `DEFAULT_PROFILES is missing "${required}"`);
  }
});

s.test('the equivalence check has teeth: a drifted profile is caught', () => {
  const seed = JSON.parse(fs.readFileSync(PROFILES_JSON, 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(DEFAULT_PROFILES));

  const missing = clone().filter((p) => p.name !== 'Neon');
  assert.strictEqual(nightly.validateSeededDefaults(missing, seed).ok, false, 'a missing profile passed');

  const wrongGenre = clone();
  wrongGenre[0].genres = [
    { tag: 'polka', weight: 1 },
    { tag: 'sea shanty', weight: 1 },
    { tag: 'barbershop', weight: 1 },
    { tag: 'bagpipes', weight: 1 },
  ];
  assert.strictEqual(nightly.validateSeededDefaults(wrongGenre, seed).ok, false, 'a genre swap passed');

  const zoneDrift = clone();
  zoneDrift[0].sliders.energy = 12; // Neon is a HIGH-energy profile
  assert.strictEqual(nightly.validateSeededDefaults(zoneDrift, seed).ok, false, 'a slider-zone drift passed');

  const tooFew = clone();
  tooFew[1].genres = tooFew[1].genres.slice(0, 2);
  assert.strictEqual(nightly.validateSeededDefaults(tooFew, seed).ok, false, 'a two-tag profile passed');

  const badWeight = clone();
  badWeight[1].genres[0].weight = 0;
  assert.strictEqual(nightly.validateSeededDefaults(badWeight, seed).ok, false, 'a zero weight passed');

  // A REWORDING inside the same family is fine — that is the tolerance the
  // check is designed to have.
  const reworded = clone();
  reworded[1].genres[1].tag = 'afro house groove';
  assert.strictEqual(
    nightly.validateSeededDefaults(reworded, seed).ok,
    true,
    'a same-family rewording should not fail the nightly'
  );
});

s.test('nightly extracts DEFAULT_PROFILES from the real #app-main, not from a fixture', () => {
  const extracted = nightly.extractDefaultProfiles();
  assert.strictEqual(extracted.ok, true, extracted.error || 'extraction failed');
  deepEqual(
    extracted.profiles.map((p) => p.name).sort(),
    ['Aetheris', 'Neon'],
    'the shipped array is not what the nightly will read'
  );
  deepEqual(extracted.profiles, DEFAULT_PROFILES);
});

/* ========================================================================== */
/* 6. Presets, JSON backup and restore (FDD #86, #93)                         */
/* ========================================================================== */

s.test('preset names are validated and trimmed, with 60 characters as the ceiling', () => {
  assert.strictEqual(PRESET_NAME_MAX, 60);
  assert.strictEqual(validatePresetName('  Warehouse   techno  ').value, 'Warehouse techno');
  for (const bad of ['', '    ', null, undefined, 7, [], 'x'.repeat(61)]) {
    assert.strictEqual(validatePresetName(bad).ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  assert.strictEqual(validatePresetName('x'.repeat(60)).ok, true);
});

s.test('the export document has the documented shape and carries no local ids', () => {
  const workspace = serializeWorkspace(populate(makeRegistry()), { savedAt: 500 });
  const records = [
    createPresetRecord('Neon bed', workspace, { savedAt: 500, favorite: true }),
    createPresetRecord('Dusk pads', workspace, { savedAt: 400 }),
  ];

  const doc = buildPresetExport(records);
  assert.strictEqual(doc.schema, PRESET_EXPORT_SCHEMA);
  assert.strictEqual(doc.version, PRESET_EXPORT_VERSION);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(doc.exportedAt), 'exportedAt must be an ISO timestamp');
  assert.strictEqual(doc.presets.length, 2);
  deepEqual(Object.keys(doc.presets[0]).sort(), ['favorite', 'name', 'savedAt', 'workspace']);
  assert.strictEqual(doc.presets[0].name, 'Neon bed');
  assert.strictEqual(doc.presets[0].favorite, true);
  assert.strictEqual(doc.presets[0].workspace.workspaceVersion, WORKSPACE_VERSION);

  const json = serializePresetExport(records);
  assert.ok(json.indexOf('\n  "schema"') !== -1, 'the backup must be pretty-printed for a human');
  const parsed = JSON.parse(json);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(parsed.exportedAt), 'the serialized copy stamps its own export time');
  // Everything but the timestamp: two calls a millisecond apart legitimately
  // disagree about `exportedAt`, and a test that failed on that would be
  // testing the clock rather than the export.
  delete parsed.exportedAt;
  const expected = Object.assign({}, doc);
  delete expected.exportedAt;
  deepEqual(parsed, expected);
  for (const record of records) {
    assert.strictEqual(json.indexOf(record.id), -1, 'a local record id leaked into the backup');
  }
});

s.test('the backup filename is dated so two exports never collide', () => {
  assert.strictEqual(
    presetBackupFilename(new Date(Date.UTC(2026, 7, 25, 12, 0, 0))),
    'sunoprompt-presets-2026-08-25.json'
  );
  assert.ok(/^sunoprompt-presets-.+\.json$/.test(presetBackupFilename()));
});

s.test('an export re-imports cleanly — the round trip a backup exists for', () => {
  const workspace = serializeWorkspace(populate(makeRegistry()), { savedAt: 500 });
  const json = serializePresetExport([
    createPresetRecord('Neon bed', workspace, { savedAt: 500 }),
    createPresetRecord('Dusk pads', workspace, { savedAt: 400 }),
  ]);

  const plan = planPresetImport(json, []);
  assert.strictEqual(plan.ok, true, plan.reason);
  deepEqual(plan.counts, { total: 2, accepted: 2, rejected: 0 });
  deepEqual(plan.accepted.map((p) => p.name), ['Neon bed', 'Dusk pads']);
  deepEqual(plan.accepted.map((p) => p.renamedFrom), [null, null]);

  // And the imported workspace really restores.
  const registry = makeRegistry();
  const outcome = restoreWorkspace(plan.accepted[0].workspace, registry);
  assert.strictEqual(outcome.ok, true, outcome.reason);
  assert.strictEqual(serializeWorkspace(registry, { savedAt: 500 }).prompt.length, workspace.prompt.length);
});

s.test('import counts accepts and rejects per preset — one bad entry costs one preset', () => {
  const good = serializeWorkspace(populate(makeRegistry()));
  const payload = {
    schema: PRESET_EXPORT_SCHEMA,
    version: PRESET_EXPORT_VERSION,
    presets: [
      { name: 'Keeper', workspace: good },
      { name: '', workspace: good },
      { name: 'No workspace' },
      { name: 'Bad workspace', workspace: { workspaceVersion: 9 } },
      { name: 'Not an object' , workspace: 'techno' },
      'not even an object',
      { name: 'x'.repeat(61), workspace: good },
      { name: 'Second keeper', workspace: good, favorite: true },
    ],
  };

  const plan = planPresetImport(JSON.stringify(payload), []);
  assert.strictEqual(plan.ok, true, plan.reason);
  deepEqual(plan.counts, { total: 8, accepted: 2, rejected: 6 });
  deepEqual(plan.accepted.map((p) => p.name), ['Keeper', 'Second keeper']);
  assert.strictEqual(plan.accepted[1].favorite, true);
  for (const rejection of plan.rejected) {
    assert.ok(rejection.name, 'every rejection must name what it refused');
    assert.ok(rejection.reason, `"${rejection.name}" was rejected without a reason`);
  }
});

s.test('a name collision renames the incoming preset instead of overwriting one', () => {
  const good = serializeWorkspace(populate(makeRegistry()));
  const payload = {
    schema: PRESET_EXPORT_SCHEMA,
    version: PRESET_EXPORT_VERSION,
    presets: [
      { name: 'Neon', workspace: good },
      { name: 'Neon', workspace: good },
      { name: 'Neon', workspace: good },
      { name: 'Fresh', workspace: good },
    ],
  };
  const plan = planPresetImport(payload, ['Neon']);
  assert.strictEqual(plan.ok, true);
  deepEqual(plan.accepted.map((p) => p.name), [
    'Neon (imported)',
    'Neon (imported 2)',
    'Neon (imported 3)',
    'Fresh',
  ]);
  deepEqual(plan.accepted.map((p) => p.renamedFrom), ['Neon', 'Neon', 'Neon', null]);
});

s.test('a collision-renamed name is trimmed to fit the 60-character ceiling', () => {
  const long = 'x'.repeat(60);
  const renamed = uniquePresetName(long, [long]);
  assert.ok(renamed.length <= PRESET_NAME_MAX, `"${renamed}" is ${renamed.length} characters`);
  assert.ok(renamed.endsWith(' (imported)'), 'the suffix explains where it came from and must survive');
  assert.strictEqual(uniquePresetName('Neon', []), 'Neon', 'no collision means no suffix');
  assert.strictEqual(uniquePresetName('neon', ['NEON']), 'neon (imported)', 'collisions are case-insensitive');
  assert.strictEqual(uniquePresetName('', []), 'preset', 'a nameless import still gets a usable name');
});

s.test('the paste path validates before it commits anything', () => {
  const cases = [
    ['', /empty/i],
    ['   ', /empty/i],
    ['not json at all', /not valid JSON/i],
    ['[]', /not a preset backup object/i],
    ['42', /not a preset backup object/i],
    ['{"schema":"something-else","version":1,"presets":[]}', /not a SunoPrompt preset backup/i],
    [`{"schema":"${PRESET_EXPORT_SCHEMA}","version":99,"presets":[]}`, /backup version/i],
    [`{"schema":"${PRESET_EXPORT_SCHEMA}","version":1,"presets":"none"}`, /must be an array/i],
  ];
  for (const [raw, pattern] of cases) {
    const plan = planPresetImport(raw, []);
    assert.strictEqual(plan.ok, false, `${JSON.stringify(raw)} was accepted`);
    assert.ok(pattern.test(plan.reason), `unexpected reason for ${JSON.stringify(raw)}: ${plan.reason}`);
    deepEqual(plan.accepted, []);
    deepEqual(plan.counts, { total: 0, accepted: 0, rejected: 0 });
  }
  // An empty but well-formed backup is valid — it just imports nothing.
  const empty = planPresetImport(`{"schema":"${PRESET_EXPORT_SCHEMA}","version":1,"presets":[]}`, []);
  assert.strictEqual(empty.ok, true);
  deepEqual(empty.counts, { total: 0, accepted: 0, rejected: 0 });
});

s.test('a byte-order mark on a pasted or uploaded file does not break the import', () => {
  const json = serializePresetExport([
    createPresetRecord('Neon bed', serializeWorkspace(populate(makeRegistry()))),
  ]);
  const plan = planPresetImport(String.fromCharCode(0xfeff) + json, []);
  assert.strictEqual(plan.ok, true, plan.reason);
  assert.strictEqual(plan.counts.accepted, 1);
});

/* ========================================================================== */
/* 7. The autosave debouncer                                                  */
/* ========================================================================== */

s.test('the debouncer collapses a burst into one trailing call', () => {
  const timers = [];
  const calls = [];
  const debounced = createDebouncer(
    () => calls.push(Date.now()),
    AUTOSAVE_DEBOUNCE_MS,
    {
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms, cancelled: false });
        return timers.length;
      },
      clearTimeoutFn: (handle) => {
        if (timers[handle - 1]) timers[handle - 1].cancelled = true;
      },
    }
  );

  debounced.trigger();
  debounced.trigger();
  debounced.trigger();
  assert.strictEqual(calls.length, 0, 'a debounced call must not fire immediately');
  assert.strictEqual(debounced.isPending(), true);
  assert.strictEqual(timers.length, 3, 'each trigger re-arms the timer');
  deepEqual(timers.map((t) => t.cancelled), [true, true, false], 'earlier timers must be cancelled');
  assert.strictEqual(timers[2].ms, AUTOSAVE_DEBOUNCE_MS);

  timers[2].fn();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(debounced.isPending(), false);
});

s.test('flush() lands the pending save, and does nothing when there is none', () => {
  const timers = [];
  let calls = 0;
  const debounced = createDebouncer(() => (calls += 1), 800, {
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeoutFn: () => {},
  });

  assert.strictEqual(debounced.flush(), false, 'nothing pending, nothing to flush');
  assert.strictEqual(calls, 0);

  debounced.trigger();
  assert.strictEqual(debounced.flush(), true);
  assert.strictEqual(calls, 1, 'the pending save landed');
  assert.strictEqual(debounced.flush(), false, 'flushing twice must not save twice');

  debounced.trigger();
  debounced.cancel();
  assert.strictEqual(debounced.isPending(), false);
  assert.strictEqual(debounced.flush(), false);
  assert.strictEqual(calls, 1);
});

s.test('a throwing autosave cannot take the interaction that triggered it down', () => {
  const timers = [];
  const debounced = createDebouncer(
    () => {
      throw new Error('quota exceeded');
    },
    10,
    {
      setTimeoutFn: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeoutFn: () => {},
    }
  );
  debounced.trigger();
  assert.doesNotThrow(() => timers[0]());
  assert.strictEqual(debounced.isPending(), false);
});

/* ========================================================================== */
/* 8. Static markup, id and wiring contracts                                  */
/* ========================================================================== */

s.test('the three new cards ship with their ids, headings and labelled regions', () => {
  const html = readIndex();

  for (const id of [
    // Workspace profiles (FDD #77)
    'profile-select',
    'profile-name',
    'profile-status',
    'btn-profile-save',
    'btn-profile-load',
    'btn-profile-delete',
    // History (FDD #74)
    'history-list',
    'history-search',
    'history-empty',
    'history-counts',
    'history-status',
    'history-persistence',
    'btn-history-clear',
    // Presets and backup (FDD #86 / #93)
    'preset-name',
    'btn-preset-save',
    'presets-list',
    'presets-empty',
    'presets-counts',
    'presets-status',
    'btn-presets-export',
    'btn-presets-copy',
    'preset-import-file',
    'preset-import-text',
    'btn-preset-import-text',
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }

  for (const heading of ['profile-heading', 'history-heading', 'presets-heading']) {
    assert.ok(
      new RegExp(`aria-labelledby="${heading}"`).test(html),
      `no region is labelled by #${heading}`
    );
    assert.ok(new RegExp(`id="${heading}"`).test(html), `#${heading} does not exist`);
  }

  // Every control that is a field has a real <label for>.
  for (const id of ['profile-select', 'profile-name', 'history-search', 'preset-name', 'preset-import-file', 'preset-import-text']) {
    assert.ok(new RegExp(`for="${id}"`).test(html), `#${id} has no <label for>`);
  }

  // Both scrollers are labelled lists the keyboard can reach.
  for (const id of ['history-list', 'presets-list']) {
    const tag = new RegExp(`<div[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(tag, `#${id} is not a div`);
    assert.ok(/class="vlist"/.test(tag[0]), `#${id} must carry the .vlist scroller class`);
    assert.ok(/tabindex="0"/.test(tag[0]), `#${id} must be keyboard reachable`);
    assert.ok(/aria-label="/.test(tag[0]), `#${id} must be named for a screen reader`);
  }

  // The import control accepts JSON specifically, not "any file".
  assert.ok(/accept="\.json,application\/json"/.test(html), 'the file input must declare what it accepts');
});

s.test('a successful style-prompt copy is what appends to the history bank', () => {
  const source = app.source;
  const handler = /styleCopyBtn\.addEventListener\([\s\S]*?\n    \}\);/.exec(source);
  assert.ok(handler, 'the style copy handler could not be located');
  assert.ok(
    /const done = function \(\)[\s\S]*?appendHistoryEntry\(final\.text, final\.tags\.length\);/.test(handler[0]),
    'the history append must sit inside the SUCCESS callback, not beside the click'
  );
  // And nowhere else: a failed copy must never bank a prompt. Comments and the
  // declaration itself are not call sites, so both are excluded.
  const callSites = source
    .split(/\r?\n/)
    .filter(
      (line) =>
        /appendHistoryEntry\(/.test(line) &&
        !/^\s*(?:\*|\/\/)/.test(line) && // a comment naming it is not a call
        !/^\s*function\s/.test(line) // nor is the declaration
    );
  const declarations = source.match(/function appendHistoryEntry\(/g) || [];
  assert.strictEqual(declarations.length, 1, 'appendHistoryEntry must be declared exactly once');
  assert.strictEqual(
    callSites.length,
    1,
    `appendHistoryEntry is invoked ${callSites.length} times — the only caller is the successful copy`
  );
});

s.test('the seeding call runs at boot, before anything asynchronous', () => {
  const source = app.source;
  assert.ok(/profileStore\.seedDefaults\(\)/.test(source), 'boot never seeds the default profiles');
  const seedAt = source.indexOf('profileStore.seedDefaults()');
  const restoreAt = source.indexOf('idb.get(IDB_SESSION, AUTOSAVE_ID)');
  assert.ok(seedAt !== -1 && restoreAt !== -1);
  assert.ok(seedAt < restoreAt, 'contract F: profiles are seeded before the session is restored');
  assert.ok(
    /createProfileStore\(\{\s*storage: prefsStorage/.test(source),
    'the profile store must be handed the same guarded localStorage handle the theme prefs use'
  );
});

s.test('the autosave is debounced, subscribed to all three stores and flushed on hide', () => {
  const source = app.source;
  assert.ok(
    new RegExp(`createDebouncer\\([\\s\\S]{0,900}?AUTOSAVE_DEBOUNCE_MS\\)`).test(source),
    'the autosave must run through createDebouncer at AUTOSAVE_DEBOUNCE_MS'
  );
  assert.strictEqual(AUTOSAVE_DEBOUNCE_MS, 800, 'contract F asks for roughly 800ms');
  for (const store of ['promptState', 'exclusions', 'structure']) {
    assert.ok(
      new RegExp(`${store}\\.subscribe\\(scheduleAutosave\\)`).test(source),
      `${store} changes do not trigger an autosave`
    );
  }
  assert.ok(/autosave\.flush\(\)/.test(source), 'a debounced save that never flushes loses the last edit');
  assert.ok(/'pagehide'/.test(source) && /visibilitychange/.test(source), 'the flush must be armed on both hide paths');
  assert.ok(
    /snapshot\.id = AUTOSAVE_ID;[\s\S]{0,200}idb\.put\(IDB_SESSION, snapshot\)/.test(source),
    'the autosave must write the reserved record into the session store'
  );
});

s.test('every IndexedDB call in the boot code handles its own rejection', () => {
  const source = app.source;
  /* Every call site must do ONE of three things with the promise it gets:
   *   - hand it to ignoreRejection(), which attaches a catch;
   *   - `return` it, so the caller owns the outcome;
   *   - push it into an array that is later handed to Promise.all() and
   *     handled there.
   * Anything else is a promise nobody is watching, which is exactly the
   * unhandled rejection ENGINEERING-STANDARD §2.3 forbids. */
  const allowed = /(?:ignoreRejection\(\s*|return\s+|\.push\(\s*)$/;
  const call = /idb\.(?:put|get|getAll|delete|count|clear|ready)\(/g;
  const unguarded = [];
  let found = 0;
  let m;
  while ((m = call.exec(source)) !== null) {
    found += 1;
    const before = source.slice(Math.max(0, m.index - 40), m.index);
    if (!allowed.test(before)) unguarded.push(`…${before.slice(-24).replace(/\s+/g, ' ')}${m[0]}`);
  }
  assert.ok(found >= 8, `only ${found} idb calls found — the wiring is missing`);
  deepEqual(unguarded, [], `an idb call is issued without handling its rejection:\n  ${unguarded.join('\n  ')}`);

  const wrapped = source.match(/ignoreRejection\(\s*idb\./g) || [];
  assert.ok(wrapped.length >= 4, 'fire-and-forget idb calls must go through ignoreRejection');
  const promiseAll = source.match(/Promise\.all\((?:drops|writes)\)/g) || [];
  assert.ok(promiseAll.length >= 2, 'the batched writes must be joined and their rejection handled');
});

s.test('both windowed lists are repainted when the editor view becomes visible', () => {
  const source = app.source;
  // A [hidden] element has no layout, so a list painted at boot measured a
  // clientHeight of 0 and rendered only its overscan. The view manager has to
  // repaint it the moment the scroller actually has a height.
  assert.ok(/function refreshPersistenceLists\(\)/.test(source), 'no repaint hook exists');
  assert.ok(
    /if \(id === 'editor'\) refreshPersistenceLists\(\);/.test(source),
    'the editor view switch must repaint the windowed lists'
  );
  assert.ok(
    /historyView\.refresh\(\);\s*\n\s*presetsView\.refresh\(\);/.test(source),
    'the repaint must cover BOTH lists'
  );
});

s.test('the storage status line reports BOTH stores, honestly', () => {
  const source = app.source;
  assert.ok(/function renderStorageStatus\(\)/.test(source));
  assert.ok(/idb\.isPersistent\(\)/.test(source), 'the status must ask the store, not assume');
  assert.ok(
    /historyNote\.hidden = durable;/.test(source),
    'the "will not survive a reload" note must appear exactly when writes are not durable'
  );
  assert.ok(
    /will not survive a reload/.test(source),
    'the honest wording contract A asks for is missing'
  );
});

s.test('the persistence CSS is token-driven and lives in both themes', () => {
  const css = readStyle();
  for (const selector of ['.profile-row', '.vlist', '.vrow', '.vrow-actions', '.storage-note', '.btn-star']) {
    assert.ok(css.indexOf(selector) !== -1, `the stylesheet has no ${selector} rule`);
  }
  // Code Mode has to reach the new surfaces too.
  for (const selector of ['.high-contrast .vlist', '.high-contrast .vrow', '.high-contrast .storage-note']) {
    assert.ok(css.indexOf(selector) !== -1, `Code Mode does not override ${selector}`);
  }
  // The scroller needs a real viewport or there is nothing to window against.
  const vlist = /\.vlist\s*\{([^}]*)\}/.exec(css);
  assert.ok(vlist, 'no .vlist rule');
  assert.ok(/max-height:\s*\d+px/.test(vlist[1]), '.vlist must bound its height');
  assert.ok(/overflow-y:\s*auto/.test(vlist[1]), '.vlist must scroll');
});

s.test('the persistence section documents the FDD #74 / §6.4 conflict resolution', () => {
  const source = app.source;
  assert.ok(/FEATURE-MECHANICS/.test(source));
  assert.ok(
    /§6\.4/.test(source) && /§6\.2/.test(source),
    'both mechanics sections must be cited where the decision was made'
  );
  assert.ok(
    /localStorage is (?:synchronous|strictly)/i.test(source) || /strictly reserved/i.test(source),
    'the reason localStorage is not the history store must be written down'
  );
  assert.ok(
    /'suno_profiles'/.test(source) || /suno_profiles/.test(source),
    'the §6.2 key must be named in the source'
  );
});

s.test('the whole #app-main writes only the two documented localStorage keys', () => {
  const source = app.source;
  // Literal-keyed writes: only the storage probe (asserted by ai-dissector too).
  const literalWrites = source.match(/\.setItem\s*\(\s*(['"])([^'"]*)\1/g) || [];
  deepEqual(literalWrites, [".setItem('suno_storage_probe'"], `unexpected literal write: ${literalWrites.join(' | ')}`);
  // Constant-keyed writes: exactly the two UI-state keys §6.4 permits.
  const constantWrites = source.match(/\.setItem\(\s*([A-Z_]+)\s*,/g) || [];
  const keys = constantWrites.map((hit) => /\(\s*([A-Z_]+)\s*,/.exec(hit)[1]).sort();
  deepEqual(
    Array.from(new Set(keys)),
    ['PROFILES_KEY', 'UI_PREFS_KEY'],
    'localStorage is reserved for lightweight UI state (FEATURE-MECHANICS.md §6.4)'
  );
});

s.test('boot stays inert without a document — the persistence wiring changes nothing', () => {
  const storage = makeFakeStorage();
  const source = extractScriptById(INDEX, 'app-main');
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Promise,
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
    Float32Array,
    Float64Array,
    Uint8Array,
    ArrayBuffer,
    localStorage: storage,
  };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'app-main#no-dom' }));
  deepEqual(storage.writes, [], 'boot wrote to localStorage outside a browser');
});

s.finish().then((result) => {
  if (!result.ok) process.exitCode = 1;
});
