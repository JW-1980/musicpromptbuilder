'use strict';
/*
 * tests/key-vault.test.js — the opt-in, device-tier API key vault.
 *
 * WHAT IS COVERED
 *   - A real AES-GCM round-trip against Node's WebCrypto — the same
 *     SubtleCrypto the browser exposes, not a stub. If this passes here it is
 *     because the cryptography worked, not because a fake said it did.
 *   - The device key is NON-EXTRACTABLE, which is the property the whole
 *     threat model rests on: the ciphertext is on disk, and the thing that
 *     opens it is not.
 *   - Slot ids: one per presetId::endpointOrigin, so a key can never be sent
 *     to a host it was not entered for.
 *   - Wrong-key decryption surfaces as "could not be unlocked" and NEVER as
 *     bytes. AES-GCM's authentication tag makes that detectable; ignoring it
 *     would mean posting a garbage Authorization header to a real provider.
 *   - forget(), forgetAll(), and list() carrying no key material at all.
 *   - THE HYGIENE REGRESSIONS: no key ever reaches localStorage, a workspace
 *     snapshot or a preset export.
 *
 * The store under test is the REAL createIdbStore running in its documented
 * in-memory mode, so records go through the same copy()/rawStore code the
 * browser path uses. That matters more than it looks: a CryptoKey does not
 * survive copy()'s JSON round-trip, and a vault that silently encrypted with
 * `{}` would pass a test written against a hand-made stub.
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

const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push({ reason: (reason && reason.stack) || String(reason) });
});

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

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

const local = makeRecordingStorage();
const session = makeRecordingStorage();

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
  sessionStorage: session.api,
};
vm.createContext(sandbox);
const SOURCE = extractScriptById(INDEX, 'app-main');
vm.runInContext(SOURCE, sandbox, { filename: 'index.html#app-main' });

const {
  createKeyVault,
  createIdbStore,
  createPromptState,
  createExclusionState,
  createStructureState,
  serializeWorkspace,
  buildPresetExport,
  serializePresetExport,
  IDB_KEYS,
  IDB_DEVICE_KEY,
  IDB_PRESETS,
  DEVICE_KEY_ID,
  VAULT_IV_BYTES,
} = sandbox;

/** A vault over a fresh in-memory store, plus the store itself. */
function makeVault() {
  const idb = createIdbStore({ indexedDB: null });
  return { idb, vault: createKeyVault({ idb }) };
}

const SECRET = 'sk-live-0123456789-not-a-real-key';

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

const s = suite('key-vault (opt-in device-tier API key storage)');

s.test('createKeyVault is a reachable top-level function declaration', () => {
  assert.strictEqual(typeof createKeyVault, 'function');
  assert.strictEqual(DEVICE_KEY_ID, '__device_key');
  assert.strictEqual(VAULT_IV_BYTES, 12, 'AES-GCM wants a 96-bit nonce');
});

s.test('supported() feature-detects rather than trying and failing', () => {
  const { idb, vault } = makeVault();
  assert.strictEqual(vault.supported(), true);

  // Every single missing piece must produce a false, not a throw and not an
  // optimistic true that ends in an unhandled rejection later.
  assert.strictEqual(createKeyVault({ idb, crypto: null, subtle: null }).supported(), false);
  assert.strictEqual(createKeyVault({ idb: null }).supported(), false);
  assert.strictEqual(
    createKeyVault({ idb, subtle: { encrypt() {}, decrypt() {} } }).supported(),
    false,
    'a subtle without generateKey cannot make a device key'
  );
  assert.strictEqual(createKeyVault({}).supported(), false);
});

/* --- slot ids -------------------------------------------------------------- */

