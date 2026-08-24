'use strict';
/*
 * tests/verify-single-file.js — static integrity scan of index.html.
 *
 * SunoPrompt Studio's core promise is that index.html is a SINGLE, SELF-
 * CONTAINED, ZERO-DEPENDENCY file that runs correctly from a file:// URL with
 * no network at all (docs/ENGINEERING-STANDARD.md, docs/PHP-SQLITE-QUALITY-
 * CHECKLIST.md §1). Any external reference silently breaks that promise —
 * offline users just get a half-rendered app.
 *
 * ---------------------------------------------------------------------------
 * URL POLICY (ASSUMPTIONS.md, "Network-call policy refined")
 *
 * The Tri-Mode AI Dissector must be able to POST to a user's cloud inference
 * endpoint and to a local Ollama server, so "no URLs anywhere" is no longer the
 * right rule. The refined rule separates CODE/ASSET loading from user-initiated
 * DATA calls:
 *
 *   1. RESOURCE-LOADING POSITIONS — src=, href=, srcset, poster, xlink:href,
 *      <base href>, <link rel="stylesheet">, CSS @import, CSS url(),
 *      importScripts(): ZERO absolute or protocol-relative URLs. Unchanged, and
 *      non-negotiable: this is what keeps file:// rendering identical to https.
 *
 *   2. JS STRING LITERALS inside #app-main / #dsp-worker-src may hold an
 *      absolute http(s) URL ONLY IF it is
 *        (a) a loopback host (localhost, 127.0.0.1, [::1], *.localhost) — the
 *            Ollama hook, or
 *        (b) inside the single `var CLOUD_API_PRESETS = { ... }` declaration —
 *            the one registry where remote endpoints are declared.
 *      Every other absolute URL literal FAILS. Endpoints the user types at
 *      runtime are data, never source, so they are unaffected.
 *
 *   3. A hard-coded absolute URL passed straight to fetch/XHR/WebSocket/
 *      sendBeacon still fails unless it is a loopback host: request targets
 *      come from the registry or from the user, never from an inline literal.
 *
 * `scanSingleFile(htmlPath)` is exported so other harnesses (and the negative
 * tests at the bottom of this file) can point it at an arbitrary file.
 * ---------------------------------------------------------------------------
 *
 * Node built-ins only: fs, os, path.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite } = require('./lib/runner.js');
const { listScripts, parseAttributes } = require('./lib/extract.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/** The one declaration allowed to carry remote endpoint literals. */
const PRESET_REGISTRY = 'CLOUD_API_PRESETS';
/** Inline scripts whose string literals are governed by rule 2. */
const GOVERNED_SCRIPT_IDS = ['app-main', 'dsp-worker-src'];
/** Hosts a data call may legitimately hard-code. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'];

/**
 * Strip HTML comments so commented-out examples (and the doc block at the top
 * of index.html) never trigger a false positive.
 * @param {string} html
 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Is this URL pointed at the machine the browser is running on?
 * @param {string} url an absolute http(s) URL
 */
