'use strict';
/*
 * tests/pwa.test.js — the PWA layer: the inline manifest (FDD #89), the
 * share-target reader (FDD #92 over docs/FEATURE-MECHANICS.md §6.6) and the
 * install capability.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING, in the order the file runs:
 *
 *   1. ENCODING. percentEncodeUri() exists only because PWA_MANIFEST is built
 *      at the TOP LEVEL of #app-main and the DOM-free sandboxes carry no host
 *      globals. A hand-rolled encoder is a liability unless it is held to the
 *      platform's, so it is round-tripped against encodeURIComponent over a
 *      hostile battery — quotes, hashes, spaces, astral-plane characters — and
 *      its one deliberate divergence (a lone surrogate becomes U+FFFD instead
 *      of throwing) is asserted rather than tolerated.
 *
 *   2. THE MANIFEST IS REAL. Not "a string that looks like JSON": the data:
 *      URI is decoded and JSON.parsed back, and the result is compared to the
 *      object it came from. Every member the spec requires for installability
 *      is asserted, and share_target is held to §6.6's exact shape — which
 *      hangs entirely on `params.text` being the string 'lyrics', because that
 *      is what makes a shared text arrive as ?lyrics=… and therefore what
 *      makes parseSharedLyrics the other half of one feature rather than two
 *      unrelated ones.
 *
 *   3. RELATIVE MEMBERS ARE RESOLVED. A data: URI has no directory, so '.'
 *      cannot be resolved against it: start_url silently falls back to the
 *      document URL and share_target.action, which has no fallback, is dropped
 *      entirely. pwaManifestFor() rewrites all three, and the query string is
 *      stripped first — a start_url carrying ?lyrics= would re-import the same
 *      text on every launch of the installed app.
 *
 *   4. THE SHARE IS TEXT. parseSharedLyrics is driven over the matrix the
 *      feature really meets, and a share carrying markup is asserted to arrive
 *      as characters — with a source-level check that the apply path writes
 *      through .value / textContent and never innerHTML.
 *
 *   5. NOTHING IS OFFERED THAT CANNOT BE DELIVERED. The install affordance is
 *      [hidden] in the markup and createInstallCapability only ever un-hides
 *      it in response to a real beforeinstallprompt. A test drives the whole
 *      state machine with no event at all and proves the affordance never
 *      appears.
 *
 *   6. THE SCANNER STILL BITES. tests/verify-single-file.js grew two rules for
 *      this feature; the negatives here prove the REAL index.html, mutated,
 *      still fails on a remote manifest href.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById, stripScriptBodies } = require('./lib/extract.js');
const { fakeEl, cssBlock, stripCssComments } = require('./ui-layout.test.js');
const { scanSingleFile } = require('./verify-single-file.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate #app-main in a DOM-free vm context.
 *
 * THREE GLOBALS BEYOND THE USUAL SET, and they are here for one reason each:
 *   URLSearchParams     — §6.6 names it, and it is the only decoder that reads
 *                         `+` as a space, which a form-encoded GET share
 *                         target guarantees every space arrives as;
 *   decodeURIComponent  — the round-trip half of the encoder test;
 *   encodeURIComponent  — the platform behaviour percentEncodeUri is held to.
 * None of the three is reachable from the top level of #app-main: everything
 * evaluated at load time uses language built-ins only, which is what keeps the
 * other twelve sandboxes in this directory working unchanged.
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
    URIError,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
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

/** Re-create a vm-context value as a plain object of THIS realm. */
function realm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(realm(actual), realm(expected), message);
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

function readStyle() {
  const m = /<style>([\s\S]*?)<\/style>/i.exec(readIndex());
  assert.ok(m, 'index.html has no inline <style> block');
  return stripCssComments(m[1]);
}

/**
 * The --bg a theme really declares, read out of the stylesheet rather than
 * copied into this file. The manifest's theme_color is supposed to be the
 * colour the page is painted in; a hard-coded expectation here would go on
 * passing after the palette moved underneath it.
 *
 * @param {string} selector e.g. ':root {' or '.theme-light {'
 */
function paletteBg(selector) {
  const block = cssBlock(readStyle(), selector);
  assert.ok(block, `no token block for ${selector}`);
  const m = /--bg:\s*([^;]+);/.exec(block.body);
  assert.ok(m, `${selector} declares no --bg`);
  return m[1].trim();
}

/** A <link> stand-in that records every href written to it. */
function fakeLink() {
  const link = fakeEl();
  link.hrefs = [];
  const setAttribute = link.setAttribute;
  link.setAttribute = function (name, value) {
    setAttribute(name, value);
    if (name === 'href') link.hrefs.push(String(value));
  };
  link.href = function () {
    return link.attrs.href === undefined ? null : link.attrs.href;
  };
  return link;
}

/**
 * A document rich enough for BOTH applyThemeState and updateManifestLink: a
 * root with a classList and an inline style, the color-scheme meta, a manifest
 * link, a location, and a getComputedStyle that answers --bg from the REAL
 * stylesheet according to whichever theme class is currently on the root.
 *
 * That last part is what makes the theme-tracking test mean something: the
 * fake does not hand back a colour the test chose, it hands back the colour
 * the cascade would.
 */