s.test('a slot is scoped to presetId + endpoint ORIGIN, never to the whole URL', () => {
  const { vault } = makeVault();

  // Same host, different paths and queries: one key, one slot. Forcing a
  // re-entry every time a path changes would train people not to use this.
  const a = vault.slotId('custom', 'https://api.groq.com/openai/v1');
  const b = vault.slotId('custom', 'https://api.groq.com/openai/v1/chat/completions');
  const c = vault.slotId('custom', 'https://api.groq.com/v2?beta=1');
  assert.strictEqual(a, 'custom::https://api.groq.com');
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);

  // A different host is a DIFFERENT slot, always. This is the property that
  // stops one provider's key being sent to another provider's server after a
  // base-URL edit.
  assert.notStrictEqual(a, vault.slotId('custom', 'https://api.openai.com/v1'));
  assert.notStrictEqual(a, vault.slotId('custom', 'http://api.groq.com/openai/v1'), 'scheme is part of an origin');
  assert.notStrictEqual(a, vault.slotId('custom', 'https://api.groq.com:8443/v1'), 'port is part of an origin');
  // …and so is a different preset against the same host.
  assert.notStrictEqual(a, vault.slotId('openrouter', 'https://api.groq.com/openai/v1'));
});

s.test('every shipped preset gets a slot, Gemini included', async () => {
  /*
   * The vault is preset-agnostic on purpose: it scopes by origin, so a preset
   * whose endpoint is a PATH TEMPLATE rather than a plain URL — Gemini's
   * `…/models/{model}:generateContent` — still resolves to one stable slot on
   * one host. ASSUMPTIONS.md (owner correction 2026-08-25) requires the vault
   * to cover Gemini like every other preset, and "like every other" is only
   * true if nothing about it is special-cased.
   */
  const { vault } = makeVault();
  const endpoints = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    custom: 'https://api.groq.com/openai/v1',
  };
  const slots = {};
  for (const preset of Object.keys(endpoints)) {
    const slot = vault.slotId(preset, endpoints[preset]);
    slots[preset] = slot;
    assert.strictEqual(slot.indexOf(preset + '::'), 0, `${preset}: slot is not scoped to the preset`);
    const stored = await vault.remember(slot, 'key-for-' + preset);
    assert.strictEqual(stored.ok, true, `${preset}: ${stored.error}`);
    const out = await vault.recall(slot);
    assert.strictEqual(out.ok, true, `${preset}: ${out.error}`);
    assert.strictEqual(out.key, 'key-for-' + preset);
  }
  // The template braces did not leak into the slot: the origin is the origin.
  assert.strictEqual(slots.gemini, 'gemini::https://generativelanguage.googleapis.com');
  assert.strictEqual(slots.gemini.indexOf('{model}'), -1, 'the path template reached the slot id');
  // Changing the model in the path must not orphan the key.
  assert.strictEqual(
    vault.slotId('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'),
    slots.gemini
  );
  // Three presets, three distinct slots, no crossover.
  assert.strictEqual(new Set(Object.values(slots)).size, 3);
});

s.test('an unparseable or empty endpoint still yields a stable, scoped slot', () => {
  const { vault } = makeVault();
  assert.strictEqual(vault.slotId('custom', 'not a url'), 'custom::not a url');
  assert.strictEqual(vault.slotId('custom', '  spaced.example  '), 'custom::spaced.example');
  assert.strictEqual(vault.slotId('custom', ''), 'custom::');
  assert.strictEqual(vault.slotId('custom', '   '), 'custom::');
  // A missing preset id falls back to the generic one rather than to ''.
  assert.strictEqual(vault.slotId(null, 'https://x.example'), 'custom::https://x.example');
  assert.strictEqual(vault.slotId(undefined, 'https://x.example'), 'custom::https://x.example');
  // Stable: the same inputs always name the same slot.
  assert.strictEqual(vault.slotId('custom', 'not a url'), vault.slotId('custom', 'not a url'));
});

/* --- the round trip -------------------------------------------------------- */

