'use strict';
/*
 * tests/keybinds-palette.test.js — the paired 0.22.0 release:
 *
 *   docs/FDD.md #90  Studio Shortcut Keybinds  -> var STUDIO_KEYBINDS behind
 *                                                 ONE capture-phase dispatcher
 *   docs/FDD.md #16  Command Palette           -> buildPaletteIndex /
 *                                                 paletteMatch behind a
 *                                                 Spotlight-style overlay
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING, in the order the file runs:
 *
 *   1. THE KEYBOARD IS WRITTEN DOWN ONCE. STUDIO_KEYBINDS is the only list of
 *      keys this app answers to, and every entry names the handler that owns
 *      it. The shape tests below hold the registry to its declared vocabulary
 *      (scope, owner, guard) and to unique ids and unique DISPLAY keys per
 *      scope — two bindings printing "Ctrl+Enter" in one scope is a cheat
 *      sheet that lies about which one wins.
 *
 *   2. A SHORTCUT NEVER FIRES WHILE YOU ARE TYPING. Every dispatcher binding
 *      is driven against a text-entry target and must decline — with exactly
 *      ONE exception, Ctrl+Enter, which FDD #90 names and the guard ladder
 *      marks 'none'. The test does not hard-code which one that is: it asserts
 *      that the set of guard-'none' bindings is exactly {copy-style-prompt},
 *      so a second exception added later fails here rather than shipping.
 *
 *   3. THE DISPATCHER AND THE OLD HANDLERS ARE DISJOINT. The structure card's
 *      Ctrl+Z / Alt+Arrow listener and the tablist's arrow-key listener stay
 *      where they are. For every entry the registry marks 'structure' or
 *      'tablist', an event synthesised FROM THAT ENTRY'S OWN MATCH SPEC is
 *      fed to matchStudioKeybind() in every scope and must come back null —
 *      and then to the real predicate that does own it, which must answer.
 *      No key is handled twice, and the proof tracks the registry rather than
 *      a list typed out beside it.
 *
 *   4. THE PALETTE IS A VIEW OF THE REGISTRIES, NOT A COPY. Every expected
 *      count below is DERIVED from the registry it covers — sum the tokens in
 *      MUSIC_KB.genres, take VOCAL_REGISTRY.length — so adding a genre grows
 *      the assertion with the data instead of failing it. A registry that
 *      stops being covered at all is what this catches.
 *
 *   5. paletteMatch IS DETERMINISTIC AND RANKED. Same query, same order, on
 *      any engine: rank, then the shorter label, then the entry's position,
 *      which is a total order (no two entries can tie on all three). Prefix
 *      beats word-prefix beats substring beats detail, and the limit holds.
 *
 *   6. THERE IS NO SECOND WAY TO ADD ANYTHING. The palette calls the same
 *      functions the cards' own controls call. That is asserted twice: once
 *      behaviourally, by driving buildPaletteIndex with stub verbs, and once
 *      STATICALLY, by reading #app-main and counting the call sites of every
 *      real add/toggle path. Two call sites of promptState.add({section:
 *      'genre'…}) would mean the palette had grown its own.
 *
 *   7. THE DIALOGS ARE REAL DIALOGS. role/aria-modal/labelling, a combobox
 *      over a listbox with aria-activedescendant, and — the one that cannot be
 *      seen from the CSS alone — both overlays are SIBLINGS of .app-shell,
 *      because .app-shell's container-type makes it the containing block for
 *      any position:fixed descendant.
 *
 * WHAT IS DELIBERATELY NOT COVERED
 *   - Real key events in a real browser, real focus movement and the focus
 *     trap actually trapping. Those need a live layout and a live focus ring;
 *     they were driven by hand against a served localhost build for this
 *     release (see PROGRESS.md). What CAN be tested without one — the pure
 *     predicate, the registry, the index, the ranker and the wiring — is here.
 *   - Whether the clipboard receives the text. tests/persistence.test.js owns
 *     the copy contract; this suite only proves Ctrl+Enter reaches it.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const FDD = path.join(ROOT, 'docs', 'FDD.md');

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/** Evaluate #app-main in a DOM-free vm context; the boot IIFE stays inert. */
function loadAppSandbox() {
  const source = extractScriptById(INDEX, 'app-main');
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Promise,
    RegExp,
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
  STUDIO_KEYBINDS,
  STUDIO_KEYBIND_SCOPES,
  STUDIO_KEYBIND_SCOPE_LABELS,
  STUDIO_KEYBIND_OWNERS,
  STUDIO_KEYBIND_GUARDS,
  matchStudioKeybind,
  isKeyActivationTarget,
  isTypeaheadTarget,
  isTextEntryTarget,
  studioKeybindGroups,
  structureShortcut,
  structureMoveShortcut,
  tabKeyTarget,
  buildPaletteIndex,
  paletteMatch,
  paletteKeepsOpen,
  PALETTE_KINDS,
  PALETTE_KIND_LABELS,
  PALETTE_TOGGLE_KINDS,
  PALETTE_COMMANDS,
  PALETTE_DEFAULT_LIMIT,
  MUSIC_KB,
  VOCAL_REGISTRY,
  INSTRUMENT_REGISTRY,
  ERA_REGISTRY,
  EXCLUSION_PRESETS,
  SUNO_METATAGS,
  sceneTriggerList,
  createPromptState,
  createExclusionState,
  formatStructureTag,
} = app.sandbox;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return stripCssComments(m[1]);
}

/**
 * Copy an array OUT of the vm context.
 *
 * Everything the sandbox returns carries the sandbox's own Array.prototype,
 * and assert.deepStrictEqual compares prototypes — so a vm array and a
 * host-literal array of the same contents are "not reference-equal". Array.from
 * rebuilds the value with this realm's constructor; the contents are untouched.
 */
function own(list) {
  return Array.from(list);
}

/** Every binding the dispatcher itself answers for. */
function dispatcherBindings() {
  return own(STUDIO_KEYBINDS.filter((b) => b.owner === 'dispatcher'));
}

/** Every binding some other handler answers for. */
function delegatedBindings() {
  return own(STUDIO_KEYBINDS.filter((b) => b.owner !== 'dispatcher'));
}

/**
 * Synthesise the canonical event a binding declares it wants, from the
 * binding's OWN match spec. Every keyboard test below starts here, so a spec
 * that changes changes the events too — the matrix cannot drift away from the
 * registry it is testing.
 *
 * @param {object} binding
 * @param {object} [overrides] merged last; `target` defaults to <body>
 */
function eventFor(binding, overrides) {
  const spec = binding.match;
  const event = {
    key: spec.key.length ? spec.key[0] : '',
    code: spec.code.length ? spec.code[0] : '',
    ctrlKey: spec.primary === true,
    metaKey: false,
    altKey: spec.alt === true,
    shiftKey: spec.shift === true,
    target: { tagName: 'BODY' },
  };
  return Object.assign(event, overrides || {});
}

/** A scope in which `binding` is live. */
function scopeFor(binding) {
  return binding.when === 'global' ? 'hum' : binding.when;
}

/* Expected palette counts, DERIVED from the registries rather than typed out.
 * The point of the whole file: a new genre or a new persona grows this table
 * automatically, and a registry the index stops covering drops to zero here. */
function expectedPaletteCounts() {
  let genreTokens = 0;
  for (const genre of MUSIC_KB.genres) {
    genreTokens += Array.isArray(genre.tokens) ? genre.tokens.length : 0;
  }
  return {
    command: PALETTE_COMMANDS.length,
    genre: genreTokens,
    scene: sceneTriggerList(MUSIC_KB).length,
    vocal: VOCAL_REGISTRY.length,
    instrument: INSTRUMENT_REGISTRY.length,
    era: ERA_REGISTRY.length,
    exclusion: EXCLUSION_PRESETS.length,
    structure: SUNO_METATAGS.core.length + SUNO_METATAGS.action.length,
  };
}