function fakeDoc(options) {
  const o = options || {};
  const props = Object.create(null);
  const root = fakeEl();
  const link = fakeLink();

  root.style = {
    setProperty(name, value) {
      props[name] = String(value);
    },
    removeProperty(name) {
      delete props[name];
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

  const doc = {
    documentElement: root,
    location: o.href === null ? null : { href: o.href || 'https://studio.example.com/app/index.html' },
    querySelector(selector) {
      if (selector === 'meta[name="color-scheme"]') return meta;
      if (selector === 'link[rel="manifest"]') return o.noLink ? null : link;
      return null;
    },
    root,
    link,
    meta,
    props,
  };

  doc.defaultView = o.noView
    ? null
    : {
        getComputedStyle(el) {
          assert.strictEqual(el, root, 'the manifest colour must be read off the ROOT element');
          return {
            getPropertyValue(name) {
              if (name !== '--bg') return '';
              // The USER override outranks the palette, exactly as an inline
              // custom property does in a real cascade.
              if (props[name]) return ' ' + props[name] + ' ';
              const cls = root.classes.find((c) => c.indexOf('theme-') === 0);
              return ' ' + paletteBg(cls ? `.${cls} {` : ':root {') + ' ';
            },
          };
        },
      };

  return doc;
}

/** A window stand-in that records listeners and lets a test fire them. */
function fakeWindow() {
  const listeners = Object.create(null);
  return {
    listeners,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
    types() {
      return Object.keys(listeners).sort();
    },
  };
}

/** A beforeinstallprompt stand-in: single-use prompt(), recorded calls. */
function fakeInstallEvent(outcome) {
  const event = {
    prevented: 0,
    prompted: 0,
    preventDefault() {
      event.prevented += 1;
    },
    prompt() {
      event.prompted += 1;
      return Promise.resolve({ outcome: outcome || 'accepted' });
    },
  };
  return event;
}

/** Decode a data: URI's payload back to the string that was encoded. */
function decodeDataUri(uri, expectedPrefix) {
  assert.strictEqual(typeof uri, 'string', 'the data URI must be a string');
  assert.ok(
    uri.indexOf(expectedPrefix) === 0,
    `expected a "${expectedPrefix}…" URI, got: ${uri.slice(0, 64)}`
  );
  return decodeURIComponent(uri.slice(expectedPrefix.length));
}

const MANIFEST_PREFIX = 'data:application/manifest+json;charset=utf-8,';
const ICON_PREFIX = 'data:image/svg+xml,';

const s = suite('pwa (inline manifest, share target, install capability)');

/* -------------------------------------------------------------------------- */
/* 1. Reachability                                                            */
/* -------------------------------------------------------------------------- */

s.test('the PWA layer is reachable as top-level declarations, before the boot IIFE', () => {
  for (const name of [
    'percentEncodeUri',
    'svgDataUri',
    'manifestDocumentUrl',
    'normalizeManifestColor',
    'pwaManifestFor',
    'manifestDataUri',
    'readManifestColors',
    'updateManifestLink',
    'parseSharedLyrics',
    'shareCredit',
    'shareToastMessage',
    'createInstallCapability',
  ]) {
    assert.strictEqual(
      typeof app.sandbox[name],
      'function',
      `${name} must be a top-level \`function\` declaration, before the boot IIFE`
    );
  }
  assert.strictEqual(typeof app.sandbox.PWA_MANIFEST, 'object', 'PWA_MANIFEST must be a top-level var');
  assert.strictEqual(typeof app.sandbox.PWA_ICON_SVG, 'string', 'PWA_ICON_SVG must be a top-level var');
});

s.test('loading #app-main touches no host global — the other sandboxes stay valid', () => {
  /* The twelve other suites in this directory build sandboxes WITHOUT
   * URLSearchParams, encodeURIComponent or decodeURIComponent. PWA_MANIFEST is
   * built at load time, so if any of them leaked into a top-level code path
   * every one of those suites would stop loading the file at all. Proven by
   * loading it in a sandbox that has none of the three. */
  const bare = {
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
  };
  vm.createContext(bare);
  assert.doesNotThrow(() => {
    vm.runInContext(app.source, bare, { filename: 'index.html#app-main (bare)' });
  }, '#app-main must load with language built-ins alone');
  assert.strictEqual(
    typeof bare.PWA_MANIFEST.icons[0].src,
    'string',
    'the icon URI must have been built without a host global'
  );
});

/* -------------------------------------------------------------------------- */
/* 2. percentEncodeUri — held to the platform's behaviour                     */
/* -------------------------------------------------------------------------- */

s.test('percentEncodeUri matches encodeURIComponent byte for byte', () => {
  const { percentEncodeUri } = app.sandbox;
  const battery = [
    '',
    'plain',
    'a b c',
    '#fragment',
    '?query=1&other=2',
    '{"json":"value"}',
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "quotes ' and \" and ` and \\",
    'slash/colon:semi;comma,plus+equals=',
    'unreserved -_.!~*\'()',
    'percent % literal',
    'newline\nand\ttab\r',
    'em dash — ellipsis … accented éüñ',
    'cyrillic Привет, greek αβγ',
    'astral 𝄞 and emoji 🎛️🎚️',
    'control \u0001\u001f\u007f',
    'nbsp\u00a0 and\u2009thin',
  ];
  for (const text of battery) {
    assert.strictEqual(
      percentEncodeUri(text),
      encodeURIComponent(text),
      `diverged on ${JSON.stringify(text)}`
    );
  }
});

s.test('percentEncodeUri round-trips through decodeURIComponent', () => {
  const { percentEncodeUri } = app.sandbox;
  for (const text of ['🎛️ shared lyrics — line one\nline two', '{"a":"</script>"}', '%%%', '/../..%2F']) {
    assert.strictEqual(decodeURIComponent(percentEncodeUri(text)), text, `lost on ${JSON.stringify(text)}`);
  }
});

s.test('percentEncodeUri never throws — a lone surrogate becomes U+FFFD, not a URIError', () => {
  const { percentEncodeUri } = app.sandbox;
  // The one deliberate divergence, and the reason for it: a malformed
  // character somewhere in a description must not be able to take the boot
  // sequence down with a URIError.
  assert.throws(() => encodeURIComponent('\ud800'), 'the platform is expected to throw here');
  assert.strictEqual(percentEncodeUri('\ud800'), encodeURIComponent('�'));
  assert.strictEqual(percentEncodeUri('a\udfffb'), 'a' + encodeURIComponent('�') + 'b');
  // A WELL-FORMED pair is a character, and must survive as one.
  assert.strictEqual(percentEncodeUri('𝄞'), encodeURIComponent('𝄞'));

  for (const junk of [null, undefined, 0, false]) {
    assert.strictEqual(percentEncodeUri(junk), junk === 0 ? '0' : junk === false ? 'false' : '');
  }
});

/* -------------------------------------------------------------------------- */
/* 3. The icon                                                                */
/* -------------------------------------------------------------------------- */

s.test('the icon is a self-contained SVG document, and its data: URI decodes back to it', () => {
  const { PWA_ICON_SVG, svgDataUri } = app.sandbox;

  assert.ok(/^<svg\b/.test(PWA_ICON_SVG), 'the icon must be an <svg> document');
  assert.ok(/<\/svg>$/.test(PWA_ICON_SVG), 'the icon must be closed');
  assert.ok(
    /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(PWA_ICON_SVG),
    'a STANDALONE svg document does not parse without its namespace'
  );
  assert.ok(/viewBox="0 0 512 512"/.test(PWA_ICON_SVG), 'the icon needs a viewBox to scale at all');

  // Self-contained: no <image>, no <use href>, no url() — an icon that fetches
  // anything is an icon that is blank offline, which is every launch here.
  assert.ok(!/<image\b|<use\b|url\(/.test(PWA_ICON_SVG), 'the icon must reference nothing external');
  // …and the ONLY absolute URL in it is the namespace, which is a name.
  const urls = PWA_ICON_SVG.match(/https?:\/\/[^"']+/g) || [];
  deepEqual(urls, ['http://www.w3.org/2000/svg'], 'the namespace must be the only URL in the icon');

  // ASCII only, so the encoded URI is ASCII too and cannot depend on a charset.
  assert.ok(!/[^\x00-\x7f]/.test(PWA_ICON_SVG), 'the icon source must stay ASCII');

  assert.strictEqual(decodeDataUri(svgDataUri(PWA_ICON_SVG), ICON_PREFIX), PWA_ICON_SVG);
});

/* -------------------------------------------------------------------------- */
/* 4. PWA_MANIFEST — the declaration                                          */
/* -------------------------------------------------------------------------- */

s.test('PWA_MANIFEST declares every member installability actually needs', () => {
  const m = realm(app.sandbox.PWA_MANIFEST);

  assert.strictEqual(m.name, 'SunoPrompt Studio');
  assert.strictEqual(m.short_name, 'SunoPrompt');
  assert.ok(typeof m.description === 'string' && m.description.length > 20, 'a real description');
  assert.strictEqual(m.start_url, '.', 'FDD #89 asks for "." — the rewrite is pwaManifestFor’s job');
  assert.strictEqual(m.scope, '.');
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.lang, 'en');

  assert.ok(Array.isArray(m.icons) && m.icons.length === 1, 'exactly one icon is declared');
  const icon = m.icons[0];
  assert.strictEqual(icon.type, 'image/svg+xml');
  assert.strictEqual(icon.sizes, 'any', 'an SVG has no pixel size; "any" is the honest answer');
  assert.strictEqual(icon.purpose, 'any');
  assert.ok(icon.src.indexOf(ICON_PREFIX) === 0, 'the icon src must be an inline data: URI');
  assert.strictEqual(decodeDataUri(icon.src, ICON_PREFIX), app.sandbox.PWA_ICON_SVG);

  // No 'maskable' claim anywhere: the mark is not drawn for a safe circle, and
  // claiming the purpose would ship a logo Android crops.
  assert.ok(!/maskable/.test(JSON.stringify(m)), 'no maskable purpose may be claimed');

  // The colours are NOT declared here: they are the live theme's, filled in by
  // pwaManifestFor from what the page is actually painted with.
  assert.strictEqual(m.theme_color, undefined, 'theme_color must track the theme, not be frozen here');
  assert.strictEqual(m.background_color, undefined);
});

s.test('share_target is the §6.6 shape, and params.text is what makes it work', () => {
  const target = realm(app.sandbox.PWA_MANIFEST.share_target);

  assert.ok(target, 'FDD #92 requires a share_target member');
  assert.strictEqual(target.method, 'GET', 'a POST share target needs a service worker, which a single file has none of');
  assert.strictEqual(target.enctype, 'application/x-www-form-urlencoded');
  assert.strictEqual(target.action, '.');

  deepEqual(target.params, { title: 'title', text: 'lyrics', url: 'url' });

  /* THE LOAD-BEARING ASSERTION. §6.6 tells the boot script to read
   * `new URLSearchParams(location.search).get('lyrics')`. The OS puts the
   * shared TEXT into the parameter named by params.text — so params.text has
   * to be the literal string 'lyrics' or the two halves of this feature are
   * wired to different parameters and the share silently does nothing. */
  assert.strictEqual(target.params.text, 'lyrics', 'params.text must name the parameter §6.6 reads');
  assert.strictEqual(
    target.params.text,
    app.sandbox.SHARE_PARAM_LYRICS,
    'the manifest and the reader must name the same parameter'
  );
});

/* -------------------------------------------------------------------------- */
/* 5. pwaManifestFor — resolution and colour                                  */
/* -------------------------------------------------------------------------- */

s.test('pwaManifestFor resolves the relative members against the document URL', () => {
  const { pwaManifestFor } = app.sandbox;
  const m = realm(pwaManifestFor({ href: 'https://studio.example.com/app/index.html' }));

  assert.strictEqual(m.start_url, 'https://studio.example.com/app/index.html');
  assert.strictEqual(m.scope, 'https://studio.example.com/app/');
  assert.strictEqual(
    m.share_target.action,
    'https://studio.example.com/app/index.html',
    'an action a data: URI cannot resolve means share_target is dropped entirely'
  );
  // The action must sit inside the scope or the spec discards share_target.
  assert.ok(m.share_target.action.indexOf(m.scope) === 0, 'the action must be within scope');
});

s.test('pwaManifestFor strips the query and fragment — a share must not relaunch itself', () => {
  const { pwaManifestFor } = app.sandbox;
  const shared = realm(
    pwaManifestFor({ href: 'https://studio.example.com/app/index.html?lyrics=hello%20there&title=Notes#top' })
  );
  assert.strictEqual(
    shared.start_url,
    'https://studio.example.com/app/index.html',
    'a start_url carrying ?lyrics= re-imports the same text on every launch'
  );
  assert.strictEqual(shared.share_target.action, 'https://studio.example.com/app/index.html');
  assert.ok(shared.start_url.indexOf('lyrics') === -1);
});

s.test('pwaManifestFor keeps "." when there is no usable document URL', () => {
  const { pwaManifestFor } = app.sandbox;
  for (const href of [undefined, null, '', 'index.html', './index.html', 42, {}]) {
    const m = realm(pwaManifestFor({ href }));
    assert.strictEqual(m.start_url, '.', `a relative or absent href must not be resolved: ${String(href)}`);
    assert.strictEqual(m.scope, '.');
    assert.strictEqual(m.share_target.action, '.');
  }
  deepEqual(realm(pwaManifestFor()), realm(pwaManifestFor({})), 'no options at all is the same as {}');
});

s.test('pwaManifestFor takes the colours it is given, and omits the ones it is not', () => {
  const { pwaManifestFor } = app.sandbox;

  const painted = realm(pwaManifestFor({ themeColor: ' #0a0a0c ', backgroundColor: '#0A0A0C' }));
  assert.strictEqual(painted.theme_color, '#0A0A0C', 'the shared validator normalises case');
  assert.strictEqual(painted.background_color, '#0A0A0C');

  const rgba = realm(pwaManifestFor({ themeColor: 'rgba(10, 10, 12, 0.9)', backgroundColor: 'rgb(10,10,12)' }));
  assert.strictEqual(rgba.theme_color, 'rgba(10, 10, 12, 0.9)');
  assert.strictEqual(rgba.background_color, 'rgb(10, 10, 12)');

  // A colour the app itself would refuse to paint with can never reach the
  // manifest: normalizeColorValue is the same gate in both places.
  for (const hostile of ['url(javascript:alert(1))', 'red; --glass-blur: none', '', '   ', 'not-a-colour', 42, null]) {
    const m = realm(pwaManifestFor({ themeColor: hostile, backgroundColor: hostile }));
    assert.strictEqual(m.theme_color, undefined, `${JSON.stringify(hostile)} must be omitted, not guessed`);
    assert.strictEqual(m.background_color, undefined);
  }
});

s.test('pwaManifestFor never mutates PWA_MANIFEST', () => {
  const { pwaManifestFor, PWA_MANIFEST } = app.sandbox;
  const before = JSON.stringify(realm(PWA_MANIFEST));
  const a = pwaManifestFor({ href: 'https://a.example.com/x/index.html', themeColor: '#111111' });
  a.name = 'mutated';
  a.share_target.action = 'mutated';
  a.icons[0].src = 'mutated';
  pwaManifestFor({ href: 'https://b.example.com/y/index.html' });
  assert.strictEqual(JSON.stringify(realm(PWA_MANIFEST)), before, 'the declaration was edited underneath');
});

/* -------------------------------------------------------------------------- */
/* 6. The data: URI — decode round-trip                                       */
/* -------------------------------------------------------------------------- */

s.test('the manifest data: URI decodes to valid JSON that equals the object it came from', () => {
  const { pwaManifestFor, manifestDataUri } = app.sandbox;
  const manifest = pwaManifestFor({
    href: 'https://studio.example.com/app/index.html',
    themeColor: '#0A0A0C',
    backgroundColor: '#0A0A0C',
  });
  const uri = manifestDataUri(manifest);

  const json = decodeDataUri(uri, MANIFEST_PREFIX);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(json);
  }, `the decoded manifest is not valid JSON:\n${json.slice(0, 200)}`);

  deepEqual(parsed, realm(manifest), 'the round trip lost or changed something');

  // …and the parsed result is still a manifest, not merely equal to an object.
  assert.strictEqual(parsed.display, 'standalone');
  assert.strictEqual(parsed.share_target.params.text, 'lyrics');
  assert.strictEqual(parsed.theme_color, '#0A0A0C');
  assert.ok(parsed.icons[0].src.indexOf(ICON_PREFIX) === 0);
});

s.test('the manifest URI is transport-safe: ASCII, no raw # or whitespace', () => {
  const { pwaManifestFor, manifestDataUri } = app.sandbox;
  const uri = manifestDataUri(pwaManifestFor({ href: 'https://studio.example.com/app/index.html', themeColor: '#0A0A0C' }));

  const payload = uri.slice(MANIFEST_PREFIX.length);
  assert.ok(!/[^\x21-\x7e]/.test(payload), 'the payload must be printable ASCII with no whitespace');
  assert.ok(
    payload.indexOf('#') === -1,
    'a raw # would truncate the URI at the fragment and hand the parser half a manifest'
  );
  assert.ok(payload.indexOf('"') === -1, 'a raw quote would end the attribute value early');
  assert.ok(uri.length < 16000, `the URI is ${uri.length} chars — an icon has crept out of hand`);
});

/* -------------------------------------------------------------------------- */
/* 7. parseSharedLyrics — the §6.6 matrix                                     */
/* -------------------------------------------------------------------------- */

s.test('parseSharedLyrics reads the ?lyrics= parameter §6.6 names', () => {
  const { parseSharedLyrics } = app.sandbox;
  const out = realm(parseSharedLyrics('?lyrics=neon%20rain%20on%20glass'));
  deepEqual(out, {
    present: true,
    lyrics: 'neon rain on glass',
    title: '',
    url: '',
    source: 'lyrics',
    truncated: false,
  });
  // With or without the leading '?', because location.search has one and a
  // hand-built string usually does not.
  deepEqual(realm(parseSharedLyrics('lyrics=neon%20rain%20on%20glass')), out);
});

s.test('parseSharedLyrics falls back to ?text=, and lyrics wins when both carry text', () => {
  const { parseSharedLyrics } = app.sandbox;

  const fallback = realm(parseSharedLyrics('?text=from%20another%20share%20sheet'));
  assert.strictEqual(fallback.lyrics, 'from another share sheet');
  assert.strictEqual(fallback.source, 'text');

  const both = realm(parseSharedLyrics('?lyrics=mine&text=theirs'));
  assert.strictEqual(both.lyrics, 'mine', 'the parameter this app’s own manifest asks for wins');
  assert.strictEqual(both.source, 'both', 'and the caller can still tell both arrived');

  // An EMPTY lyrics parameter is not a claim on the slot: the text still lands.
  const empty = realm(parseSharedLyrics('?lyrics=&text=theirs'));
  assert.strictEqual(empty.lyrics, 'theirs');
  assert.strictEqual(empty.source, 'text');

  // Whitespace is not text either.
  const blank = realm(parseSharedLyrics('?lyrics=%20%0A%20&text=theirs'));
  assert.strictEqual(blank.lyrics, 'theirs');
});

s.test('parseSharedLyrics reports nothing when there is nothing', () => {
  const { parseSharedLyrics } = app.sandbox;
  const nothing = {
    present: false,
    lyrics: '',
    title: '',
    url: '',
    source: 'none',
    truncated: false,
  };
  for (const search of ['', '?', 'x', null, undefined, 42, {}, '?other=1&more=2', '?lyrics=', '?lyrics=%20%20']) {
    deepEqual(realm(parseSharedLyrics(search)), nothing, `expected an empty read for ${JSON.stringify(search)}`);
  }
});

s.test('parseSharedLyrics decodes URL-encoded multiline text, plus-signs included', () => {
  const { parseSharedLyrics } = app.sandbox;

  const encoded = realm(parseSharedLyrics('?lyrics=first%20line%0Asecond%20line%0A%0Afourth'));
  assert.strictEqual(encoded.lyrics, 'first line\nsecond line\n\nfourth');

  /* A GET share target is application/x-www-form-urlencoded, so every space
   * the OS hands over arrives as '+'. URLSearchParams is the decoder that gets
   * that right; decodeURIComponent alone would leave the plus signs in. */
  const formEncoded = realm(parseSharedLyrics('?lyrics=neon+rain+on+glass%0Acity+lights'));
  assert.strictEqual(formEncoded.lyrics, 'neon rain on glass\ncity lights');

  // CRLF is normalised the same way a pasted Windows lyric is, and leading
  // blank lines and trailing whitespace are trimmed off exactly as lyricBody
  // trims a typed one — shared text and typed text are stored in one shape.
  const windows = realm(parseSharedLyrics('?lyrics=%0A%0Aone%0D%0Atwo%20%20%0D%0A%20'));
  assert.strictEqual(windows.lyrics, 'one\ntwo');
});

s.test('parseSharedLyrics carries the title and URL as CREDIT, never as lyrics', () => {
  const { parseSharedLyrics } = app.sandbox;

  const full = realm(
    parseSharedLyrics('?lyrics=the%20words&title=My%20Notes&url=https%3A%2F%2Fexample.com%2Fnote%2F7')
  );
  assert.strictEqual(full.lyrics, 'the words');
  assert.strictEqual(full.title, 'My Notes');
  assert.strictEqual(full.url, 'https://example.com/note/7');

  /* A share with a title and no text is a REAL intent — the user picked this
   * app off a share sheet — but a page title is a name, not a lyric. It is
   * reported as present with no lyrics so the caller can say so out loud
   * rather than inventing a verse out of a headline. */
  const creditOnly = realm(parseSharedLyrics('?title=Some%20Page&url=https%3A%2F%2Fexample.com%2F'));
  assert.strictEqual(creditOnly.present, true);
  assert.strictEqual(creditOnly.lyrics, '');
  assert.strictEqual(creditOnly.source, 'credit-only');
  assert.strictEqual(creditOnly.title, 'Some Page');

  // Credit is flattened to one line and capped, because it goes in a toast.
  const long = realm(parseSharedLyrics('?lyrics=x&title=' + encodeURIComponent('T'.repeat(400))));
  assert.ok(long.title.length <= app.sandbox.SHARE_CREDIT_MAX, `title not capped: ${long.title.length}`);
  assert.ok(/…$/.test(long.title), 'a cut title must show that it was cut');
  const multiline = realm(parseSharedLyrics('?lyrics=x&title=one%0Atwo%20%20three'));
  assert.strictEqual(multiline.title, 'one two three', 'a title is one line');
});

s.test('parseSharedLyrics caps a hostile-sized share and REPORTS the cut', () => {
  const { parseSharedLyrics, SHARE_LYRICS_MAX } = app.sandbox;

  const big = realm(parseSharedLyrics('?lyrics=' + encodeURIComponent('a'.repeat(SHARE_LYRICS_MAX + 500))));
  assert.strictEqual(big.lyrics.length, SHARE_LYRICS_MAX);
  assert.strictEqual(big.truncated, true, 'a silent truncation is an edit to the user’s words');

  const exact = realm(parseSharedLyrics('?lyrics=' + encodeURIComponent('a'.repeat(SHARE_LYRICS_MAX))));
  assert.strictEqual(exact.truncated, false, 'exactly at the cap is not over it');
  assert.strictEqual(exact.lyrics.length, SHARE_LYRICS_MAX);
});

s.test('parseSharedLyrics is pure: hostile markup comes back as characters, unescaped', () => {
  const { parseSharedLyrics } = app.sandbox;

  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '</textarea><svg onload=alert(1)>',
    '"><script>fetch("https://evil.example.com")</script>',
    '&lt;script&gt;already escaped&lt;/script&gt;',
    '{{constructor.constructor("alert(1)")()}}',
  ];
  for (const payload of payloads) {
    const out = realm(parseSharedLyrics('?lyrics=' + encodeURIComponent(payload)));
    /* NOT escaped on the way through, and that is the point: the value is
     * written with .value / textContent (asserted against the boot source
     * below), where markup is characters. Escaping it here would DISPLAY the
     * escapes, which is its own small lie about what the user shared. */
    assert.strictEqual(out.lyrics, payload, `the payload was altered: ${payload}`);
  }

  const inTitle = realm(parseSharedLyrics('?lyrics=x&title=' + encodeURIComponent('<b>bold</b>')));
  assert.strictEqual(inTitle.title, '<b>bold</b>');
});

/* -------------------------------------------------------------------------- */
/* 8. shareToastMessage                                                       */
/* -------------------------------------------------------------------------- */

s.test('shareToastMessage credits the share and admits a truncation', () => {
  const { parseSharedLyrics, shareToastMessage, SHARE_LYRICS_MAX } = app.sandbox;

  const plain = parseSharedLyrics('?lyrics=words');
  assert.strictEqual(shareToastMessage(plain, '[Verse]'), 'Added shared text to [Verse].');

  const credited = parseSharedLyrics('?lyrics=words&title=My%20Notes');
  assert.strictEqual(
    shareToastMessage(credited, '[Chorus 2]'),
    'Added shared text to [Chorus 2]. Shared from: My Notes'
  );

  const linked = parseSharedLyrics('?lyrics=words&url=https%3A%2F%2Fexample.com%2Fn');
  assert.ok(/Shared from: https:\/\/example\.com\/n$/.test(shareToastMessage(linked, '[Verse]')));

  const cut = parseSharedLyrics('?lyrics=' + encodeURIComponent('a'.repeat(SHARE_LYRICS_MAX + 1)));
  assert.ok(
    shareToastMessage(cut, '[Verse]').indexOf(`longer than ${SHARE_LYRICS_MAX} characters`) !== -1,
    'the toast must admit the cut'
  );

  // No lyrics, no claim that anything was added.
  const creditOnly = parseSharedLyrics('?title=Some%20Page');
  const message = shareToastMessage(creditOnly, '[Verse]');
  assert.ok(message.indexOf('no text') !== -1, `expected an honest "nothing added", got: ${message}`);
  assert.ok(message.indexOf('Added') === -1, 'nothing was added, so nothing may say it was');

  // Nothing at all in, nothing at all out.
  for (const junk of [null, undefined, {}, { present: false }]) {
    assert.strictEqual(shareToastMessage(junk, '[Verse]'), '');
  }
  // A missing tag degrades to plain English rather than to "undefined".
  assert.ok(shareToastMessage(plain, '').indexOf('the first block') !== -1);
});

/* -------------------------------------------------------------------------- */
/* 9. The manifest link, and the theme hook that keeps it current             */
/* -------------------------------------------------------------------------- */

s.test('updateManifestLink writes a decodable manifest onto the link', () => {
  const { updateManifestLink } = app.sandbox;
  const doc = fakeDoc({ href: 'https://studio.example.com/app/index.html?lyrics=x' });

  const href = updateManifestLink(doc);
  assert.strictEqual(href, doc.link.href(), 'the returned URI must be the one that was written');

  const parsed = JSON.parse(decodeDataUri(href, MANIFEST_PREFIX));
  assert.strictEqual(parsed.name, 'SunoPrompt Studio');
  assert.strictEqual(parsed.start_url, 'https://studio.example.com/app/index.html');
  assert.strictEqual(parsed.theme_color, paletteBg(':root {').toUpperCase(), 'the dark palette’s --bg');
  assert.strictEqual(parsed.background_color, parsed.theme_color, 'a split colour makes the launch flash');
});

s.test('updateManifestLink is a no-op on a document that has no link or no view', () => {
  const { updateManifestLink } = app.sandbox;
  assert.strictEqual(updateManifestLink(null), null);
  assert.strictEqual(updateManifestLink({}), null, 'no querySelector, nothing to do');
  assert.strictEqual(updateManifestLink(fakeDoc({ noLink: true })), null);

  // No getComputedStyle: the link is still written, but WITHOUT a colour —
  // an omitted theme_color lets the UA choose; a guessed one paints it wrong.
  const blind = fakeDoc({ noView: true });
  const href = updateManifestLink(blind);
  assert.ok(href, 'a document with no view still gets a manifest');
  const parsed = JSON.parse(decodeDataUri(href, MANIFEST_PREFIX));
  assert.strictEqual(parsed.theme_color, undefined, 'nothing measured, nothing claimed');
  assert.strictEqual(parsed.background_color, undefined);
});

s.test('a theme change updates the manifest href — on the same hook as meta[color-scheme]', () => {
  const { applyThemeState, createThemePrefs } = app.sandbox;
  const doc = fakeDoc({});
  const prefs = createThemePrefs({
    storage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  });

  const themeColorOf = () => JSON.parse(decodeDataUri(doc.link.href(), MANIFEST_PREFIX)).theme_color;

  prefs.setThemeId('obsidian');
  applyThemeState(prefs, doc);
  const dark = themeColorOf();
  assert.strictEqual(dark, paletteBg(':root {').toUpperCase());
  assert.strictEqual(doc.meta.getAttribute('content'), 'dark', 'the two must move together');

  prefs.setThemeId('daylight');
  applyThemeState(prefs, doc);
  const light = themeColorOf();
  assert.strictEqual(light, paletteBg('.theme-light {').toUpperCase());
  assert.strictEqual(doc.meta.getAttribute('content'), 'light');
  assert.notStrictEqual(light, dark, 'the manifest colour did not track the theme at all');

  prefs.setThemeId('tape-deck');
  applyThemeState(prefs, doc);
  assert.strictEqual(themeColorOf(), paletteBg('.theme-tape-deck {').toUpperCase());

  // A USER override of --bg outranks the palette in the cascade, so it has to
  // outrank it in the manifest too — the manifest reports what is PAINTED.
  prefs.setThemeId('obsidian');
  prefs.setCustomColor('--bg', '#123456');
  applyThemeState(prefs, doc);
  assert.strictEqual(themeColorOf(), '#123456');

  // Every apply writes exactly one href: idempotent, no drift, no churn.
  const count = doc.link.hrefs.length;
  applyThemeState(prefs, doc);
  assert.strictEqual(doc.link.hrefs.length, count + 1);
  assert.strictEqual(doc.link.hrefs[count], doc.link.hrefs[count - 1], 'the same state must produce the same URI');
});

s.test('applyThemeState still returns exactly what it returned before the hook was added', () => {
  const { applyThemeState, createThemePrefs } = app.sandbox;
  const prefs = createThemePrefs({
    storage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  });
  prefs.setThemeId('daylight');
  const result = realm(applyThemeState(prefs, fakeDoc({})));
  deepEqual(Object.keys(result).sort(), ['applied', 'highContrast', 'theme', 'themeId']);
  assert.strictEqual(result.theme, 'light');
  assert.strictEqual(result.themeId, 'daylight');
});

/* -------------------------------------------------------------------------- */
/* 10. Install capability                                                     */
/* -------------------------------------------------------------------------- */

s.test('with no beforeinstallprompt, nothing is available and nothing is ever offered', () => {
  const { createInstallCapability } = app.sandbox;
  const win = fakeWindow();
  const seen = [];
  const install = createInstallCapability({ window: win, onChange: (v) => seen.push(v) });

  assert.strictEqual(install.listen(), true);
  deepEqual(win.types(), ['appinstalled', 'beforeinstallprompt'], 'both events must be listened for');

  assert.strictEqual(install.available(), false, 'nothing has offered anything yet');
  assert.strictEqual(install.prompt(), null, 'there is nothing to prompt with');
  deepEqual(seen, [], 'the caller must never be told to show an affordance that cannot work');

  // Firing an unrelated event changes nothing.
  win.fire('appinstalled', {});
  assert.strictEqual(install.available(), false);
});

s.test('a real beforeinstallprompt is captured, deferred and offered exactly once', async () => {
  const { createInstallCapability } = app.sandbox;
  const win = fakeWindow();
  const seen = [];
  const install = createInstallCapability({ window: win, onChange: (v) => seen.push(v) });
  install.listen();

  const event = fakeInstallEvent('accepted');
  win.fire('beforeinstallprompt', event);

  assert.strictEqual(event.prevented, 1, 'without preventDefault Chromium eats the event');
  assert.strictEqual(install.available(), true);
  deepEqual(seen, [true], 'the affordance is un-hidden exactly once');
  assert.strictEqual(install.deferredEvent(), event);

  const choice = install.prompt();
  assert.strictEqual(event.prompted, 1, 'the browser’s own dialog must be the thing that opens');
  assert.ok(choice && typeof choice.then === 'function');
  deepEqual(await choice, { outcome: 'accepted' });

  // Single use: the event is spent, so the affordance goes with it rather than
  // becoming a button that silently does nothing on the second click.
  assert.strictEqual(install.available(), false);
  assert.strictEqual(install.deferredEvent(), null);
  assert.strictEqual(install.prompt(), null);
  assert.strictEqual(event.prompted, 1, 'a second click must not re-prompt a spent event');
  deepEqual(seen, [true, false]);
});

s.test('dismissing hides the offer for the session and does not persist anything', () => {
  const { createInstallCapability } = app.sandbox;
  const win = fakeWindow();
  const seen = [];
  const install = createInstallCapability({ window: win, onChange: (v) => seen.push(v) });
  install.listen();
  win.fire('beforeinstallprompt', fakeInstallEvent());

  assert.strictEqual(install.available(), true);
  assert.strictEqual(install.dismiss(), true);
  assert.strictEqual(install.available(), false);
  assert.strictEqual(install.dismiss(), false, 'dismissing twice is not two dismissals');
  deepEqual(seen, [true, false]);

  // A second offer from the engine cannot un-dismiss the session's decision.
  win.fire('beforeinstallprompt', fakeInstallEvent());
  assert.strictEqual(install.available(), false);

  // A fresh capability starts fresh: the decision was about this session.
  const next = createInstallCapability({ window: fakeWindow() });
  assert.strictEqual(next.available(), false);
});

s.test('appinstalled retires the offer, and a windowless capability degrades quietly', () => {
  const { createInstallCapability } = app.sandbox;
  const win = fakeWindow();
  const install = createInstallCapability({ window: win });
  install.listen();
  win.fire('beforeinstallprompt', fakeInstallEvent());
  win.fire('appinstalled', {});
  assert.strictEqual(install.available(), false, 'an installed app has nothing to install');
  assert.strictEqual(install.prompt(), null);

  for (const deps of [undefined, {}, { window: null }, { window: {} }]) {
    const bare = createInstallCapability(deps);
    assert.strictEqual(bare.listen(), false, 'nothing to listen on is not an error');
    assert.strictEqual(bare.available(), false);
    assert.strictEqual(bare.prompt(), null);
  }
});

/* -------------------------------------------------------------------------- */
/* 11. Markup and boot wiring                                                 */
/* -------------------------------------------------------------------------- */

s.test('the manifest link ships in the head with NO href, so the only one is the inline one', () => {
  // Script bodies AND HTML comments are prose: the head comment above the link
  // and #app-main's documentation both name the tag while explaining it.
  const markup = stripScriptBodies(readIndex()).replace(/<!--[\s\S]*?-->/g, '');
  const links = markup.match(/<link\b[^>]*rel="manifest"[^>]*>/gi) || [];
  assert.strictEqual(links.length, 1, `expected one manifest link, found ${links.length}`);
  assert.ok(!/href=/.test(links[0]), `the link must ship href-less, got: ${links[0]}`);

  const head = markup.slice(0, markup.indexOf('</head>'));
  assert.ok(head.indexOf(links[0]) !== -1, 'the manifest link must be in the <head>');
});

s.test('the install affordance is [hidden] in the markup and carries both controls', () => {
  const html = readIndex();
  for (const id of ['install-affordance', 'btn-install', 'btn-install-dismiss']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element id="${id}"`);
  }
  assert.ok(
    /id="install-affordance"[^>]*\shidden>/.test(html),
    'the install affordance MUST start hidden — it is the only guarantee that a browser which ' +
      'never fires beforeinstallprompt shows no install button at all'
  );
  assert.ok(/id="btn-install"[\s\S]{0,240}aria-label=/.test(html), '#btn-install needs an accessible name');
  assert.ok(
    /id="btn-install-dismiss"[\s\S]{0,240}aria-label=/.test(html),
    'the dismiss control needs an accessible name'
  );
  // The rule that makes [hidden] win over the flex container.
  const css = readStyle();
  assert.ok(
    /\.install-affordance\[hidden\]\s*\{\s*display:\s*none;\s*\}/.test(css),
    'display:flex would beat the UA’s [hidden] rule; the override must exist'
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(cssBlock(css, '.install-affordance {').body),
    'the affordance must be token-only, like every other header control'
  );
});

s.test('the storage card states the http(s) install requirement, honestly and permanently', () => {
  const html = readIndex();
  const note = /<p id="install-note"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(note, 'index.html is missing the #install-note');
  assert.ok(!/hidden/.test(note[0]), 'this is a fact about the platform, not a fault condition');

  const text = note[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(/http\(s\)/.test(text), 'the note must name the requirement');
  assert.ok(/file:\/\//.test(text), 'the note must name the case the user is most likely in');
  assert.ok(/service worker/.test(text), 'the second half of the honest answer must be stated too');
  assert.ok(
    /works with no network|works offline/i.test(text),
    'the note must say what still works, or it reads as a defect report'
  );

  // It sits in the Library zone's storage card, beside the persistence note.
  const card = html.slice(html.indexOf('id="history-heading"'), html.indexOf('id="presets-heading"'));
  assert.ok(card.indexOf('id="install-note"') !== -1, 'the note belongs in the storage card');
});

s.test('the share lands through .value / textContent — never innerHTML', () => {
  const source = app.source;
  /* The whole XSS story of this feature in one assertion: index.html has never
   * contained an innerHTML write, and a share is the first thing that puts
   * attacker-controlled text into the DOM. If this ever fails, the payloads in
   * the parse test above stop being harmless characters. */
  assert.ok(
    source.indexOf('innerHTML') === -1,
    'an innerHTML write appeared in #app-main — shared text is attacker-controlled'
  );
  assert.ok(source.indexOf('outerHTML') === -1, 'outerHTML is the same hole with a different name');
  assert.ok(!/insertAdjacentHTML|document\.write/.test(source), 'nor may markup be injected another way');
  // The store is what the shared text is handed to, and it stores strings.
  assert.ok(
    /structure\.setLyrics\(targetId, sharedIntent\.lyrics\)/.test(source),
    'the share must be written through the structure store'
  );
  // The toast host sets textContent, which is where the credit ends up.
  assert.ok(/el\.textContent = text;/.test(source), 'createToastHost must still write text, not markup');
});

s.test('the share is applied AFTER the session restore settles — on both of its paths', () => {
  const source = app.source;

  /* THE ORDERING CONTRACT (FDD #92 against contract F). The autosave restore
   * is asynchronous and restoreWorkspace() replaces the whole song flow, so a
   * share applied earlier would be silently overwritten by the draft the user
   * left behind. Reading is synchronous (the URL is captured before anything
   * can edit it); applying is chained onto the settled restore, with the SAME
   * handler on both the fulfil and the reject path so a database that will not
   * open cannot swallow the user's share. */
  assert.ok(/const sessionRestore = idb\.ready\(\)/.test(source), 'the restore must be a named promise');
  /* CONSCIOUSLY UPDATED IN 0.21.0. The share used to be chained on directly;
   * FDD #75's workspace hash joined the SAME settled chain rather than growing
   * a second one that could race it, so the handler is now applyBootIntents.
   * The contract this test defends is unchanged and is asserted harder below:
   * one chain, both settle paths, and the share still applied LAST. */
  assert.ok(
    /ignoreRejection\(sessionRestore\.then\(applyBootIntents, applyBootIntents\)\);/.test(source),
    'the boot intents must be applied on BOTH settle paths of the session restore'
  );
  const intents = /function applyBootIntents\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(intents, 'applyBootIntents not found');
  assert.ok(
    /applySharedIntent\(\);/.test(intents[1]),
    'the share must still be applied in that chain'
  );
  assert.ok(
    intents[1].indexOf('applyWorkspaceLink();') < intents[1].indexOf('applySharedIntent();'),
    'the share writes one block’s lyrics and must land ON TOP of a workspace link, not under it'
  );
  assert.ok(
    /const sharedIntent = readSharedIntent\(\);/.test(source),
    'the intent must be READ synchronously at boot, before anything can edit the URL'
  );
  // Reading happens before applying, in source order as well as in time.
  assert.ok(
    source.indexOf('const sharedIntent = readSharedIntent();') <
      source.indexOf('ignoreRejection(sessionRestore.then('),
    'the read must precede the apply'
  );

  // The apply repaints explicitly: setLyrics changes no id, and the list only
  // rebuilds when the id order changes.
  const apply = /function applySharedIntent\(\)\s*\{([\s\S]*?)\n    \}/.exec(source);
  assert.ok(apply, 'applySharedIntent not found');
  assert.ok(/renderStructure\(\);/.test(apply[1]), 'without an explicit repaint the textarea shows stale text');
  assert.ok(/asOneStep\(/.test(apply[1]), 'an import is one user action, so it must be one undo step');
  assert.ok(/structure\.addBlock\('Verse'\)/.test(apply[1]), 'an empty flow must get a Verse to land in');
  assert.ok(/clearShareParams\(\)/.test(apply[1]), 'a consumed share must come off the URL');

  // …and the URL is cleaned, or a reload re-imports over the user's edits.
  assert.ok(
    /window\.history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.hash\)/.test(source),
    'the share parameters must be replaced out of the address bar'
  );
});

s.test('the install affordance is un-hidden by the capability and by nothing else', () => {
  const source = app.source;
  const writes = source.match(/installAffordance\.hidden\s*=\s*[^;]+;/g) || [];
  deepEqual(
    writes,
    ['installAffordance.hidden = !availableNow;'],
    'exactly one line may change the affordance’s visibility, and it must read the capability'
  );
  assert.ok(/installCapability\.listen\(\);/.test(source), 'the capability must actually be listening');
  assert.ok(/installCapability\.prompt\(\)/.test(source), 'the button must open the browser’s own dialog');
  assert.ok(/installCapability\.dismiss\(\)/.test(source), 'the dismiss control must be wired');
  // Focus cannot be left on an element that has just been hidden.
  assert.ok(
    /installDismissBtn\.addEventListener\('click', function \(\) \{[\s\S]{0,400}themeBtn\.focus\(\)/.test(source),
    'dismissing must move focus off the control it hides'
  );
});

s.test('updateManifestLink is called from applyThemeState and from nowhere else', () => {
  const source = app.source;
  const calls = source.match(/^\s*updateManifestLink\(/gm) || [];
  assert.strictEqual(
    calls.length,
    1,
    `updateManifestLink is called ${calls.length} times — one hook, or the manifest can drift from the theme`
  );
  const fn = /function applyThemeState\([\s\S]*?\n\}/.exec(source);
  assert.ok(fn, 'applyThemeState not found');
  assert.ok(/updateManifestLink\(doc\);/.test(fn[0]), 'the hook must live in applyThemeState');
  // It must sit AFTER the classes and inline properties are written, or it
  // would read the colour the page is about to stop being painted in.
  assert.ok(
    fn[0].indexOf('meta.setAttribute') < fn[0].indexOf('updateManifestLink(doc)'),
    'the manifest must be rebuilt after the cascade has been updated'
  );
});

/* -------------------------------------------------------------------------- */
/* 12. The scanner amendments, from the feature's side                        */
/* -------------------------------------------------------------------------- */

s.test('the REAL index.html scans clean under the amended URL policy', () => {
  const scan = scanSingleFile(INDEX);
  deepEqual(scan.violations, [], 'the shipping file must have no violations at all');
  assert.strictEqual(scan.manifestLinks.length, 1);
  assert.strictEqual(scan.manifestLinks[0].href, null, 'the shipped link carries no href');
  assert.ok(
    scan.urlLiterals.some((u) => u.namespace && u.url === 'http://www.w3.org/2000/svg'),
    'the icon’s namespace must be recognised as a namespace, not merely tolerated'
  );
});

s.test('NEGATIVE: the real file with a REMOTE manifest href fails the scan', () => {
  /* The amendment is only worth anything if it still bites on the file it
   * governs, so the negative is run against a mutated copy of the REAL
   * index.html rather than a toy fixture. */
  const tmp = path.join(__dirname, '.pwa-scan-tmp.html');
  const cases = [
    ['remote', '<link rel="manifest" href="https://cdn.example.com/manifest.json">', ['manifest-href', 'external-src-or-href']],
    ['relative sibling', '<link rel="manifest" href="manifest.json">', ['manifest-href']],
    ['data URI', '<link rel="manifest" href="data:application/manifest+json,%7B%7D">', []],
  ];
  try {
    for (const [name, replacement, expected] of cases) {
      const mutated = readIndex().replace('<link rel="manifest">', replacement);
      assert.notStrictEqual(mutated, readIndex(), `${name}: the link was not found to mutate`);
      fs.writeFileSync(tmp, mutated, 'utf8');
      const rules = scanSingleFile(tmp).violations.map((v) => v.rule);
      for (const rule of expected) {
        assert.ok(rules.indexOf(rule) !== -1, `${name}: expected rule "${rule}", saw: ${rules.join(', ') || '(none)'}`);
      }
      if (!expected.length) {
        deepEqual(rules, [], `${name}: a data: manifest must still scan clean`);
      }
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

s.test('NEGATIVE: the real file loses its icon namespace allowance if the literal changes', () => {
  const tmp = path.join(__dirname, '.pwa-ns-tmp.html');
  try {
    // One extra path segment and it is an ordinary unregistered URL again.
    const mutated = readIndex().replace(
      'xmlns="http://www.w3.org/2000/svg"',
      'xmlns="http://www.w3.org/2000/svg/v2"'
    );
    assert.notStrictEqual(mutated, readIndex(), 'the icon namespace was not found to mutate');
    fs.writeFileSync(tmp, mutated, 'utf8');
    const hits = scanSingleFile(tmp).violations.filter((v) => v.rule === 'unregistered-url-literal');
    assert.strictEqual(hits.length, 1, 'a near-miss namespace must be flagged like any other stray URL');
    assert.ok(/svg\/v2/.test(hits[0].excerpt), `wrong excerpt: ${hits[0].excerpt}`);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

module.exports = { loadAppSandbox, fakeDoc, fakeWindow, fakeInstallEvent };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