s.test('remember -> recall returns the exact key, through real AES-GCM', async () => {
  const { vault } = makeVault();
  const slot = vault.slotId('openrouter', 'https://openrouter.ai/api/v1/chat/completions');

  const stored = await vault.remember(slot, SECRET);
  assert.strictEqual(stored.ok, true, stored.error);

  const recalled = await vault.recall(slot);
  assert.strictEqual(recalled.ok, true, recalled.error);
  assert.strictEqual(recalled.key, SECRET);
});

s.test('keys with awkward bytes survive the round trip intact', async () => {
  const { vault } = makeVault();
  const cases = [
    'plain-ascii',
    'sk-with-symbols-!@#$%^&*()_+{}|:"<>?',
    'unicode-ключ-🔑-token',
    'x'.repeat(4096),
    ' leading and trailing spaces ',
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const slot = vault.slotId('custom', 'https://host' + i + '.example');
    await vault.remember(slot, cases[i]);
    const out = await vault.recall(slot);
    assert.strictEqual(out.ok, true, `case ${i}: ${out.error}`);
    assert.strictEqual(out.key, cases[i], `case ${i} came back changed`);
  }
});

s.test('an empty key is refused rather than stored as empty ciphertext', async () => {
  const { vault, idb } = makeVault();
  const slot = vault.slotId('custom', 'https://x.example');
  const out = await vault.remember(slot, '');
  assert.strictEqual(out.ok, false);
  assert.ok(/no key to remember/.test(out.error), out.error);
  assert.strictEqual(await idb.get(IDB_KEYS, slot), null, 'an empty record was written anyway');
});

s.test('recalling an empty slot is "absent", not an error and not a guess', async () => {
  const { vault } = makeVault();
  const out = await vault.recall(vault.slotId('custom', 'https://never-used.example'));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.absent, true);
  assert.strictEqual(out.key, undefined, 'a missing key must not resolve to a value at all');
  assert.strictEqual(await vault.has(vault.slotId('custom', 'https://never-used.example')), false);
});

/* --- what is actually on disk ---------------------------------------------- */

s.test('the stored record holds ciphertext and an IV, and no plaintext anywhere', async () => {
  const { vault, idb } = makeVault();
  const slot = vault.slotId('custom', 'https://api.groq.com/openai/v1');
  await vault.remember(slot, SECRET);

  const record = await idb.get(IDB_KEYS, slot);
  assert.ok(record, 'nothing was stored');
  assert.strictEqual(record.id, slot);
  assert.strictEqual(record.presetId, 'custom');
  assert.strictEqual(record.endpointOrigin, 'https://api.groq.com');
  assert.strictEqual(record.tier, 'device');
  // Reserved for the passphrase tier, present and null so the shape does not
  // change when it lands.
  assert.strictEqual(record.salt, null);
  assert.strictEqual(record.iterations, null);

  // Plain number arrays: `api_keys` is a normal store and still goes through
  // copy()'s JSON round-trip, which would flatten a typed array into an
  // object with numeric keys and break decryption on the next read.
  assert.ok(Array.isArray(record.iv), 'the IV is not a plain array');
  assert.ok(Array.isArray(record.ciphertext), 'the ciphertext is not a plain array');
  assert.strictEqual(record.iv.length, VAULT_IV_BYTES);
  for (const byte of record.iv.concat(record.ciphertext)) {
    assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255, `not a byte: ${byte}`);
  }
  // GCM appends a 16-byte tag, so the ciphertext is longer than the plaintext.
  assert.ok(record.ciphertext.length > SECRET.length, 'ciphertext is suspiciously short');

  // And the secret is nowhere in the serialised record.
  const dumped = JSON.stringify(record);
  assert.strictEqual(dumped.indexOf(SECRET), -1, 'the plaintext key is in the record');
  assert.strictEqual(dumped.indexOf('sk-live'), -1, 'a recognisable fragment of the key survived');
});