/** A real index over real stores — what the boot builds, minus the DOM. */
function realIndex(actions) {
  return buildPaletteIndex({
    kb: MUSIC_KB,
    store: createPromptState(),
    exclusions: createExclusionState(),
    actions: actions || {},
  });
}

const s = suite('keybinds-palette (FDD #90 studio keyboard + #16 command palette)');

/* ========================================================================== */
/* 1. Registry integrity                                                      */
/* ========================================================================== */

s.test('every binding declares the full contract, in the declared vocabulary', () => {
  assert.ok(Array.isArray(STUDIO_KEYBINDS) && STUDIO_KEYBINDS.length >= 6, 'registry is empty');

  for (const binding of STUDIO_KEYBINDS) {
    const where = `binding ${binding && binding.id}`;
    assert.strictEqual(typeof binding.id, 'string', `${where}: no id`);
    assert.ok(binding.id.length > 0, `${where}: empty id`);
    assert.ok(typeof binding.keys === 'string' && binding.keys.length, `${where}: no display keys`);
    assert.ok(
      STUDIO_KEYBIND_SCOPES.indexOf(binding.when) !== -1,
      `${where}: scope ${binding.when} is not one of ${STUDIO_KEYBIND_SCOPES.join('/')}`
    );
    assert.ok(
      STUDIO_KEYBIND_OWNERS.indexOf(binding.owner) !== -1,
      `${where}: owner ${binding.owner} is not one of ${STUDIO_KEYBIND_OWNERS.join('/')}`
    );
    assert.ok(
      STUDIO_KEYBIND_GUARDS.indexOf(binding.guard) !== -1,
      `${where}: guard ${binding.guard} is not one of ${STUDIO_KEYBIND_GUARDS.join('/')}`
    );
    assert.ok(typeof binding.action === 'string' && binding.action.length, `${where}: no action id`);

    // A description is what the cheat sheet prints; an empty one is a row that
    // shows a key and says nothing about it.
    assert.ok(
      typeof binding.description === 'string' && binding.description.length > 12,
      `${where}: description is missing or too short to be a sentence`
    );
    assert.ok(/\.$/.test(binding.description), `${where}: description must read as a sentence`);

    const spec = binding.match;
    assert.ok(spec && typeof spec === 'object', `${where}: no match spec`);
    assert.ok(Array.isArray(spec.key), `${where}: match.key must be an array`);
    assert.ok(Array.isArray(spec.code), `${where}: match.code must be an array`);
    assert.ok(spec.key.length > 0, `${where}: a binding with no key can never fire`);
    for (const flag of ['primary', 'alt', 'shift']) {
      assert.ok(
        spec[flag] === true || spec[flag] === false || spec[flag] === null,
        `${where}: match.${flag} must be true, false or null (don't care)`
      );
    }
  }
});

s.test('ids are unique across the registry and DISPLAY keys are unique per scope', () => {
  const ids = new Set();
  for (const binding of STUDIO_KEYBINDS) {
    assert.ok(!ids.has(binding.id), `duplicate binding id: ${binding.id}`);
    ids.add(binding.id);
  }

  // Two bindings printing the same key string in one scope is a cheat sheet
  // that cannot say which one wins.
  for (const scope of STUDIO_KEYBIND_SCOPES) {
    const seen = new Map();
    for (const binding of STUDIO_KEYBINDS) {
      if (binding.when !== scope) continue;
      assert.ok(
        !seen.has(binding.keys),
        `scope "${scope}" prints "${binding.keys}" twice: ${seen.get(binding.keys)} and ${binding.id}`
      );
      seen.set(binding.keys, binding.id);
    }
  }
});

s.test('exactly ONE binding may fire while typing, and it is the FDD-named Ctrl+Enter copy', () => {
  const exceptions = own(STUDIO_KEYBINDS.filter((b) => b.guard === 'none').map((b) => b.id));
  assert.deepStrictEqual(
    own(STUDIO_KEYBIND_GUARDS).slice().sort(),
    ['none', 'text', 'text+activation', 'text+typeahead'],
    'the guard vocabulary is the ladder; adding a rung is a decision, not a detail'
  );
  assert.deepStrictEqual(
    exceptions,
    ['copy-style-prompt'],
    'the guard ladder allows exactly one documented exception; found: ' + exceptions.join(', ')
  );

  const copy = STUDIO_KEYBINDS.find((b) => b.id === 'copy-style-prompt');
  assert.strictEqual(copy.keys, 'Ctrl+Enter');
  assert.strictEqual(copy.when, 'global');
  assert.strictEqual(copy.match.primary, true);
  assert.deepStrictEqual(own(copy.match.key), ['Enter']);
});

s.test('the two keys FDD #90 names by name are the two keys that are bound', () => {
  const fdd = fs.readFileSync(FDD, 'utf8');
  const line = fdd.split(/\r?\n/).find((l) => /^90\.\s+\*\*Studio Shortcut Keybinds/.test(l));
  assert.ok(line, 'docs/FDD.md #90 could not be located');
  // The spec sentence itself: "(`Space` to hum, `Ctrl+Enter` to copy)".
  assert.ok(/`Space`/.test(line), 'FDD #90 no longer names Space — this test tracks the spec');
  assert.ok(/`Ctrl\+Enter`/.test(line), 'FDD #90 no longer names Ctrl+Enter');

  const record = STUDIO_KEYBINDS.find((b) => b.id === 'toggle-record');
  assert.ok(record, 'nothing implements "Space to hum"');
  assert.strictEqual(record.keys, 'Space');
  assert.strictEqual(record.when, 'hum', 'Space is a Hum Studio key; the FDD says "to hum"');
  assert.strictEqual(record.action, 'toggle-record');

  const copy = STUDIO_KEYBINDS.find((b) => b.keys === 'Ctrl+Enter');
  assert.ok(copy, 'nothing implements "Ctrl+Enter to copy"');
  assert.strictEqual(copy.action, 'copy-style-prompt');
});

s.test('nothing is bound over a key the browser has already taken', () => {
  /* Save Page, Print, Close Tab, New Window/Tab, Find, Reload, Open, Location,
     Bookmark, Downloads, History, Quit — a shortcut that fights one of these
     loses, and takes the user's page with it. */
  const RESERVED = ['s', 'p', 'w', 'n', 't', 'f', 'r', 'o', 'l', 'd', 'j', 'h', 'q', 'a', 'c', 'v', 'x'];
  for (const binding of dispatcherBindings()) {
    if (binding.match.primary !== true) continue;
    for (const key of binding.match.key) {
      assert.ok(
        RESERVED.indexOf(String(key).toLowerCase()) === -1,
        `${binding.id} binds Ctrl+${key}, which the browser already owns`
      );
    }
  }
});

/* ========================================================================== */
/* 2. matchStudioKeybind — the matrix                                         */
/* ========================================================================== */

s.test('every dispatcher binding fires for the event its own match spec describes', () => {
  for (const binding of dispatcherBindings()) {
    const hit = matchStudioKeybind(eventFor(binding), scopeFor(binding), STUDIO_KEYBINDS);
    assert.ok(hit, `${binding.id} (${binding.keys}) did not fire for its own canonical event`);
    assert.strictEqual(hit.id, binding.id, `${binding.keys} fired ${hit.id} instead of ${binding.id}`);
  }
});

s.test('auto-repeat never re-fires a binding — one physical press, one action (0.22.x fix)', () => {
  // A held key re-fires keydown with event.repeat=true once per OS repeat
  // tick. The review reproduced a held Space stacking getUserMedia calls and
  // a held Ctrl+Enter banking one history entry per tick. The guard lives in
  // matchStudioKeybind itself so every dispatcher path inherits it.
  for (const binding of dispatcherBindings()) {
    const hit = matchStudioKeybind(
      eventFor(binding, { repeat: true }),
      scopeFor(binding),
      STUDIO_KEYBINDS
    );
    assert.strictEqual(
      hit,
      null,
      `${binding.id} (${binding.keys}) fired on an auto-repeat event — held keys must act once`
    );
  }
  // And the guard is the pure predicate's, not the dispatcher's alone.
  assert.ok(
    /if \(event\.repeat === true\) return null;/.test(String(matchStudioKeybind)),
    'matchStudioKeybind must refuse event.repeat === true itself'
  );
});