function isLoopbackUrl(url) {
  const m = /^https?:\/\/([^/?#]*)/i.exec(String(url));
  if (!m) return false;
  let host = m[1].toLowerCase();
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  // Strip a trailing :port, but not the colons inside a bracketed IPv6 literal.
  if (host.charAt(0) !== '[') host = host.split(':')[0];
  else host = host.slice(0, host.indexOf(']') + 1) || host;
  if (LOOPBACK_HOSTS.indexOf(host) !== -1) return true;
  return /\.localhost$/.test(host);
}

/**
 * Lex JavaScript far enough to know which byte ranges are string literals,
 * comments and regular-expression literals.
 *
 * The regex-literal handling is not optional: #app-main contains
 * /```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/g — a regex holding THREE backticks. A naive
 * scanner would read the first of them as the start of a template literal and
 * mis-classify the rest of the file. `/` is read as a regex only when the
 * previous significant character cannot end an expression.
 *
 * @param {string} source
 * @returns {{strings: Array<{start:number, end:number, value:string, quote:string}>,
 *            skips: Array<{start:number, end:number, kind:string}>}}
 */
function lexJs(source) {
  const strings = [];
  const skips = [];
  const n = source.length;
  let i = 0;
  let prev = '';

  while (i < n) {
    const ch = source.charAt(i);

    if (ch === '/' && source.charAt(i + 1) === '/') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      skips.push({ start: i, end: end, kind: 'line-comment' });
      i = end;
      continue;
    }
    if (ch === '/' && source.charAt(i + 1) === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      skips.push({ start: i, end: end, kind: 'block-comment' });
      i = end;
      continue;
    }
    if (ch === '/' && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      let escaped = false;
      let closed = false;
      while (j < n) {
        const c = source.charAt(j);
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '\n') break;
        else if (c === '/' && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        skips.push({ start: i, end: j, kind: 'regex' });
        i = j;
        prev = '/';
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      let escaped = false;
      let closed = false;
      while (j < n) {
        const c = source.charAt(j);
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === ch) {
          closed = true;
          break;
        } else if (c === '\n' && ch !== '`') break;
        j += 1;
      }
      if (closed) {
        strings.push({ start: i, end: j + 1, value: source.slice(i + 1, j), quote: ch });
        i = j + 1;
        prev = ch;
        continue;
      }
    }

    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }

  return { strings: strings, skips: skips };
}

/**
 * Byte span of a `var NAME = { ... };` declaration, brace-matched while
 * ignoring braces that live inside strings, comments or regex literals.
 *
 * @param {string} source
 * @param {string} name
 * @param {{strings:Array, skips:Array}} lex
 * @returns {{start:number, end:number}|null}
 */
function findDeclarationSpan(source, name, lex) {
  const re = new RegExp('\\bvar\\s+' + name + '\\s*=\\s*\\{');
  const m = re.exec(source);
  if (!m) return null;

  const ranges = lex.strings.concat(lex.skips).sort((a, b) => a.start - b.start);
  const inRange = (index) => {
    for (let r = 0; r < ranges.length; r += 1) {
      if (ranges[r].start > index) return false;
      if (index < ranges[r].end) return true;
    }
    return false;
  };

  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (inRange(i)) continue;
    const ch = source.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: m.index, end: i + 1 };
    }
  }
  return null;
}

/**
 * Every absolute http(s) URL that appears inside a JS string literal, tagged
 * with whether the policy allows it and why.
 *
 * @param {string} source one inline script's JavaScript
 * @returns {Array<{url:string, index:number, loopback:boolean, inRegistry:boolean}>}
 */