s.test('every encryption uses a fresh IV, so identical keys look different', async () => {
  const { vault, idb } = makeVault();
  const one = vault.slotId('custom', 'https://a.example');
  const two = vault.slotId('custom', 'https://b.example');
  await vault.remember(one, SECRET);
  await vault.remember(two, SECRET);

  const a = await idb.get(IDB_KEYS, one);
  const b = await idb.get(IDB_KEYS, two);
  assert.notDeepStrictEqual(a.iv, b.iv, 'the same nonce was reused — that breaks AES-GCM outright');
  assert.notDeepStrictEqual(a.ciphertext, b.ciphertext, 'the same key encrypted to the same bytes twice');
  // …and both still decrypt.
  assert.strictEqual((await vault.recall(one)).key, SECRET);
  assert.strictEqual((await vault.recall(two)).key, SECRET);
});

s.test('THE DEVICE KEY IS NON-EXTRACTABLE — the property the threat model rests on', async () => {
  const { vault, idb } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://x.example'), SECRET);

  const record = await idb.get(IDB_DEVICE_KEY, DEVICE_KEY_ID);
  assert.ok(record && record.key, 'no device key was stored');
  // It survived the store intact — a JSON round-trip would have left `{}`,
  // and the vault would then be "encrypting" with nothing.
  assert.strictEqual(typeof record.key.algorithm, 'object', 'the CryptoKey did not survive the store');
  assert.strictEqual(record.key.algorithm.name, 'AES-GCM');
  assert.strictEqual(record.key.algorithm.length, 256);
  assert.strictEqual(record.key.extractable, false, 'an extractable device key would defeat the whole design');
  await assert.rejects(
    () => webcrypto.subtle.exportKey('raw', record.key),
    'the browser handed the key bytes back — it must refuse'
  );
  // Only the two operations the vault needs.
  assert.deepStrictEqual(record.key.usages.slice().sort(), ['decrypt', 'encrypt']);
});

s.test('the device key is generated once and reused, not per call', async () => {
  const { vault, idb } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://a.example'), SECRET);
  const first = await idb.get(IDB_DEVICE_KEY, DEVICE_KEY_ID);
  await vault.remember(vault.slotId('custom', 'https://b.example'), SECRET);
  await vault.recall(vault.slotId('custom', 'https://a.example'));
  const second = await idb.get(IDB_DEVICE_KEY, DEVICE_KEY_ID);
  assert.strictEqual(first.key, second.key, 'a second device key would orphan every existing slot');
  assert.strictEqual((await idb.getAll(IDB_DEVICE_KEY)).length, 1);
});

/* --- failure modes --------------------------------------------------------- */

s.test('a record that will not decrypt is reported, never turned into bytes', async () => {
  const { vault, idb } = makeVault();
  const slot = vault.slotId('custom', 'https://api.groq.com/openai/v1');
  await vault.remember(slot, SECRET);

  // Flip one byte of the ciphertext: the GCM tag will not verify. This is
  // what a corrupted database, or a tampered one, looks like.
  const record = await idb.get(IDB_KEYS, slot);
  record.ciphertext[0] = (record.ciphertext[0] + 1) % 256;
  await idb.put(IDB_KEYS, record);

  const out = await vault.recall(slot);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.key, undefined, 'garbage was handed back as a key');
  assert.ok(/could not be unlocked/.test(out.error), out.error);
  assert.ok(/enter the key again/.test(out.error), 'the error must say what to do about it');
});

s.test('a slot encrypted under a DIFFERENT device key fails closed', async () => {
  // Two vaults over two databases: the second one's device key cannot open the
  // first one's record. This is the "synced profile, different machine" case.
  const alpha = makeVault();
  const beta = makeVault();
  const slot = alpha.vault.slotId('custom', 'https://api.groq.com/openai/v1');
  await alpha.vault.remember(slot, SECRET);

  const foreign = await alpha.idb.get(IDB_KEYS, slot);
  await beta.idb.put(IDB_KEYS, foreign);
  await beta.vault.remember(beta.vault.slotId('custom', 'https://other.example'), 'seed');

  const out = await beta.vault.recall(slot);
  assert.strictEqual(out.ok, false);
  assert.ok(/could not be unlocked/.test(out.error), out.error);
});