s.test('no dispatcher binding fires while text is being edited — except the documented one', () => {
  const TEXT_TARGETS = [
    { tagName: 'TEXTAREA' },
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'search' },
    { tagName: 'INPUT', type: 'number' },
    { tagName: 'DIV', isContentEditable: true },
  ];

  for (const binding of dispatcherBindings()) {
    for (const target of TEXT_TARGETS) {
      // The guard is what isTextEntryTarget already means, unchanged.
      assert.strictEqual(isTextEntryTarget(target), true, 'the fixture must BE a text target');
      const hit = matchStudioKeybind(
        eventFor(binding, { target }),
        scopeFor(binding),
        STUDIO_KEYBINDS
      );
      if (binding.guard === 'none') {
        assert.ok(hit, `${binding.id} declares guard 'none' and must still fire in ${target.tagName}`);
        assert.strictEqual(hit.id, binding.id);
      } else {
        assert.strictEqual(
          hit,
          null,
          `${binding.id} (${binding.keys}) fired inside ${target.tagName} — it would corrupt the text being typed`
        );
      }
    }
  }
});

s.test('Space stands aside for a control the browser already activates', () => {
  const ACTIVATION_TARGETS = [
    { tagName: 'BUTTON' },
    { tagName: 'SELECT' },
    { tagName: 'SUMMARY' },
    { tagName: 'A', href: 'https://example.invalid/' },
    { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'SPAN', getAttribute: (n) => (n === 'role' ? 'button' : null) },
  ];

  for (const target of ACTIVATION_TARGETS) {
    assert.strictEqual(isKeyActivationTarget(target), true, 'the fixture must BE an activation target');
  }
  // …and an ordinary element is not one, or the guard would swallow everything.
  assert.strictEqual(isKeyActivationTarget({ tagName: 'BODY' }), false);
  assert.strictEqual(isKeyActivationTarget({ tagName: 'A' }), false, 'an <a> with no href is not a link');
  assert.strictEqual(isKeyActivationTarget(null), false);
  assert.strictEqual(isKeyActivationTarget('button'), false);

  const wide = dispatcherBindings().filter((b) => b.guard === 'text+activation');
  assert.deepStrictEqual(
    wide.map((b) => b.id),
    ['toggle-record'],
    'only Space needs the wide guard; everything else would lose the key where focus usually is'
  );

  for (const binding of wide) {
    for (const target of ACTIVATION_TARGETS) {
      assert.strictEqual(
        matchStudioKeybind(eventFor(binding, { target }), scopeFor(binding), STUDIO_KEYBINDS),
        null,
        `${binding.id} (${binding.keys}) fired on a focused ${target.tagName} — it would fire ALONGSIDE the browser's own activation`
      );
    }
  }
});

s.test('a printed character yields to type-ahead ONLY — / must still work on a focused button', () => {
  // The narrow guard, and the regression it exists for: focus sits on a button
  // most of the time in this app (Record, Dissect, every chip), and a "/" that
  // quietly did nothing there would read as a broken feature.
  assert.strictEqual(isTypeaheadTarget({ tagName: 'SELECT' }), true);
  assert.strictEqual(isTypeaheadTarget({ tagName: 'OPTION' }), true);
  assert.strictEqual(
    isTypeaheadTarget({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'listbox' : null) }),
    true
  );
  assert.strictEqual(isTypeaheadTarget({ tagName: 'BUTTON' }), false, 'a button types nothing');
  assert.strictEqual(isTypeaheadTarget({ tagName: 'BODY' }), false);
  assert.strictEqual(isTypeaheadTarget(null), false);

  const narrow = dispatcherBindings().filter((b) => b.guard === 'text+typeahead');
  assert.deepStrictEqual(
    narrow.map((b) => b.id).sort(),
    ['cheatsheet-open', 'palette-open', 'view-editor', 'view-hum'],
    'every printable binding carries the narrow guard'
  );

  for (const binding of narrow) {
    // Yields inside a <select>…
    assert.strictEqual(
      matchStudioKeybind(
        eventFor(binding, { target: { tagName: 'SELECT' } }),
        scopeFor(binding),
        STUDIO_KEYBINDS
      ),
      null,
      `${binding.id} must not fight a <select>'s type-ahead`
    );
    // …and NOT on a button, a link or a checkbox.
    for (const target of [
      { tagName: 'BUTTON' },
      { tagName: 'A', href: 'https://example.invalid/' },
      { tagName: 'INPUT', type: 'checkbox' },
      { tagName: 'SUMMARY' },
    ]) {
      const hit = matchStudioKeybind(
        eventFor(binding, { target }),
        scopeFor(binding),
        STUDIO_KEYBINDS
      );
      assert.ok(
        hit && hit.id === binding.id,
        `${binding.id} (${binding.keys}) failed to fire on a focused ${target.tagName}, where the browser does nothing with that key`
      );
    }
  }

  // The guard vocabulary is ordered widest-first, which is also the order the
  // matcher checks them in.
  assert.deepStrictEqual(own(STUDIO_KEYBIND_GUARDS), [
    'text+activation',
    'text+typeahead',
    'text',
    'none',
  ]);
});

s.test('modifiers are matched exactly: one extra modifier and the binding declines', () => {
  const FLAGS = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'];
  for (const binding of dispatcherBindings()) {
    const base = eventFor(binding);
    for (const flag of FLAGS) {
      if (base[flag] === true) continue;
      // shift is deliberately "don't care" on the character bindings, because
      // whether `/` needs Shift is a property of the LAYOUT, not of the app.
      if (flag === 'shiftKey' && binding.match.shift === null) continue;
      // Ctrl and Cmd are ONE modifier (see structureShortcut), so a binding
      // that wants "primary" is satisfied by either — and by both at once.
      if (flag === 'metaKey' && binding.match.primary === true) continue;
      const hit = matchStudioKeybind(
        eventFor(binding, { [flag]: true }),
        scopeFor(binding),
        STUDIO_KEYBINDS
      );
      assert.strictEqual(
        hit,
        null,
        `${binding.id} (${binding.keys}) still fired with ${flag} held — modifiers must match exactly`
      );
    }
  }
});

s.test('Ctrl and Cmd are ONE modifier, exactly as structureShortcut already treats them', () => {
  const copy = STUDIO_KEYBINDS.find((b) => b.id === 'copy-style-prompt');
  const withMeta = eventFor(copy, { ctrlKey: false, metaKey: true });
  const hit = matchStudioKeybind(withMeta, 'hum', STUDIO_KEYBINDS);
  assert.ok(hit && hit.id === 'copy-style-prompt', 'Cmd+Enter must be the same binding as Ctrl+Enter');
});

s.test('a view-scoped binding fires only in its view; a global one fires in both', () => {
  for (const binding of dispatcherBindings()) {
    for (const scope of ['hum', 'editor']) {
      const hit = matchStudioKeybind(eventFor(binding), scope, STUDIO_KEYBINDS);
      const shouldFire = binding.when === 'global' || binding.when === scope;
      if (shouldFire) {
        assert.ok(hit && hit.id === binding.id, `${binding.id} must fire in the ${scope} view`);
      } else {
        assert.strictEqual(
          hit,
          null,
          `${binding.id} is scoped to "${binding.when}" but fired in the ${scope} view`
        );
      }
    }
  }

  // The one that carries the whole point: Space is the Hum Studio's key.
  const space = { key: ' ', code: 'Space', target: { tagName: 'BODY' } };
  assert.strictEqual(matchStudioKeybind(space, 'hum', STUDIO_KEYBINDS).id, 'toggle-record');
  assert.strictEqual(matchStudioKeybind(space, 'editor', STUDIO_KEYBINDS), null);
  assert.strictEqual(matchStudioKeybind(space, '', STUDIO_KEYBINDS), null, 'no view means no scoped key');
});