function listUrlLiterals(source) {
  const lex = lexJs(source);
  const span = findDeclarationSpan(source, PRESET_REGISTRY, lex);
  const out = [];
  for (let s = 0; s < lex.strings.length; s += 1) {
    const literal = lex.strings[s];
    const re = /https?:\/\/[^\s'"`\\)]+/gi;
    let m;
    while ((m = re.exec(literal.value)) !== null) {
      out.push({
        url: m[0],
        index: literal.start,
        loopback: isLoopbackUrl(m[0]),
        inRegistry: !!span && literal.start >= span.start && literal.end <= span.end,
      });
    }
  }
  return out;
}

/**
 * Scan an HTML file for anything that would make it depend on the network or
 * on a sibling file, applying the URL POLICY documented at the top.
 *
 * @param {string} htmlPath
 * @returns {{
 *   path: string, exists: boolean, bytes: number, hasDoctype: boolean,
 *   scriptIds: string[], workerScriptType: string|null,
 *   registryScriptIds: string[], urlLiterals: Array<object>,
 *   violations: Array<{rule: string, line: number, excerpt: string}>
 * }}
 */
function scanSingleFile(htmlPath) {
  const resolved = path.resolve(htmlPath);
  const report = {
    path: resolved,
    exists: fs.existsSync(resolved),
    bytes: 0,
    hasDoctype: false,
    scriptIds: [],
    workerScriptType: null,
    registryScriptIds: [],
    urlLiterals: [],
    violations: [],
  };
  if (!report.exists) return report;

  const raw = fs.readFileSync(resolved, 'utf8');
  report.bytes = Buffer.byteLength(raw, 'utf8');
  report.hasDoctype = /^﻿?\s*<!DOCTYPE\s+html\s*>/i.test(raw);

  const scripts = listScripts(raw);
  report.scriptIds = scripts.map((s) => s.attrs.id).filter(Boolean);
  const worker = scripts.find((s) => s.attrs.id === 'dsp-worker-src');
  report.workerScriptType = worker ? worker.attrs.type || '' : null;

  const html = stripComments(raw);

  // Map an index in the comment-stripped text back to a line number in `raw`
  // by matching on the excerpt — good enough for reporting, and never wrong in
  // a way that hides a violation.
  const lineOf = (excerpt) => {
    const idx = raw.indexOf(excerpt);
    if (idx === -1) return 0;
    return raw.slice(0, idx).split(/\r\n|\r|\n/).length;
  };

  const add = (rule, excerpt) => {
    report.violations.push({ rule, line: lineOf(excerpt), excerpt: excerpt.slice(0, 160) });
  };

  const RULES = [
    // src= / href= pointing at an absolute or protocol-relative URL.
    {
      rule: 'external-src-or-href',
      re: /\b(?:src|href|data-src|srcset|poster|xlink:href)\s*=\s*(?:"|')\s*(?:https?:)?\/\/[^"']*/gi,
    },
    // CSS @import of a remote URL.
    { rule: 'css-import-url', re: /@import\s+(?:url\(\s*)?(?:"|'|)(?:https?:)?\/\//gi },
    // CSS url() pointing off-box (fonts, background images, cursors).
    { rule: 'css-remote-url', re: /\burl\(\s*(?:"|'|)\s*(?:https?:)?\/\//gi },
    // Worker importScripts() with a URL literal.
    { rule: 'importscripts-url', re: /importScripts\s*\(\s*(?:"|'|`)[^"'`)]*:?\/\//gi },
    // <base href> would repoint every relative URL.
    { rule: 'base-href', re: /<base\b(?:[^>"']|"[^"]*"|'[^']*')*href/gi },
  ];

  for (const { rule, re } of RULES) {
    let m;
    while ((m = re.exec(html)) !== null) add(rule, m[0]);
  }

  // A hard-coded absolute URL handed straight to a network API. Loopback is
  // exempt (rule 3): everything else must come from the registry or the user.
  const fetchRe =
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(\s*(?:"|'|`)\s*((?:https?:)?\/\/[^"'`]*)/gi;
  let fm;
  while ((fm = fetchRe.exec(html)) !== null) {
    if (isLoopbackUrl(fm[1])) continue;
    add('network-fetch-url', fm[0]);
  }

  // <link rel="stylesheet"> of ANY kind — even a relative sibling .css file
  // breaks single-file distribution. Parsed structurally rather than by regex
  // so quoted attribute values can never confuse the match.
  const linkRe = /<link\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const attrs = parseAttributes(lm[1]);
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet')) add('link-stylesheet', lm[0]);
  }

  // Rule 2 — absolute URL literals inside the governed inline scripts.
  for (const script of scripts) {
    const id = script.attrs.id;
    if (!id || GOVERNED_SCRIPT_IDS.indexOf(id) === -1) continue;
    if (findDeclarationSpan(script.source, PRESET_REGISTRY, lexJs(script.source))) {
      report.registryScriptIds.push(id);
    }
    for (const hit of listUrlLiterals(script.source)) {
      report.urlLiterals.push({
        script: id,
        url: hit.url,
        loopback: hit.loopback,
        inRegistry: hit.inRegistry,
      });
      if (hit.loopback || hit.inRegistry) continue;
      add('unregistered-url-literal', `${id}: ${hit.url}`);
    }
  }

  return report;
}

function describe(violations) {
  return violations.map((v) => `  [${v.rule}] line ${v.line}: ${v.excerpt}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Negative-test scaffolding — scratch copies in the OS temp dir              */
/* -------------------------------------------------------------------------- */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-verify-'));
const scratchFiles = [];

/** Write an HTML fixture and return its path. */
function scratch(name, html) {
  const file = path.join(SCRATCH, name);
  fs.writeFileSync(file, html, 'utf8');
  scratchFiles.push(file);
  return file;
}

/** Minimal but structurally valid single-file app, with an injected body. */
function fixture(appMainBody) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8"><title>fixture</title>',
    '<style>body { background: #0A0A0C; }</style></head><body>',
    '<script id="dsp-worker-src" type="text/js-worker">',
    "'use strict';",
    'self.onmessage = function () {};',
    '</' + 'script>',
    '<script id="app-main">',
    "'use strict';",
    appMainBody,
    '</' + 'script>',
    '</body></html>',
  ].join('\n');
}

const REGISTRY_FIXTURE = [
  'var CLOUD_API_PRESETS = {',
  "  groq: { id: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },",
  "  gemini: { id: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent' }",
  '};',
  "var OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';",
  "var LOOPBACK_ALT = 'http://127.0.0.1:11434/api/tags';",
].join('\n');

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

const s = suite('verify-single-file (index.html static integrity)');
const scan = scanSingleFile(INDEX);

s.test('index.html exists', () => {
  if (!scan.exists) throw new Error(`missing file: ${scan.path}`);
});

s.test('index.html is non-empty', () => {
  if (scan.bytes <= 0) throw new Error('index.html is zero bytes');
  if (scan.bytes < 200) throw new Error(`index.html is suspiciously small: ${scan.bytes} bytes`);
});

s.test('starts with <!DOCTYPE html>', () => {
  if (!scan.hasDoctype) throw new Error('no leading <!DOCTYPE html> declaration');
});

s.test('the bundle is plain text — no raw control bytes anywhere', () => {
  /*
   * A raw C0 control byte (a NUL smuggled in by an editor or a generation
   * step, most often) makes index.html "binary" to grep, diff and every other
   * text tool — and the HTML tokenizer silently rewrites U+0000 to U+FFFD, so
   * a string literal holding one means something DIFFERENT in the browser
   * than it does on disk. Control characters that are genuinely wanted inside
   * a JS string belong there as an escape sequence ('\u0000'), which is plain
   * ASCII in the file. Tab, LF and CR are the only bytes below 0x20 a source
   * file has any business containing.
   */
  const buf = fs.readFileSync(INDEX);
  const bad = [];
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    const control = (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f;
    if (!control) continue;
    const line = buf.slice(0, i).toString('utf8').split('\n').length;
    bad.push(`  line ${line}: byte 0x${byte.toString(16).padStart(2, '0')} at offset ${i}`);
    if (bad.length >= 10) break;
  }
  if (bad.length) throw new Error(`${bad.length} raw control byte(s):\n${bad.join('\n')}`);
});

s.test('contains inline script #dsp-worker-src', () => {
  if (!scan.scriptIds.includes('dsp-worker-src')) {
    throw new Error(`no <script id="dsp-worker-src">; ids present: ${scan.scriptIds.join(', ') || '(none)'}`);
  }
});

s.test('#dsp-worker-src has type="text/js-worker"', () => {
  if (scan.workerScriptType !== 'text/js-worker') {
    throw new Error(`expected type="text/js-worker", got "${scan.workerScriptType}"`);
  }
});

s.test('contains inline script #app-main', () => {
  if (!scan.scriptIds.includes('app-main')) {
    throw new Error(`no <script id="app-main">; ids present: ${scan.scriptIds.join(', ') || '(none)'}`);
  }
});

s.test('zero external src=/href= references (http, https, protocol-relative)', () => {
  const hits = scan.violations.filter((v) => v.rule === 'external-src-or-href' || v.rule === 'base-href');
  if (hits.length) throw new Error(`${hits.length} external reference(s):\n${describe(hits)}`);
});

s.test('no <link rel="stylesheet"> of any kind', () => {
  const hits = scan.violations.filter((v) => v.rule === 'link-stylesheet');
  if (hits.length) throw new Error(`${hits.length} stylesheet link(s):\n${describe(hits)}`);
});

s.test('no CSS @import or url() pointing at a remote asset', () => {
  const hits = scan.violations.filter((v) => v.rule === 'css-import-url' || v.rule === 'css-remote-url');
  if (hits.length) throw new Error(`${hits.length} remote CSS reference(s):\n${describe(hits)}`);
});

s.test('no importScripts() with a URL literal', () => {
  const hits = scan.violations.filter((v) => v.rule === 'importscripts-url');
  if (hits.length) throw new Error(`${hits.length} remote importScripts():\n${describe(hits)}`);
});

s.test('no hard-coded absolute URL passed to fetch/XHR/WebSocket/beacon (loopback excepted)', () => {
  const hits = scan.violations.filter((v) => v.rule === 'network-fetch-url');
  if (hits.length) throw new Error(`${hits.length} network call(s):\n${describe(hits)}`);
});

s.test(`every absolute URL literal is loopback or inside var ${PRESET_REGISTRY}`, () => {
  const hits = scan.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length) {
    throw new Error(
      `${hits.length} unregistered URL literal(s) — move the endpoint into ${PRESET_REGISTRY}:\n${describe(hits)}`
    );
  }
});

s.test(`var ${PRESET_REGISTRY} exists in #app-main and owns the remote endpoints`, () => {
  if (!scan.registryScriptIds.includes('app-main')) {
    throw new Error(
      `no \`var ${PRESET_REGISTRY} = { ... }\` declaration found in #app-main — the URL policy has nowhere to allow-list`
    );
  }
  const remote = scan.urlLiterals.filter((u) => !u.loopback);
  if (!remote.length) throw new Error('the preset registry declares no remote endpoint at all');
  const stray = remote.filter((u) => !u.inRegistry);
  if (stray.length) {
    throw new Error(`remote endpoint(s) declared outside the registry: ${stray.map((u) => u.url).join(', ')}`);
  }
});

s.test('the Ollama hook targets loopback only', () => {
  const loopback = scan.urlLiterals.filter((u) => u.loopback);
  if (!loopback.length) throw new Error('no loopback URL literal found — the Ollama hook is missing');
  const bad = loopback.filter((u) => !/^http:\/\/(?:localhost|127\.0\.0\.1)/i.test(u.url));
  if (bad.length) throw new Error(`unexpected loopback form: ${bad.map((u) => u.url).join(', ')}`);
});

s.test('safe to run from file:// (no violations at all)', () => {
  if (scan.violations.length) {
    throw new Error(`${scan.violations.length} total violation(s):\n${describe(scan.violations)}`);
  }
});

/* --- negative tests: the scanner must actually catch things ---------------- */

s.test('NEGATIVE: registry endpoints + loopback URLs scan clean', () => {
  const file = scratch('clean.html', fixture(REGISTRY_FIXTURE));
  const r = scanSingleFile(file);
  if (r.violations.length) {
    throw new Error(`expected a clean scan, got:\n${describe(r.violations)}`);
  }
  if (r.urlLiterals.length !== 4) {
    throw new Error(`expected 4 URL literals, saw ${r.urlLiterals.length}`);
  }
  if (!r.registryScriptIds.includes('app-main')) throw new Error('registry span was not located');
});

s.test('NEGATIVE: an absolute URL literal outside the registry is flagged', () => {
  const file = scratch(
    'stray.html',
    fixture(REGISTRY_FIXTURE + "\nvar SNEAKY = 'https://evil.example.com/collect';")
  );
  const r = scanSingleFile(file);
  const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 unregistered-url-literal, got ${hits.length}:\n${describe(r.violations)}`);
  }
  if (!/evil\.example\.com/.test(hits[0].excerpt)) {
    throw new Error(`wrong excerpt: ${hits[0].excerpt}`);
  }
});

s.test('NEGATIVE: a URL literal in the worker script is flagged too', () => {
  const html = fixture(REGISTRY_FIXTURE).replace(
    'self.onmessage = function () {};',
    "self.onmessage = function () {};\nvar CDN = 'https://cdn.example.com/model.bin';"
  );
  const r = scanSingleFile(scratch('worker-url.html', html));
  const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length !== 1 || hits[0].excerpt.indexOf('dsp-worker-src') !== 0) {
    throw new Error(`expected 1 worker-scoped violation, got:\n${describe(r.violations)}`);
  }
});

s.test('NEGATIVE: deleting the registry turns its own endpoints into violations', () => {
  const body = REGISTRY_FIXTURE.replace('var CLOUD_API_PRESETS', 'var SOME_OTHER_NAME');
  const r = scanSingleFile(scratch('no-registry.html', fixture(body)));
  const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length !== 2) {
    throw new Error(`expected both remote endpoints flagged, got ${hits.length}:\n${describe(r.violations)}`);
  }
  if (r.registryScriptIds.length) throw new Error('registry should not have been located');
});

s.test('NEGATIVE: a remote <script src>, stylesheet link and CSS url() are still flagged', () => {
  const html = fixture(REGISTRY_FIXTURE)
    .replace('<style>body { background: #0A0A0C; }</style>', '<style>@font-face { src: url(https://fonts.example.com/a.woff2); }</style>')
    .replace('<body>', '<body><script src="https://cdn.example.com/lib.js"></' + 'script><link rel="stylesheet" href="theme.css">');
  const r = scanSingleFile(scratch('external.html', html));
  const rules = r.violations.map((v) => v.rule);
  for (const expected of ['external-src-or-href', 'link-stylesheet', 'css-remote-url']) {
    if (rules.indexOf(expected) === -1) {
      throw new Error(`rule "${expected}" did not fire; saw: ${rules.join(', ') || '(none)'}`);
    }
  }
});

s.test('NEGATIVE: fetch() to a hard-coded remote URL is flagged, loopback is not', () => {
  const body =
    REGISTRY_FIXTURE +
    "\nfunction a() { return fetch('http://localhost:11434/api/tags'); }" +
    "\nfunction b() { return fetch('https://api.example.com/v1/steal'); }";
  const r = scanSingleFile(scratch('fetches.html', fixture(body)));
  const hits = r.violations.filter((v) => v.rule === 'network-fetch-url');
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 network-fetch-url, got ${hits.length}:\n${describe(r.violations)}`);
  }
  if (hits[0].excerpt.indexOf('api.example.com') === -1) throw new Error(`wrong hit: ${hits[0].excerpt}`);
});

s.test('lexer: a regex literal holding backticks does not desync literal scanning', () => {
  const src = [
    "var fence = /```[a-zA-Z0-9_+-]*[ \\t]*\\r?\\n?/g;",
    "var kept = 'http://localhost:11434/api/generate';",
    "var quoted = /['\"]/g;",
    "var stray = 'https://desync.example.com/x';",
  ].join('\n');
  const found = listUrlLiterals(src).map((u) => u.url);
  if (found.length !== 2) throw new Error(`expected 2 URL literals, got ${found.length}: ${found.join(', ')}`);
  if (found[0].indexOf('localhost') === -1 || found[1].indexOf('desync') === -1) {
    throw new Error(`lexer desynced: ${found.join(', ')}`);
  }
});

s.test('scratch fixtures are cleaned up', () => {
  for (const file of scratchFiles) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  if (fs.existsSync(SCRATCH)) throw new Error(`scratch dir survived: ${SCRATCH}`);
});

module.exports = {
  scanSingleFile,
  stripComments,
  lexJs,
  findDeclarationSpan,
  listUrlLiterals,
  isLoopbackUrl,
  PRESET_REGISTRY,
};

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