s.test('an unsupported vault refuses to store instead of falling back to plaintext', async () => {
  const idb = createIdbStore({ indexedDB: null });
  const vault = createKeyVault({ idb, crypto: null, subtle: null });
  const slot = 'custom::https://x.example';

  const stored = await vault.remember(slot, SECRET);
  assert.strictEqual(stored.ok, false);
  assert.ok(/cannot encrypt/.test(stored.error), stored.error);
  assert.strictEqual(await idb.get(IDB_KEYS, slot), null, 'a plaintext fallback was written');

  const recalled = await vault.recall(slot);
  assert.strictEqual(recalled.ok, false);
  assert.ok(/unavailable/.test(recalled.error), recalled.error);
});

/* --- forgetting ------------------------------------------------------------ */

s.test('forget() drops one slot and leaves the others alone', async () => {
  const { vault, idb } = makeVault();
  const doomed = vault.slotId('custom', 'https://a.example');
  const kept = vault.slotId('custom', 'https://b.example');
  await vault.remember(doomed, SECRET);
  await vault.remember(kept, 'another-key');

  assert.strictEqual(await vault.forget(doomed), true, 'forget() must report that something went');
  assert.strictEqual(await vault.forget(doomed), false, 'a second forget finds nothing');
  assert.strictEqual(await idb.get(IDB_KEYS, doomed), null);
  assert.strictEqual((await vault.recall(kept)).key, 'another-key');
});

s.test('forgetAll() takes the keys AND the device key that opens them', async () => {
  const { vault, idb } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://a.example'), SECRET);
  await vault.remember(vault.slotId('openrouter', 'https://openrouter.ai/api/v1'), 'or-key');
  assert.strictEqual((await vault.list()).length, 2);

  const out = await vault.forgetAll();
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dropped, 2);
  assert.strictEqual((await vault.list()).length, 0);
  // Leaving the device key behind would keep the thing that decrypts secrets
  // on disk after the user asked for the secrets to be gone.
  assert.strictEqual(await idb.get(IDB_DEVICE_KEY, DEVICE_KEY_ID), null, 'the device key survived forgetAll()');

  // And the vault still works afterwards: a new device key is minted on demand.
  const slot = vault.slotId('custom', 'https://c.example');
  assert.strictEqual((await vault.remember(slot, 'fresh')).ok, true);
  assert.strictEqual((await vault.recall(slot)).key, 'fresh');
});

s.test('forgetAll() is the cure for an ORPHANED slot with no row to forget', async () => {
  // The scenario: a key remembered for one base URL, then the endpoint edited
  // to a different host. The old slot is unreachable from the UI — nothing
  // addresses it any more — so the storage card's blanket control is the only
  // way to get rid of it.
  const { vault } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://typo.exmaple.com/v1'), SECRET);
  const reachable = vault.slotId('custom', 'https://api.example.com/v1');
  assert.strictEqual(await vault.has(reachable), false, 'the new endpoint addresses a different slot');
  assert.strictEqual((await vault.list()).length, 1, 'the orphan is still there');
  await vault.forgetAll();
  assert.strictEqual((await vault.list()).length, 0);
});