s.test('the layout decides: `key` wins, and `code` is read only when the engine gives us nothing', () => {
  const body = { tagName: 'BODY' };

  // A layout that produces `/` from ANY physical key opens the palette.
  assert.strictEqual(
    matchStudioKeybind({ key: '/', code: 'Period', target: body }, 'hum', STUDIO_KEYBINDS).id,
    'palette-open'
  );
  // …and the Slash key producing something else does NOT.
  assert.strictEqual(
    matchStudioKeybind({ key: ':', code: 'Slash', target: body }, 'hum', STUDIO_KEYBINDS),
    null,
    'matching on code while key says otherwise is how a shortcut fires on the wrong character'
  );
  // Shift+Slash produces `?` on a US layout — a DIFFERENT binding, matched by
  // its own key rather than by the physical one they share.
  assert.strictEqual(
    matchStudioKeybind({ key: '?', code: 'Slash', shiftKey: true, target: body }, 'hum', STUDIO_KEYBINDS)
      .id,
    'cheatsheet-open'
  );
  assert.strictEqual(
    matchStudioKeybind({ key: '/', code: 'Slash', shiftKey: true, target: body }, 'hum', STUDIO_KEYBINDS)
      .id,
    'palette-open',
    'a layout where / needs Shift must still reach the palette'
  );

  // The fallback: no usable key at all.
  for (const dead of ['', 'Unidentified', 'Dead']) {
    assert.strictEqual(
      matchStudioKeybind({ key: dead, code: 'Digit1', target: body }, 'hum', STUDIO_KEYBINDS).id,
      'view-hum',
      `code must be the fallback when key is ${JSON.stringify(dead)}`
    );
  }
  // …and a code nothing declares still matches nothing.
  assert.strictEqual(
    matchStudioKeybind({ key: '', code: 'F13', target: body }, 'hum', STUDIO_KEYBINDS),
    null
  );
});

s.test('matchStudioKeybind survives being handed nonsense, and never throws', () => {
  const junk = [null, undefined, 0, '', 'keydown', [], true];
  for (const value of junk) {
    assert.strictEqual(matchStudioKeybind(value, 'hum', STUDIO_KEYBINDS), null, String(value));
  }
  // A well-formed event against a broken registry is still null, not a throw.
  const event = { key: '/', target: { tagName: 'BODY' } };
  assert.strictEqual(matchStudioKeybind(event, 'hum', [null, 42, {}, { owner: 'dispatcher' }]), null);
  // No registry at all falls back to STUDIO_KEYBINDS.
  assert.strictEqual(matchStudioKeybind(event, 'hum').id, 'palette-open');
  assert.strictEqual(matchStudioKeybind(event, 'hum', 'not-an-array').id, 'palette-open');
});

/* ========================================================================== */
/* 3. Disjointness with the handlers that were already there                  */
/* ========================================================================== */

s.test('the dispatcher never answers for a key another handler owns', () => {
  const delegated = delegatedBindings();
  assert.ok(delegated.length >= 5, 'the registry must document the delegated keys, not hide them');

  for (const binding of delegated) {
    for (const scope of STUDIO_KEYBIND_SCOPES.concat([''])) {
      for (const key of binding.match.key) {
        const event = eventFor(binding, { key, code: '' });
        assert.strictEqual(
          matchStudioKeybind(event, scope, STUDIO_KEYBINDS),
          null,
          `${binding.id} (${binding.keys}, owned by "${binding.owner}") was ALSO claimed by the dispatcher in scope "${scope}" — that key would be handled twice`
        );
      }
    }
  }
});

s.test('…and the handler that DOES own each delegated key still answers for it', () => {
  const undo = STUDIO_KEYBINDS.find((b) => b.id === 'structure-undo');
  const redo = STUDIO_KEYBINDS.find((b) => b.id === 'structure-redo');
  const redoAlt = STUDIO_KEYBINDS.find((b) => b.id === 'structure-redo-alt');
  const move = STUDIO_KEYBINDS.find((b) => b.id === 'structure-move');
  const tabs = STUDIO_KEYBINDS.find((b) => b.id === 'tablist-move');

  assert.strictEqual(structureShortcut(eventFor(undo)), 'undo');
  assert.strictEqual(structureShortcut(eventFor(redo)), 'redo');
  assert.strictEqual(structureShortcut(eventFor(redoAlt)), 'redo', 'Ctrl+Shift+Z is the redo alias');
  assert.strictEqual(structureMoveShortcut(eventFor(move, { key: 'ArrowUp' })), -1);
  assert.strictEqual(structureMoveShortcut(eventFor(move, { key: 'ArrowDown' })), 1);

  // The tablist keys, through the predicate the tabs' own listener uses.
  assert.strictEqual(tabKeyTarget('ArrowRight', 0, 2), 1);
  assert.strictEqual(tabKeyTarget('ArrowLeft', 0, 2), 1, 'the tablist wraps at both ends');
  assert.strictEqual(tabKeyTarget('Home', 1, 2), 0);
  assert.strictEqual(tabKeyTarget('End', 0, 2), 1);
  for (const key of tabs.match.key) {
    assert.notStrictEqual(tabKeyTarget(key, 0, 2), -1, `the tablist must still own ${key}`);
  }
});

s.test('no dispatcher key SIGNATURE collides with a delegated one', () => {
  // A signature is what a user's fingers do: the modifier profile plus the
  // produced character. Two entries sharing one is a key handled twice, even if
  // the two guards happen to keep them apart today.
  const signature = (binding, key) =>
    [
      binding.match.primary === true ? 'primary' : '',
      binding.match.alt === true ? 'alt' : '',
      binding.match.shift === true ? 'shift' : '',
      String(key).toLowerCase(),
    ].join('+');

  const owned = new Map();
  for (const binding of dispatcherBindings()) {
    for (const key of binding.match.key) owned.set(signature(binding, key), binding.id);
  }
  for (const binding of delegatedBindings()) {
    for (const key of binding.match.key) {
      const sig = signature(binding, key);
      assert.ok(
        !owned.has(sig),
        `${binding.id} and ${owned.get(sig)} both answer to "${sig}"`
      );
    }
  }
});