s.test('list() enumerates slots and carries no key material whatsoever', async () => {
  const { vault } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://api.groq.com/openai/v1'), SECRET);
  await vault.remember(vault.slotId('openrouter', 'https://openrouter.ai/api/v1'), 'or-secret-key');

  const slots = await vault.list();
  assert.strictEqual(slots.length, 2);
  const dumped = JSON.stringify(slots);
  assert.strictEqual(dumped.indexOf(SECRET), -1, 'a key leaked into the listing');
  assert.strictEqual(dumped.indexOf('or-secret-key'), -1);
  assert.strictEqual(dumped.indexOf('ciphertext'), -1, 'even the ciphertext has no business here');
  assert.strictEqual(dumped.indexOf('"iv"'), -1);
  for (const slot of slots) {
    assert.deepStrictEqual(Object.keys(slot).sort(), ['endpoint', 'endpointOrigin', 'id', 'presetId', 'ts']);
    assert.ok(slot.ts > 0, 'a slot with no timestamp cannot be sorted or explained');
  }
});

s.test('the full endpoint rides along beside the ciphertext, and is not a secret', async () => {
  /*
   * The slot is ORIGIN-scoped by design, so the id alone cannot restore
   * "https://api.groq.com/openai/v1" — it would come back as the bare origin
   * and resolve to a URL that 404s. The address is stored next to the
   * credential so a reload can put the field back exactly as it was typed.
   * It is not key material: it is where the request goes, which the user can
   * already read off the screen.
   */
  const { vault, idb } = makeVault();
  const typed = 'https://api.groq.com/openai/v1';
  const slot = vault.slotId('custom', typed);
  await vault.remember(slot, SECRET, { endpoint: typed });

  const [listed] = await vault.list();
  assert.strictEqual(listed.endpoint, typed, 'the endpoint was not carried');
  assert.strictEqual(listed.endpointOrigin, 'https://api.groq.com');
  assert.strictEqual(JSON.stringify(listed).indexOf(SECRET), -1, 'a key leaked into the listing');

  // Absent meta is not an error; it just leaves the field empty, and the
  // origin remains the fallback.
  const bare = vault.slotId('openrouter', 'https://openrouter.ai/api/v1');
  await vault.remember(bare, 'k');
  const record = await idb.get(IDB_KEYS, bare);
  assert.strictEqual(record.endpoint, '');
  assert.strictEqual(record.endpointOrigin, 'https://openrouter.ai');
});

/* --- hygiene regressions --------------------------------------------------- */

s.test('REGRESSION: no vault operation ever writes to localStorage', async () => {
  const before = local.writes.length + session.writes.length;
  const { vault } = makeVault();
  const slot = vault.slotId('custom', 'https://api.groq.com/openai/v1');
  await vault.remember(slot, SECRET);
  await vault.recall(slot);
  await vault.list();
  await vault.has(slot);
  await vault.forget(slot);
  await vault.forgetAll();
  const writes = local.writes.concat(session.writes);
  assert.strictEqual(writes.length, before, 'the vault touched web storage');
  assert.strictEqual(JSON.stringify(writes).indexOf(SECRET), -1);
});

s.test('REGRESSION: a workspace snapshot carries no key material', async () => {
  const { vault } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://api.groq.com/openai/v1'), SECRET);

  // A realistic working set, serialised exactly the way an autosave, a preset
  // save and a history entry all do it.
  const registry = {
    promptState: createPromptState(),
    exclusions: createExclusionState(),
    structure: createStructureState(),
    sliders: {
      values: { energy: 80, warmth: 40, density: 60 },
      get(axis) {
        return this.values[axis];
      },
      set(axis, value) {
        this.values[axis] = value;
      },
    },
  };
  registry.promptState.add({ section: 'genre', tag: 'french electro', source: 'manual' });
  registry.exclusions.add('male vocals');
  registry.structure.addBlock('[Intro]');

  const snapshot = serializeWorkspace(registry);
  const dumped = JSON.stringify(snapshot);
  assert.strictEqual(dumped.indexOf(SECRET), -1, 'the API key reached a workspace snapshot');
  for (const forbidden of ['sk-live', 'ciphertext', 'api_keys', 'device_key', 'apiKey', '"key"']) {
    assert.strictEqual(dumped.indexOf(forbidden), -1, `"${forbidden}" appears in a workspace snapshot`);
  }
  // The snapshot IS carrying the workspace, so this is not passing vacuously.
  assert.ok(dumped.indexOf('french electro') !== -1, 'the snapshot did not serialise the workspace at all');
});

s.test('REGRESSION: the preset export reads presets only, and copies four fields', async () => {
  const { vault } = makeVault();
  await vault.remember(vault.slotId('custom', 'https://api.groq.com/openai/v1'), SECRET);

  // A preset record with a key smuggled into it: the exporter must copy the
  // four fields it declares and nothing else, so even a poisoned record
  // cannot carry a secret out of the browser.
  const exported = buildPresetExport([
    { id: 'p-1', name: 'Warehouse', ts: 5, favorite: true, workspace: { tags: [] }, apiKey: SECRET, key: SECRET },
  ]);
  const dumped = serializePresetExport([
    { id: 'p-1', name: 'Warehouse', ts: 5, favorite: true, workspace: { tags: [] }, apiKey: SECRET },
  ]);
  assert.deepStrictEqual(Object.keys(exported.presets[0]).sort(), ['favorite', 'name', 'savedAt', 'workspace']);
  assert.strictEqual(JSON.stringify(exported).indexOf(SECRET), -1, 'a key survived buildPresetExport');
  assert.strictEqual(dumped.indexOf(SECRET), -1, 'a key survived the serialised export');

  // And the code that FEEDS the exporter reads exactly one store. The key
  // store IS read in one place — createKeyVault.list(), which the test above
  // proves strips every byte of key material — so the assertion is that no
  // reader OUTSIDE the vault ever touches it.
  const vaultStart = SOURCE.indexOf('function createKeyVault');
  const vaultEnd = SOURCE.indexOf('C. DOM VIRTUALIZATION', vaultStart);
  assert.ok(vaultStart !== -1 && vaultEnd > vaultStart, 'could not locate createKeyVault in the source');

  const readers = [];
  const re = /idb\.getAll\(\s*([A-Z_]+)\s*\)/g;
  let hit;
  while ((hit = re.exec(SOURCE)) !== null) {
    readers.push({ store: hit[1], inVault: hit.index > vaultStart && hit.index < vaultEnd });
  }
  const outside = readers.filter((r) => !r.inVault).map((r) => r.store);
  for (const store of outside) {
    assert.notStrictEqual(store, 'IDB_KEYS', 'the key store is read into a list outside the vault');
    assert.notStrictEqual(store, 'IDB_DEVICE_KEY', 'the device key store is read into a list');
  }
  assert.ok(outside.indexOf('IDB_PRESETS') !== -1, 'the preset list is not read from IDB_PRESETS any more');
  assert.ok(
    readers.some((r) => r.inVault && r.store === 'IDB_KEYS'),
    'the vault no longer lists its own slots — the storage card would have nothing to count'
  );
});

s.test('REGRESSION: #app-main never writes a key store through a serialising path', () => {
  // A blunt but load-bearing scan: no serializer, snapshot builder or export
  // helper may so much as name the two secret stores.
  const forbidden = /\b(?:serializeWorkspace|buildPresetExport|serializePresetExport|profileFromWorkspace)\b[\s\S]{0,1200}?(IDB_KEYS|IDB_DEVICE_KEY)/;
  assert.strictEqual(forbidden.test(SOURCE), false, 'a serialising path references a key store');
  // The key store is only ever reached through createKeyVault.
  const keyStoreUses = SOURCE.match(/IDB_KEYS/g) || [];
  assert.ok(keyStoreUses.length > 0, 'IDB_KEYS is not used at all — is the vault wired up?');
});

s.test('no unhandled promise rejection escaped this suite (§2.3)', async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(unhandled, [], `unhandled rejection(s):\n${unhandled.map((u) => u.reason).join('\n')}`);
});

s.finish().then((r) => {
  if (!r.ok) process.exitCode = 1;
});