s.test('the boot has exactly ONE dispatcher, and it is the only caller of the predicate', () => {
  const source = app.source;
  const calls = source
    .split(/\r?\n/)
    .filter((line) => /matchStudioKeybind\(/.test(line) && !/^\s*(?:\*|\/\/)/.test(line) && !/^function\s/.test(line));
  assert.strictEqual(
    calls.length,
    1,
    `matchStudioKeybind is called ${calls.length} times — the whole point is that there is one dispatcher`
  );
  assert.ok(
    /matchStudioKeybind\(event, viewManager\.current\(\), STUDIO_KEYBINDS\)/.test(source),
    'the dispatcher must ask the view manager which view is showing, not a cached copy'
  );
  // Capture phase, so the dispatcher sees the key before a card's own listener
  // has a chance to swallow it — and the modal check that keeps it polite.
  assert.ok(
    /document\.addEventListener\(\s*'keydown',[\s\S]{0,2400}?studioKeyboardHeldElsewhere\(\)[\s\S]{0,600}?true\s*\);/.test(
      source
    ),
    'the dispatcher must be a capture-phase listener that stands down while a modal layer holds the keyboard'
  );
  // The handlers that were already there stayed there.
  assert.ok(/const action = structureShortcut\(event\);/.test(source), 'the structure card lost its own listener');
  assert.ok(/tabKeyTarget\(event\.key, index, tabs\.length\)/.test(source), 'the tablist lost its own listener');
});

/* ========================================================================== */
/* 4. The cheat sheet                                                         */
/* ========================================================================== */

s.test('studioKeybindGroups covers every registry entry exactly once, in scope order', () => {
  const groups = studioKeybindGroups(STUDIO_KEYBINDS);
  const seen = [];
  for (const group of groups) {
    assert.ok(STUDIO_KEYBIND_SCOPES.indexOf(group.scope) !== -1, `unknown scope ${group.scope}`);
    assert.strictEqual(
      group.label,
      STUDIO_KEYBIND_SCOPE_LABELS[group.scope],
      'a group must be named from the scope label table, not from a second copy of it'
    );
    for (const binding of group.bindings) {
      assert.strictEqual(binding.when, group.scope);
      seen.push(binding.id);
    }
  }
  assert.strictEqual(
    seen.length,
    STUDIO_KEYBINDS.length,
    'the sheet must list EVERY key this app listens for, whoever handles it'
  );
  assert.deepStrictEqual(
    seen.slice().sort(),
    own(STUDIO_KEYBINDS.map((b) => b.id)).sort(),
    'the sheet lists a binding the registry does not have, or drops one it does'
  );

  const order = own(groups.map((g) => g.scope));
  const expected = own(
    STUDIO_KEYBIND_SCOPES.filter((scope) => STUDIO_KEYBINDS.some((b) => b.when === scope))
  );
  assert.deepStrictEqual(order, expected, 'groups must print in STUDIO_KEYBIND_SCOPES order');

  assert.deepStrictEqual(own(studioKeybindGroups([])), [], 'an empty registry prints no groups');
});

s.test('the sheet is BUILT from the registry, and says who owns a key it does not handle', () => {
  const source = app.source;
  assert.ok(
    /studioKeybindGroups\(STUDIO_KEYBINDS\)/.test(source),
    'the cheat sheet must render from the registry rather than from typed-out rows'
  );
  assert.ok(
    /keyEl\.textContent = binding\.keys;/.test(source) &&
      /createTextNode\(binding\.description\)/.test(source),
    'every row must print the binding’s own keys and description'
  );
  assert.ok(
    /binding\.owner !== 'dispatcher'/.test(source),
    'a delegated key must be labelled, or "Ctrl+Z does nothing here" reads as a bug'
  );
});

/* ========================================================================== */
/* 5. buildPaletteIndex                                                       */
/* ========================================================================== */

s.test('the index covers every registry, with counts derived from the registries themselves', () => {
  const entries = realIndex();
  const counts = Object.create(null);
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] || 0) + 1;

  const expected = expectedPaletteCounts();
  for (const kind of PALETTE_KINDS) {
    assert.ok(expected[kind] > 0, `no expectation derived for kind ${kind}`);
    assert.strictEqual(
      counts[kind] || 0,
      expected[kind],
      `kind "${kind}": index holds ${counts[kind] || 0}, the registry holds ${expected[kind]}`
    );
  }

  const total = PALETTE_KINDS.reduce((n, kind) => n + expected[kind], 0);
  assert.strictEqual(entries.length, total, 'the index holds a kind PALETTE_KINDS does not name');
  // A floor, so a registry silently emptying is loud. The exact number is
  // derived above; this only says the feature is not a stub.
  assert.ok(entries.length > 400, `an index of ${entries.length} is too small to be the real registries`);
});

s.test('every entry is well formed, uniquely identified and runnable', () => {
  const entries = realIndex();
  const ids = new Set();
  for (const entry of entries) {
    assert.ok(PALETTE_KINDS.indexOf(entry.kind) !== -1, `unknown kind ${entry.kind}`);
    assert.ok(typeof entry.id === 'string' && entry.id.length, 'entry has no id');
    assert.ok(!ids.has(entry.id), `duplicate palette entry id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(typeof entry.label === 'string' && entry.label.length, `${entry.id}: empty label`);
    assert.ok(typeof entry.detail === 'string' && entry.detail.length, `${entry.id}: empty detail`);
    assert.strictEqual(typeof entry.action, 'function', `${entry.id}: action is not callable`);
    assert.ok(
      PALETTE_KIND_LABELS[entry.kind],
      `kind ${entry.kind} has no user-facing label, so its rows would print a slug`
    );
  }
});

s.test('a toggle knows whether it is already on; an add does not pretend to', () => {
  const store = createPromptState();
  const exclusions = createExclusionState();
  const entries = buildPaletteIndex({ kb: MUSIC_KB, store, exclusions, actions: {} });

  for (const entry of entries) {
    if (PALETTE_TOGGLE_KINDS.indexOf(entry.kind) !== -1) {
      assert.strictEqual(typeof entry.pressed, 'function', `${entry.id}: a toggle must report its state`);
      assert.strictEqual(entry.pressed(), false, `${entry.id}: nothing is on in a fresh workspace`);
    } else {
      assert.strictEqual(entry.pressed, null, `${entry.id}: an add has no on/off state to report`);
    }
  }

  // …and the state is READ from the store, not remembered: excluding a term
  // through the real store flips the row that stands for it.
  const term = EXCLUSION_PRESETS[0];
  const row = entries.find((e) => e.kind === 'exclusion' && e.label === term);
  assert.ok(row, 'the exclusion presets are not in the index');
  exclusions.add(term);
  assert.strictEqual(row.pressed(), true, 'the row must read the live store');
  exclusions.remove(term);
  assert.strictEqual(row.pressed(), false);

  // With no stores at all the index still builds — it just cannot claim a state.
  for (const entry of buildPaletteIndex({})) {
    assert.strictEqual(entry.pressed, null);
  }
});

s.test('the commands come first, so an empty query opens on something useful', () => {
  const entries = realIndex();
  for (let i = 0; i < PALETTE_COMMANDS.length; i += 1) {
    assert.strictEqual(entries[i].kind, 'command', `entry ${i} should be a command`);
    assert.strictEqual(entries[i].id, 'command:' + PALETTE_COMMANDS[i].id);
    assert.strictEqual(entries[i].label, PALETTE_COMMANDS[i].label);
  }
  assert.notStrictEqual(entries[PALETTE_COMMANDS.length].kind, 'command');

  const ids = new Set(PALETTE_COMMANDS.map((c) => c.id));
  assert.strictEqual(ids.size, PALETTE_COMMANDS.length, 'duplicate command id');
  for (const command of PALETTE_COMMANDS) {
    assert.ok(command.label && command.detail, `command ${command.id} is missing its wording`);
  }
});

s.test('running an entry calls the injected verb, with the datum it stands for', () => {
  const calls = [];
  const record = (name) => (argument) => {
    calls.push({ name, argument });
    return name + ' ran';
  };
  const actions = {};
  for (const name of [
    'addGenreToken',
    'addScene',
    'toggleVocalPersona',
    'toggleInstrumentBlock',
    'toggleEraSignature',
    'toggleExclusion',
    'addMetatag',
    'command',
  ]) {
    actions[name] = record(name);
  }

  const entries = buildPaletteIndex({ kb: MUSIC_KB, actions });
  const pick = (kind) => entries.find((e) => e.kind === kind);

  const expectations = [
    ['genre', 'addGenreToken', (a) => typeof a.tag === 'string' && a.genre && a.genre.id],
    ['scene', 'addScene', (a) => typeof a.phrase === 'string' && a.phrase.length],
    ['vocal', 'toggleVocalPersona', (a) => a === VOCAL_REGISTRY[0]],
    ['instrument', 'toggleInstrumentBlock', (a) => a === INSTRUMENT_REGISTRY[0]],
    ['era', 'toggleEraSignature', (a) => a === ERA_REGISTRY[0]],
    ['exclusion', 'toggleExclusion', (a) => a === EXCLUSION_PRESETS[0]],
    ['structure', 'addMetatag', (a) => SUNO_METATAGS.core.indexOf(a) !== -1],
    ['command', 'command', (a) => a && a.id === PALETTE_COMMANDS[0].id],
  ];

  for (const [kind, verb, check] of expectations) {
    calls.length = 0;
    const entry = pick(kind);
    assert.ok(entry, `no ${kind} entry in the index`);
    const message = entry.action();
    assert.strictEqual(calls.length, 1, `${kind} called ${calls.length} verbs; it must call exactly one`);
    assert.strictEqual(calls[0].name, verb, `${kind} called ${calls[0].name}, not ${verb}`);
    assert.ok(check(calls[0].argument), `${kind} handed ${verb} the wrong datum`);
    assert.strictEqual(message, verb + ' ran', 'the action must return the verb’s own status line');
  }

  // A verb that was not supplied is inert rather than a crash mid-keystroke.
  const bare = buildPaletteIndex({ kb: MUSIC_KB });
  assert.strictEqual(bare.find((e) => e.kind === 'genre').action(), '');
});

s.test('toggles keep the palette open; adds and commands close it', () => {
  for (const kind of PALETTE_KINDS) {
    const expected = PALETTE_TOGGLE_KINDS.indexOf(kind) !== -1;
    assert.strictEqual(paletteKeepsOpen(kind), expected, `paletteKeepsOpen('${kind}')`);
  }
  assert.strictEqual(paletteKeepsOpen('nonsense'), false);
  // The four toggle kinds are the four registries whose cards use a real
  // toggle. An add-only kind in this list would leave the palette open on a
  // gesture that is already finished.
  assert.deepStrictEqual(own(PALETTE_TOGGLE_KINDS).sort(), ['era', 'exclusion', 'instrument', 'vocal']);
});

s.test('structure rows print the compiled tag, through formatStructureTag itself', () => {
  const entries = realIndex();
  const structure = entries.filter((e) => e.kind === 'structure');
  const tags = SUNO_METATAGS.core.concat(SUNO_METATAGS.action);
  assert.strictEqual(structure.length, tags.length);
  for (let i = 0; i < tags.length; i += 1) {
    assert.strictEqual(
      structure[i].label,
      formatStructureTag(tags[i]),
      'a song-block row must show the tag the compiler would write, not a hand-typed one'
    );
  }
});

/* ========================================================================== */
/* 6. paletteMatch                                                            */
/* ========================================================================== */

s.test('ranking is prefix > word-prefix > substring > detail, and ties break deterministically', () => {
  const entries = [
    { kind: 'genre', id: 'a', label: 'chamber pop', detail: 'Indie', action() {} },
    { kind: 'genre', id: 'b', label: 'dark ambient', detail: 'Ambient', action() {} },
    { kind: 'genre', id: 'c', label: 'ambient', detail: 'Ambient', action() {} },
    { kind: 'genre', id: 'd', label: 'ambient pad wash', detail: 'Trance', action() {} },
    { kind: 'command', id: 'e', label: 'Open the theme picker', detail: 'ambient appearance', action() {} },
  ];

  // 'ambient': c is the label exactly, d starts with it, b has it at a word
  // boundary, e only has it in the detail — and 'chamber pop' does not contain
  // the word at all, so it is absent rather than last.
  const hits = own(paletteMatch('ambient', entries, 10).map((e) => e.id));
  assert.deepStrictEqual(
    hits,
    ['c', 'd', 'b', 'e'],
    'exact > label prefix > word prefix > detail; ties by shorter label, then index'
  );

  // 'amb' brings 'chamber pop' in as a MID-WORD substring, which is the whole
  // ladder in one query: two prefixes, a word prefix, a substring, a detail.
  const prefix = own(paletteMatch('amb', entries, 10).map((e) => e.id));
  assert.deepStrictEqual(
    prefix,
    ['c', 'd', 'b', 'a', 'e'],
    'prefix beats word-prefix beats substring beats a detail-only match'
  );
  assert.ok(prefix.indexOf('b') < prefix.indexOf('a'), 'a word-prefix must beat a mid-word substring');

  // Case folds and surrounding whitespace is not a query.
  assert.deepStrictEqual(own(paletteMatch('  AMBIENT ', entries, 10).map((e) => e.id)), hits);
});

s.test('the same query over the same index gives byte-identical results every time', () => {
  const entries = realIndex();
  for (const query of ['amapiano', 'a', 'reverb', 'copy', 'log drum', 'chorus', 'zzz']) {
    const once = paletteMatch(query, entries, PALETTE_DEFAULT_LIMIT).map((e) => e.id);
    const twice = paletteMatch(query, entries, PALETTE_DEFAULT_LIMIT).map((e) => e.id);
    assert.deepStrictEqual(twice, once, `"${query}" is not deterministic`);

    // …and it does not depend on the array being the same object, only on the
    // order of the entries in it. A ranker that leaned on sort stability for
    // its tie-break would drift here on some engines.
    const copy = entries.slice();
    assert.deepStrictEqual(paletteMatch(query, copy, PALETTE_DEFAULT_LIMIT).map((e) => e.id), once);
  }
});

s.test('a multi-word query matches on all of its words, even out of order', () => {
  const entries = [
    { kind: 'era', id: 'a', label: 'Plate Shimmer Reverb', detail: 'Reverb & Space', action() {} },
    { kind: 'era', id: 'b', label: 'Gated Reverb Snare', detail: '1980s', action() {} },
    { kind: 'genre', id: 'c', label: 'warehouse reverb', detail: 'Techno', action() {} },
  ];
  assert.deepStrictEqual(own(paletteMatch('reverb plate', entries, 10).map((e) => e.id)), ['a']);
  assert.deepStrictEqual(own(paletteMatch('plate reverb', entries, 10).map((e) => e.id)), ['a']);
  assert.deepStrictEqual(own(paletteMatch('reverb techno', entries, 10).map((e) => e.id)), ['c']);
  assert.deepStrictEqual(own(paletteMatch('reverb nothing', entries, 10)), []);
});

s.test('the limit is 12 by default, honoured when given, and ignored when nonsense', () => {
  const entries = realIndex();
  assert.strictEqual(PALETTE_DEFAULT_LIMIT, 12);
  assert.strictEqual(paletteMatch('a', entries).length, 12, 'the default cap is what the overlay renders');
  assert.strictEqual(paletteMatch('a', entries, 3).length, 3);
  assert.strictEqual(paletteMatch('a', entries, 1).length, 1);
  assert.strictEqual(paletteMatch('a', entries, 2.9).length, 2, 'a fractional limit floors');
  for (const bad of [0, -4, NaN, Infinity, null, undefined, '5']) {
    assert.strictEqual(paletteMatch('a', entries, bad).length, 12, `limit ${String(bad)}`);
  }
});

s.test('an empty query is "nothing narrowed yet" — the head of the index, not zero results', () => {
  const entries = realIndex();
  const head = own(paletteMatch('', entries, 5).map((e) => e.id));
  assert.deepStrictEqual(head, own(entries.slice(0, 5).map((e) => e.id)));
  assert.deepStrictEqual(own(paletteMatch('   ', entries, 5).map((e) => e.id)), head);
  assert.deepStrictEqual(own(paletteMatch(null, entries, 5).map((e) => e.id)), head);
  // Which means the first thing the palette ever shows is a command.
  assert.strictEqual(entries[0].kind, 'command');
});

s.test('paletteMatch survives a hostile or absent index without throwing', () => {
  for (const value of [null, undefined, 'entries', 42, {}]) {
    assert.deepStrictEqual(own(paletteMatch('a', value, 5)), []);
  }
  const mixed = [null, 'nope', 7, { kind: 'genre', id: 'ok', label: 'amapiano', detail: 'Amapiano' }];
  assert.deepStrictEqual(own(paletteMatch('amapiano', mixed, 5).map((e) => e.id)), ['ok']);
  assert.deepStrictEqual(own(paletteMatch('', mixed, 5).map((e) => e.id)), ['ok']);
});

s.test('searching the real index for a real genre finds that genre’s own tokens', () => {
  const entries = realIndex();
  const hits = paletteMatch('amapiano', entries, PALETTE_DEFAULT_LIMIT);
  assert.ok(hits.length > 1, 'amapiano is in MUSIC_KB; the palette must find it');
  assert.strictEqual(hits[0].kind, 'genre');
  assert.strictEqual(hits[0].label, 'amapiano', 'the exact tag leads its own family');
  assert.ok(
    hits.some((e) => e.kind === 'genre' && /Amapiano/i.test(e.detail)),
    'the sibling tokens of the genre must be reachable from the same query'
  );
});

/* ========================================================================== */
/* 7. Wiring — one behaviour, one definition                                  */
/* ========================================================================== */

s.test('the palette calls the cards’ OWN functions, never a second copy of them', () => {
  const source = app.source;

  // The verbs, exactly as the boot hands them to buildPaletteIndex.
  const wiring = [
    [/addGenreToken: function \(pick\) \{\s*return addGenreTokenToDraft\(pick\.tag, pick\.weight, 'manual'\);/, 'genre tokens'],
    [/addScene: function \(scene\) \{[\s\S]{0,320}?addScene\(\);/, 'scenes'],
    [/toggleVocalPersona: function \(persona\) \{\s*toggleVocalPersonaFromUi\(persona\);/, 'vocal personas'],
    [/toggleInstrumentBlock: function \(block\) \{\s*toggleInstrumentBlockFromUi\(block\);/, 'instrument blocks'],
    [/toggleEraSignature: function \(signature\) \{\s*toggleEraSignatureFromUi\(signature\);/, 'era signatures'],
    [/toggleExclusion: function \(term\) \{\s*return toggleExclusionFromUi\(term\);/, 'exclusions'],
    [/addMetatag: function \(section\) \{\s*addMetatag\(section\);/, 'song blocks'],
    [/command: function \(command\) \{\s*return runStudioAction\(command\.id\);/, 'commands'],
  ];
  for (const [pattern, what] of wiring) {
    assert.ok(pattern.test(source), `the palette does not reach the real ${what} path`);
  }

  /* And there is nowhere else for the behaviour to live. Each of these is the
     SINGLE call site of a mutation: a second one would be the palette (or
     anything else) having grown its own add path. */
  const singletons = [
    [/toggleVocalPersona\(promptState, persona\)/g, 'toggleVocalPersona'],
    [/toggleInstrumentBlock\(promptState, block\)/g, 'toggleInstrumentBlock'],
    [/toggleEraSignature\(promptState, signature\)/g, 'toggleEraSignature'],
    [/exclusions\.toggle\(/g, 'exclusions.toggle'],
    [/function addGenreTokenToDraft\(/g, 'addGenreTokenToDraft declaration'],
    [/function toggleExclusionFromUi\(/g, 'toggleExclusionFromUi declaration'],
    [/function copyStylePrompt\(/g, 'copyStylePrompt declaration'],
    [/function toggleRecording\(/g, 'toggleRecording declaration'],
  ];
  for (const [pattern, what] of singletons) {
    const hits = source.match(pattern) || [];
    assert.strictEqual(hits.length, 1, `${what} appears ${hits.length} times; it must be the one definition`);
  }

  // A genre token reaches the draft through ONE function, whoever asked: the
  // dissector's trait badge and the palette's genre row, and nothing else.
  const genreCallSites = source
    .split(/\r?\n/)
    .filter(
      (line) =>
        /addGenreTokenToDraft\(/.test(line) &&
        !/^\s*(?:\*|\/\/)/.test(line) &&
        !/^\s*function\s/.test(line)
    );
  assert.strictEqual(
    genreCallSites.length,
    2,
    `addGenreTokenToDraft has ${genreCallSites.length} call sites; expected exactly two — the dissector badge and the palette row`
  );
  assert.ok(
    /badge\.addEventListener\('click', function \(\) \{\s*addGenreTokenToDraft\(token\.tag, token\.weight, 'dissector'\);\s*\}\);/.test(
      source
    ),
    'the dissector badge must go through the shared function rather than keeping its own promptState.add'
  );
});

s.test('a keybind and the palette row that means the same thing are the SAME call', () => {
  const source = app.source;

  // Every action id either the registry or the command list names must exist
  // in the one verbs map, and nowhere else.
  const ids = new Set(
    dispatcherBindings()
      .map((b) => b.action)
      .concat(PALETTE_COMMANDS.map((c) => c.id))
  );
  for (const id of ids) {
    const pattern = new RegExp(`'${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}': function \\(\\) \\{`);
    assert.ok(pattern.test(source), `studioActions has no verb for the action id "${id}"`);
  }

  // …and the verbs really are the controls' own handlers.
  assert.ok(/'toggle-record': function \(\) \{\s*toggleRecording\(\);/.test(source));
  assert.ok(/'copy-style-prompt': function \(\) \{\s*copyStylePrompt\(\);/.test(source));
  assert.ok(/'view-hum': function \(\) \{\s*viewManager\.switchTo\('hum'\);/.test(source));
  assert.ok(/'view-editor': function \(\) \{\s*viewManager\.switchTo\('editor'\);/.test(source));
  assert.ok(/'code-mode': function \(\) \{\s*setCodeMode\(!themePrefs\.isHighContrast\(\)\);/.test(source));
  assert.ok(/'theme-picker': function \(\) \{\s*openThemeMenu\(\);/.test(source));
  assert.ok(/'inspire-spin': function \(\) \{[\s\S]{0,160}?runInspireSpin\(\);/.test(source));
  assert.ok(/'save-preset': function \(\) \{[\s\S]{0,600}?presetSaveBtn\.click\(\);/.test(source));
  assert.ok(/'export-midi': function \(\) \{[\s\S]{0,900}?midiBtn\.click\(\);/.test(source));

  // The two controls whose bodies moved into named functions this release.
  assert.ok(/recordBtn\.addEventListener\('click', toggleRecording\);/.test(source));
  assert.ok(/styleCopyBtn\.addEventListener\('click', copyStylePrompt\);/.test(source));

  // "when enabled" is honest: a disabled export says so instead of clicking a
  // dead button and looking broken.
  // A command CLOSES the palette, taking its status line with it — so a refusal
  // has to be said somewhere that outlives the overlay.
  assert.ok(
    /if \(midiBtn\.disabled\) \{[\s\S]{0,400}?toastHost\.show\(why, 'warn'\);\s*return why;/.test(source),
    'the MIDI command must TOAST an empty capture rather than returning a sentence into a closed overlay'
  );
});

s.test('the index is built lazily, once, from the boot', () => {
  const source = app.source;
  assert.ok(/let paletteEntries = null;/.test(source), 'the index must start unbuilt');
  assert.ok(
    /if \(paletteEntries === null\) \{\s*paletteEntries = buildPaletteIndex\(\{/.test(source),
    'the index must be built on first use, not at boot — 500+ entries nobody may ever search'
  );
  const builds = source.match(/buildPaletteIndex\(\{/g) || [];
  assert.strictEqual(builds.length, 1, 'there must be exactly one index');
  assert.ok(
    /paletteMatch\(paletteInput\.value, paletteIndex\(\), PALETTE_DEFAULT_LIMIT\)/.test(source),
    'the overlay must rank through paletteMatch rather than filtering by hand'
  );
});

/* ========================================================================== */
/* 8. The dialogs                                                             */
/* ========================================================================== */

s.test('both overlays are siblings of .app-shell, or "position: fixed" is a lie', () => {
  const html = readIndex();
  const shellEnd = /<\/main>\s*<\/div>/.exec(html);
  assert.ok(shellEnd, 'the .app-shell wrapper no longer closes after </main>');
  const shellEndsAt = shellEnd.index;

  for (const id of ['palette-backdrop', 'cheatsheet-backdrop']) {
    const at = html.indexOf(`<div id="${id}"`);
    assert.notStrictEqual(at, -1, `#${id} is missing from index.html`);
    assert.ok(
      at > shellEndsAt,
      `#${id} sits INSIDE .app-shell, whose container-type makes it the containing block for position:fixed — the overlay would be fixed to a 1200px column`
    );
  }

  const css = readStyle();
  assert.ok(
    /\.app-shell\s*\{[^}]*container-type:\s*inline-size/.test(css),
    'this test exists because .app-shell declares container-type; if it stopped, say so here'
  );
  assert.ok(/\.overlay-backdrop\s*\{[^}]*position:\s*fixed/.test(css));
  assert.ok(/\.overlay-backdrop\[hidden\]\s*\{\s*display:\s*none/.test(css), '[hidden] must beat display:flex');
});

s.test('the palette is a modal dialog with a combobox over a listbox', () => {
  const html = readIndex();

  const backdrop = /<div id="palette-backdrop"[^>]*>/.exec(html);
  assert.ok(backdrop && /\bhidden\b/.test(backdrop[0]), 'the palette must ship closed');

  const dialog = /<div id="palette"[^>]*>/.exec(html);
  assert.ok(dialog, '#palette is missing');
  assert.ok(/role="dialog"/.test(dialog[0]), '#palette must be a dialog');
  assert.ok(/aria-modal="true"/.test(dialog[0]), '#palette must be modal');
  assert.ok(/aria-labelledby="palette-title"/.test(dialog[0]), '#palette must be named');
  assert.ok(/id="palette-title"/.test(html), 'the label target does not exist');

  const input = /<input[^>]*id="palette-input"[^>]*>/.exec(html);
  assert.ok(input, '#palette-input is missing');
  for (const attr of [
    'role="combobox"',
    'aria-expanded="true"',
    'aria-controls="palette-list"',
    'aria-autocomplete="list"',
    'aria-activedescendant=""',
    'autocomplete="off"',
  ]) {
    assert.ok(input[0].includes(attr), `#palette-input is missing ${attr}`);
  }

  const list = /<ul[^>]*id="palette-list"[^>]*>/.exec(html);
  assert.ok(list && /role="listbox"/.test(list[0]), '#palette-list must be a listbox');
  assert.ok(/aria-label="/.test(list[0]), 'the listbox must be named');

  // A live region for what the palette just did, since a toggle leaves it open.
  const status = /<p[^>]*id="palette-status"[^>]*>/.exec(html);
  assert.ok(status && /role="status"/.test(status[0]) && /aria-live="polite"/.test(status[0]));

  // And a pointer entrance, or the whole catalogue is keyboard-only.
  const button = /<button[^>]*id="btn-palette"[^>]*>/.exec(html);
  assert.ok(button, '#btn-palette is missing — / would be the only way in');
  assert.ok(/aria-haspopup="dialog"/.test(button[0]));
  assert.ok(/aria-label="[^"]*slash[^"]*"/i.test(button[0]), 'the button should teach the shortcut');
});

s.test('the cheat sheet is a modal dialog with a real dismiss control', () => {
  const html = readIndex();

  const backdrop = /<div id="cheatsheet-backdrop"[^>]*>/.exec(html);
  assert.ok(backdrop && /\bhidden\b/.test(backdrop[0]), 'the cheat sheet must ship closed');

  const dialog = /<div id="cheatsheet"[^>]*>/.exec(html);
  assert.ok(dialog, '#cheatsheet is missing');
  assert.ok(/role="dialog"/.test(dialog[0]));
  assert.ok(/aria-modal="true"/.test(dialog[0]));
  assert.ok(/aria-labelledby="cheatsheet-title"/.test(dialog[0]));
  assert.ok(/id="cheatsheet-groups"/.test(html), 'the sheet has no host to render into');
  assert.ok(/id="btn-cheatsheet-close"/.test(html), 'Escape must not be the only way out');
});

s.test('one overlay contract: Escape closes, the scrim closes, Tab cannot leave, focus returns', () => {
  const source = app.source;
  const factory = /function createOverlay\(backdrop, dialog, options\) \{[\s\S]*?\n    \}\n\n    \/\* ---------------- the palette/.exec(
    source
  );
  assert.ok(factory, 'createOverlay could not be located');
  const body = factory[0];

  assert.ok(/event\.key === 'Escape'/.test(body), 'Escape must close');
  assert.ok(/event\.stopPropagation\(\);/.test(body), 'a modal Escape must not also reach the layer below');
  assert.ok(/event\.key !== 'Tab'/.test(body) && /event\.shiftKey/.test(body), 'Tab must wrap in both directions');
  assert.ok(/event\.target === backdrop/.test(body), 'only the scrim itself may dismiss');
  assert.ok(
    /restoreTo && typeof restoreTo\.focus === 'function'/.test(body),
    'focus must go back where it came from, or the keyboard is dumped on <body>'
  );
  assert.ok(/backdrop\.addEventListener\('keydown', onKeydown, true\)/.test(body), 'capture phase');

  // Both dialogs go through it — no second dismissal contract anywhere.
  // Comments naming the factory are prose, not call sites.
  const uses = source
    .split(/\r?\n/)
    .filter((line) => /createOverlay\(/.test(line) && !/^\s*(?:\*|\/\/)/.test(line));
  assert.strictEqual(
    uses.length,
    3,
    `createOverlay appears on ${uses.length} code lines; expected one declaration and exactly two overlays built from it`
  );
});

s.test('the overlays are token-driven, theme-aware and still there with motion off', () => {
  const css = readStyle();

  // No literal colour anywhere in the overlay rules — ui-layout.test.js holds
  // the whole stylesheet to that; this says the scrim in particular derives
  // from the theme's own ground rather than a fixed black.
  assert.ok(
    /--overlay-scrim:\s*color-mix\(in srgb, var\(--bg\)/.test(css),
    'the scrim must derive from --bg so it follows a theme swap'
  );
  assert.ok(/\.overlay-backdrop\s*\{[^}]*background:\s*var\(--overlay-scrim\)/.test(css));
  assert.ok(/\.overlay-dialog\s*\{[^}]*background:\s*var\(--toast-bg\)/.test(css));

  // Code Mode flattens them like every other floating surface.
  const contrast = css.slice(css.indexOf('.high-contrast'));
  assert.ok(/\.high-contrast \.overlay-dialog/.test(contrast), 'Code Mode must flatten the dialog');
  assert.ok(
    /\.high-contrast \.palette-option\[aria-selected="true"\]/.test(contrast),
    'the active row is a translucent cyan wash; Code Mode must give it a real border instead'
  );

  // Reduced motion: the entrance is the only thing that animates, and it goes.
  // The stylesheet carries several prefers-reduced-motion blocks (each guard
  // sits beside the rule it guards), so the check is "some block turns it off".
  const reducedBlocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/g) || [];
  assert.ok(reducedBlocks.length > 0, 'the reduced-motion guard is missing');
  assert.ok(
    reducedBlocks.some((block) => /\.overlay-dialog \{ animation: none; \}/.test(block)),
    'the overlay entrance animation must be turned off when the OS asks for stillness'
  );
  assert.ok(
    /\.overlay-dialog\s*\{[^}]*animation:\s*overlay-in/.test(css),
    '…and there must be an entrance for the guard to turn off'
  );

  // @media stays reserved for user preferences (ENGINEERING-STANDARD §2.2):
  // the overlay is sized in viewport units and min(), never at a breakpoint.
  for (const rule of css.match(/@media[^{]+/g) || []) {
    assert.ok(/prefers-/.test(rule), `@media is reserved for user preferences; found: ${rule.trim()}`);
  }
});

s.test('review fixes 0.22.x: empty-state announced, background inert while an overlay is open', () => {
  const html = readIndex();
  const source = app.source;

  // A zero-result palette query must announce itself to assistive tech.
  assert.ok(
    /<p id="palette-empty" class="palette-empty" role="status" hidden>/.test(html),
    '#palette-empty must carry role="status" so an empty result set is announced'
  );

  // aria-modal is a hint some AT ignores; inert on the app shell actually
  // removes the background from focus/click/virtual-cursor while open.
  const overlay = /function createOverlay\(backdrop, dialog, options\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(overlay, 'createOverlay not found');
  assert.ok(
    /shell\.inert = true;/.test(overlay[1]),
    'overlay open() must set .app-shell inert'
  );
  assert.ok(
    /shell\.inert = false;/.test(overlay[1]),
    'overlay close() must release .app-shell inert'
  );
});

s.finish();

module.exports = { loadAppSandbox, eventFor, expectedPaletteCounts };
