'use strict';
/*
 * tests/verify-single-file.js — static integrity scan of index.html.
 *
 * SunoPrompt Studio's core promise used to be stated as "nothing ever loads
 * from the network". Since the Local-LLM Mode 1 upgrade (ASSUMPTIONS.md,
 * 2026-08-25) the promise is stated in three clauses, and this file is what
 * holds each of them to account:
 *
 *     ONE FILE. NOTHING LOADS UNTIL THE USER ASKS.
 *     CODE FETCHED AT RUNTIME IS HASH-PINNED.
 *
 * index.html is still a SINGLE, SELF-CONTAINED, ZERO-DEPENDENCY file that
 * renders and runs correctly from a file:// URL with no network at all
 * (docs/ENGINEERING-STANDARD.md, docs/PHP-SQLITE-QUALITY-CHECKLIST.md §1). What
 * changed is that a user may now *opt in*, with an explicit click, to
 * downloading an on-device model — its weights AND the inference runtime that
 * executes them. That download is code, so it is pinned by SHA-256.
 *
 * ---------------------------------------------------------------------------
 * URL POLICY v2
 *
 *   1. RESOURCE-LOADING POSITIONS — src=, href=, srcset, poster, xlink:href,
 *      <base href>, <link rel="stylesheet">, CSS @import, CSS url(),
 *      importScripts(): ZERO absolute or protocol-relative URLs. Unchanged, and
 *      non-negotiable: this is what keeps file:// rendering identical to https,
 *      and it is the clause that means nothing loads AT BOOT.
 *
 *   2. JS STRING LITERALS inside the governed inline scripts may hold an
 *      absolute http(s) URL ONLY IF it is
 *        (a) a loopback host (localhost, 127.0.0.1, [::1], *.localhost) — the
 *            Ollama hook, or
 *        (b) inside one of the ALLOWED_URL_REGISTRIES declarations:
 *              var CLOUD_API_PRESETS  — user-initiated inference endpoints
 *              var LOCAL_MODEL_SOURCES — opt-in on-device model assets
 *      Every other absolute URL literal FAILS. Endpoints the user types at
 *      runtime are data, never source, so they are unaffected.
 *
 *   3. A hard-coded absolute URL passed straight to fetch/XHR/WebSocket/
 *      sendBeacon still fails unless it is a loopback host: request targets are
 *      resolved out of a registry or typed by the user, never inlined at a call
 *      site — not even a registry literal, which would put a request target
 *      somewhere the registry cannot govern it.
 *
 *   4. WORKER URLS — `new Worker(...)` / `new SharedWorker(...)` may never take
 *      an absolute or protocol-relative URL literal, loopback included. A
 *      remote worker is third-party code executing at spawn time with no
 *      consent gate and no hash check in front of it; every worker in this app
 *      is spawned from an inline <script> block through a Blob URL.
 *
 *   5. PINNED CODE — every LOCAL_MODEL_SOURCES entry declaring `kind: 'code'`
 *      must carry a non-empty `integrity: 'sha256-…'` literal in the same
 *      entry. Weights are data and are merely large; the runtime is code, and
 *      code fetched at runtime is only as trustworthy as the digest in front
 *      of it.
 *
 * ---------------------------------------------------------------------------
 * URL POLICY v3 — two rules added CONSCIOUSLY for the inline PWA manifest
 * (FDD #89/#92, APP_VERSION 0.19.0). Both NARROW the file rather than widen
 * it: rule 6 catches a class of single-file breakage rule 1 never could, and
 * rule 7 is an exact-match allowance for two strings that are names rather
 * than addresses.
 *
 *   6. INLINE MANIFEST — a <link rel="manifest"> may carry NO href at all (the
 *      boot script fills one in) or a `data:` URI, and nothing else.
 *      A remote manifest is a network dependency at boot, which rule 1 already
 *      catches. A RELATIVE one — href="manifest.json" — is a SECOND FILE, and
 *      rule 1 does NOT catch it, because rule 1 only ever looked for absolute
 *      URLs. Shipping index.html to somebody who does not also get
 *      manifest.json is exactly the failure the single-file promise exists to
 *      prevent, so it gets a rule of its own.
 *
 *   7. XML NAMESPACE IDENTIFIERS — the exact literals
 *      'http://www.w3.org/2000/svg' and 'http://www.w3.org/1999/xlink' are
 *      allowed as string literals anywhere rule 2 governs. An XML namespace is
 *      a NAME, not an address: no engine has ever fetched one, and a
 *      standalone SVG document (the manifest's inline icon) does not parse
 *      without the first of them. The allowance is EXACT-MATCH — one extra
 *      path segment and it is an ordinary unregistered URL again — and it does
 *      NOT extend to rule 3: handing a namespace to fetch() is still a network
 *      call and still fails.
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
const { listScripts, parseAttributes, stripScriptBodies } = require('./lib/extract.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/**
 * The declarations allowed to carry remote URL literals (rule 2b).
 *   CLOUD_API_PRESETS  — inference endpoints the user POSTs to on demand.
 *   LOCAL_MODEL_SOURCES — the runtime/wasm/weights a user may opt into.
 * Two registries rather than one because they answer to different rules:
 * everything in the second one is subject to rule 5 as well.
 */
const ALLOWED_URL_REGISTRIES = ['CLOUD_API_PRESETS', 'LOCAL_MODEL_SOURCES'];
/** The registry rule 5 governs. */
const MODEL_REGISTRY = 'LOCAL_MODEL_SOURCES';
/** Kept as the name of the endpoint registry for the messages that cite it. */
const PRESET_REGISTRY = 'CLOUD_API_PRESETS';
/** Inline scripts whose string literals are governed by rule 2. */
const GOVERNED_SCRIPT_IDS = ['app-main', 'dsp-worker-src', 'ai-worker-src'];
/** Hosts a data call may legitimately hard-code. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'];
/**
 * Rule 7. XML namespace NAMES, matched exactly and never by prefix. These two
 * identify a vocabulary; nothing dereferences them. The SVG one is required by
 * any standalone SVG document, which is what the PWA icon is.
 */
const XML_NAMESPACE_URIS = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];

/**
 * Strip HTML comments so commented-out examples (and the doc block at the top
 * of index.html) never trigger a false positive.
 * @param {string} html
 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/*
 * stripScriptBodies() comes from tests/lib/extract.js. The structural <link>
 * walk below reads MARKUP, and the inside of a script element is not markup:
 * #app-main's own documentation quotes the tag `<link rel="manifest">` three
 * times while explaining the inline manifest, and a prose mention is not a
 * fourth link element in the document. Only the rules that genuinely mean
 * "anywhere in the file" (rule 1's src/href scan, the fetch scan, the
 * string-literal rules) keep seeing script bodies.
 */

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
 * Rule 7. Is this literal one of the two XML namespace names, EXACTLY?
 * Exact-match on purpose: 'http://www.w3.org/2000/svg/steal.js' is a URL that
 * merely starts like a namespace, and it must still fail.
 *
 * @param {string} url
 */
function isXmlNamespaceUri(url) {
  return XML_NAMESPACE_URIS.indexOf(String(url)) !== -1;
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
 * Brace-matched spans for every allow-listed registry that this source
 * declares, newest policy: a literal inside ANY of them satisfies rule 2b.
 *
 * @param {string} source
 * @param {{strings:Array, skips:Array}} lex
 * @returns {Array<{name:string, start:number, end:number}>}
 */
function findRegistrySpans(source, lex) {
  const out = [];
  for (const name of ALLOWED_URL_REGISTRIES) {
    const span = findDeclarationSpan(source, name, lex);
    if (span) out.push({ name, start: span.start, end: span.end });
  }
  return out;
}

/**
 * Every absolute http(s) URL that appears inside a JS string literal, tagged
 * with whether the policy allows it and why.
 *
 * @param {string} source one inline script's JavaScript
 * @returns {Array<{url:string, index:number, loopback:boolean, inRegistry:boolean,
 *                  registry:string|null, namespace:boolean}>}
 */
function listUrlLiterals(source) {
  const lex = lexJs(source);
  const spans = findRegistrySpans(source, lex);
  const out = [];
  for (let s = 0; s < lex.strings.length; s += 1) {
    const literal = lex.strings[s];
    const re = /https?:\/\/[^\s'"`\\)]+/gi;
    let m;
    while ((m = re.exec(literal.value)) !== null) {
      const home = spans.find((span) => literal.start >= span.start && literal.end <= span.end);
      out.push({
        url: m[0],
        index: literal.start,
        loopback: isLoopbackUrl(m[0]),
        inRegistry: !!home,
        registry: home ? home.name : null,
        namespace: isXmlNamespaceUri(m[0]),
      });
    }
  }
  return out;
}

/**
 * The `{ … }` object literal that directly encloses `index`, brace-matched in
 * both directions while ignoring strings, comments and regex literals.
 *
 * @param {string} source
 * @param {number} index a position known to sit inside an object literal
 * @param {{strings:Array, skips:Array}} lex
 * @returns {{start:number, end:number}|null}
 */
function enclosingObject(source, index, lex) {
  const ranges = lex.strings.concat(lex.skips).sort((a, b) => a.start - b.start);
  const inRange = (at) => {
    for (let r = 0; r < ranges.length; r += 1) {
      if (ranges[r].start > at) return false;
      if (at < ranges[r].end) return true;
    }
    return false;
  };

  let depth = 0;
  let open = -1;
  for (let i = index; i >= 0; i -= 1) {
    if (inRange(i)) continue;
    const ch = source.charAt(i);
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }
  if (open === -1) return null;

  depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (inRange(i)) continue;
    const ch = source.charAt(i);
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return null;
}

/**
 * Rule 5. Every `kind: 'code'` entry inside LOCAL_MODEL_SOURCES must declare a
 * non-empty `integrity: 'sha256-…'` literal in the same object.
 *
 * @param {string} source one inline script's JavaScript
 * @returns {Array<{excerpt:string, reason:string}>} one entry per violation
 */
function listUnpinnedCodeSources(source) {
  const lex = lexJs(source);
  const span = findDeclarationSpan(source, MODEL_REGISTRY, lex);
  if (!span) return [];
  const body = source.slice(span.start, span.end);
  const out = [];
  const kindRe = /\bkind\s*:\s*(['"`])code\1/g;
  let m;
  while ((m = kindRe.exec(body)) !== null) {
    const at = span.start + m.index;
    const entry = enclosingObject(source, at, lex);
    const text = entry ? source.slice(entry.start, entry.end) : '';
    const pinned = /\bintegrity\s*:\s*(['"`])sha256-[A-Za-z0-9+/=_-]+\1/.exec(text);
    if (pinned) continue;
    // Name the entry if we can, so the failure says WHICH source is unpinned.
    const label = /(['"]?)([A-Za-z0-9_$]+)\1\s*:\s*\{[^{]*$/.exec(
      source.slice(span.start, entry ? entry.start + 1 : at)
    );
    out.push({
      excerpt: `${MODEL_REGISTRY}.${label ? label[2] : '(unnamed)'} kind:'code'`,
      reason: /\bintegrity\s*:/.test(text)
        ? 'integrity is present but is not a non-empty sha256- literal'
        : 'no integrity literal at all',
    });
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
 *   registryScriptIds: string[], modelRegistryScriptIds: string[],
 *   registriesFound: string[], urlLiterals: Array<object>,
 *   manifestLinks: Array<{href: string|null}>,
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
    modelRegistryScriptIds: [],
    registriesFound: [],
    urlLiterals: [],
    manifestLinks: [],
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

  // Rule 4 — a worker spawned straight off a URL literal. Loopback is NOT
  // exempt here: unlike a data POST, this executes whatever comes back.
  const workerRe = /\bnew\s+(?:Shared)?Worker\s*\(\s*(?:"|'|`)\s*((?:https?:)?\/\/[^"'`]*)/gi;
  let wm;
  while ((wm = workerRe.exec(html)) !== null) add('worker-url', wm[0]);

  // <link rel="stylesheet"> of ANY kind — even a relative sibling .css file
  // breaks single-file distribution. Parsed structurally rather than by regex
  // so quoted attribute values can never confuse the match.
  //
  // Rule 6 rides along in the same walk: <link rel="manifest"> may have no
  // href (the boot script writes a data: one) or a data: href, and nothing
  // else. A RELATIVE manifest href is the case rule 1 cannot see — it is not
  // an absolute URL, it is a second file.
  const markup = stripScriptBodies(html);
  const linkRe = /<link\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;
  let lm;
  while ((lm = linkRe.exec(markup)) !== null) {
    const attrs = parseAttributes(lm[1]);
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet')) add('link-stylesheet', lm[0]);
    if (rel.includes('manifest')) {
      report.manifestLinks.push({ href: attrs.href === undefined ? null : String(attrs.href) });
      const href = attrs.href === undefined ? '' : String(attrs.href).trim();
      if (href && !/^data:/i.test(href)) add('manifest-href', lm[0]);
    }
  }

  // Rules 2 and 5 — string literals inside the governed inline scripts.
  for (const script of scripts) {
    const id = script.attrs.id;
    if (!id || GOVERNED_SCRIPT_IDS.indexOf(id) === -1) continue;
    const spans = findRegistrySpans(script.source, lexJs(script.source));
    for (const span of spans) {
      if (report.registriesFound.indexOf(span.name) === -1) report.registriesFound.push(span.name);
      if (span.name === PRESET_REGISTRY && report.registryScriptIds.indexOf(id) === -1) {
        report.registryScriptIds.push(id);
      }
      if (span.name === MODEL_REGISTRY && report.modelRegistryScriptIds.indexOf(id) === -1) {
        report.modelRegistryScriptIds.push(id);
      }
    }
    for (const hit of listUrlLiterals(script.source)) {
      report.urlLiterals.push({
        script: id,
        url: hit.url,
        loopback: hit.loopback,
        inRegistry: hit.inRegistry,
        registry: hit.registry,
        namespace: hit.namespace,
      });
      if (hit.loopback || hit.inRegistry || hit.namespace) continue;
      add('unregistered-url-literal', `${id}: ${hit.url}`);
    }
    for (const unpinned of listUnpinnedCodeSources(script.source)) {
      add('unpinned-code-source', `${id}: ${unpinned.excerpt} — ${unpinned.reason}`);
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

/*
 * Created on FIRST USE, not at import time. tests/pwa.test.js requires this
 * module for scanSingleFile(), and a module that mkdtemps on import would
 * leave an empty directory behind on every run of a suite that never writes a
 * fixture.
 */
let SCRATCH = null;
const scratchFiles = [];

function scratchDir() {
  if (SCRATCH === null) SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-verify-'));
  return SCRATCH;
}

/** Write an HTML fixture and return its path. */
function scratch(name, html) {
  const file = path.join(scratchDir(), name);
  fs.writeFileSync(file, html, 'utf8');
  scratchFiles.push(file);
  return file;
}

/**
 * Minimal but structurally valid single-file app, with an injected body and
 * (since rule 6) an optional extra chunk of <head>.
 */
function fixture(appMainBody, headExtra) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8"><title>fixture</title>',
    '<style>body { background: #0A0A0C; }</style>',
    headExtra || '',
    '</head><body>',
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
  "  openrouter: { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },",
  "  custom: { id: 'custom', endpoint: '', suggestions: [{ label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }] }",
  '};',
  "var OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';",
  "var LOOPBACK_ALT = 'http://127.0.0.1:11434/api/tags';",
].join('\n');

/** A LOCAL_MODEL_SOURCES registry whose one code entry IS pinned (rule 5). */
const MODEL_FIXTURE = [
  'var LOCAL_MODEL_SOURCES = {',
  "  runtime: { kind: 'code', url: 'https://cdn.example.com/dist/runtime.min.js',",
  "    integrity: 'sha256-qlACtw54l5jaJj9fmcYr0+j80MEZJYpJPEDBgGSDZfo=', bytes: 888173 },",
  "  wasm: { kind: 'binary', baseUrl: 'https://cdn.example.com/dist/' },",
  "  weights: { kind: 'weights', host: 'https://models.example.com/' }",
  '};',
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

s.test(`every absolute URL literal is loopback or inside ${ALLOWED_URL_REGISTRIES.join(' / ')}`, () => {
  const hits = scan.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length) {
    throw new Error(
      `${hits.length} unregistered URL literal(s) — move the URL into ${ALLOWED_URL_REGISTRIES.join(
        ' or '
      )}:\n${describe(hits)}`
    );
  }
});

s.test(`var ${PRESET_REGISTRY} exists in #app-main and owns the remote endpoints`, () => {
  if (!scan.registryScriptIds.includes('app-main')) {
    throw new Error(
      `no \`var ${PRESET_REGISTRY} = { ... }\` declaration found in #app-main — the URL policy has nowhere to allow-list`
    );
  }
  // CONSCIOUSLY AMENDED IN 0.19.0 (rule 7): XML namespace names are excluded
  // here for the same reason they are excluded from the violation list — they
  // are not endpoints, so demanding a registry own them would be demanding
  // that the SVG icon's `xmlns` be declared as an inference endpoint.
  const remote = scan.urlLiterals.filter((u) => !u.loopback && !u.namespace);
  if (!remote.length) throw new Error('the preset registry declares no remote endpoint at all');
  const stray = remote.filter((u) => !u.inRegistry);
  if (stray.length) {
    throw new Error(`remote endpoint(s) declared outside the registry: ${stray.map((u) => u.url).join(', ')}`);
  }
});

s.test(`var ${MODEL_REGISTRY} exists in #app-main and owns every model asset URL`, () => {
  if (!scan.modelRegistryScriptIds.includes('app-main')) {
    throw new Error(
      `no \`var ${MODEL_REGISTRY} = { ... }\` declaration in #app-main — the opt-in model download has ` +
        'nowhere to declare its runtime, wasm and weight hosts'
    );
  }
  const owned = scan.urlLiterals.filter((u) => u.registry === MODEL_REGISTRY);
  if (!owned.length) throw new Error(`${MODEL_REGISTRY} declares no asset URL at all`);
});

s.test('rule 5: every runtime-fetched code source carries a pinned sha256 digest', () => {
  const hits = scan.violations.filter((v) => v.rule === 'unpinned-code-source');
  if (hits.length) {
    throw new Error(
      `${hits.length} unpinned code source(s) — runtime-fetched CODE must be hash-verified before it ` +
        `executes:\n${describe(hits)}`
    );
  }
  // …and prove the rule had something to check, so a deleted registry cannot
  // pass this test by making it vacuous.
  const source = fs.readFileSync(INDEX, 'utf8');
  const script = listScripts(source).find((sc) => sc.attrs.id === 'app-main');
  const lex = lexJs(script.source);
  const span = findDeclarationSpan(script.source, MODEL_REGISTRY, lex);
  if (!span) throw new Error(`${MODEL_REGISTRY} is not declared`);
  const body = script.source.slice(span.start, span.end);
  if (!/\bkind\s*:\s*(['"`])code\1/.test(body)) {
    throw new Error(`${MODEL_REGISTRY} declares no kind:'code' entry, so rule 5 checked nothing`);
  }
  if (!/\bintegrity\s*:\s*(['"`])sha256-[A-Za-z0-9+/=_-]{20,}\1/.test(body)) {
    throw new Error('no real sha256 digest is pinned in the registry');
  }
});

s.test('rule 4: no worker is spawned from a URL literal', () => {
  const hits = scan.violations.filter((v) => v.rule === 'worker-url');
  if (hits.length) {
    throw new Error(
      `${hits.length} worker(s) spawned from a remote URL — workers must come from an inline ` +
        `<script> block via a Blob URL:\n${describe(hits)}`
    );
  }
  // The two workers this app really has, both spawned the Blob way.
  const raw = fs.readFileSync(INDEX, 'utf8');
  const ids = listScripts(raw).map((sc) => sc.attrs.id);
  for (const id of ['dsp-worker-src', 'ai-worker-src']) {
    if (!ids.includes(id)) throw new Error(`inline worker source #${id} is missing`);
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

/* --- negative tests for URL POLICY v2 (rules 4 and 5) ---------------------- */

s.test('NEGATIVE: a second registry (LOCAL_MODEL_SOURCES) also licenses its literals', () => {
  const r = scanSingleFile(scratch('two-registries.html', fixture(REGISTRY_FIXTURE + '\n' + MODEL_FIXTURE)));
  if (r.violations.length) throw new Error(`expected a clean scan, got:\n${describe(r.violations)}`);
  const owned = r.urlLiterals.filter((u) => u.registry === MODEL_REGISTRY).map((u) => u.url);
  if (owned.length !== 3) {
    throw new Error(`expected the 3 model asset URLs to be registry-owned, saw ${owned.length}: ${owned.join(', ')}`);
  }
  if (r.registriesFound.length !== 2) {
    throw new Error(`both registries should have been located, found: ${r.registriesFound.join(', ') || '(none)'}`);
  }
});

s.test('NEGATIVE: a model URL declared outside both registries is still flagged', () => {
  const body = REGISTRY_FIXTURE + '\n' + MODEL_FIXTURE + "\nvar EXTRA_WEIGHTS = 'https://models.example.com/rogue.onnx';";
  const r = scanSingleFile(scratch('rogue-weights.html', fixture(body)));
  const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length !== 1 || hits[0].excerpt.indexOf('rogue.onnx') === -1) {
    throw new Error(`expected the rogue weight URL to be flagged, got:\n${describe(r.violations)}`);
  }
});

s.test('NEGATIVE: rule 5 — a kind:"code" entry with no integrity fails', () => {
  const unpinned = MODEL_FIXTURE.replace(
    "    integrity: 'sha256-qlACtw54l5jaJj9fmcYr0+j80MEZJYpJPEDBgGSDZfo=', bytes: 888173 },",
    '    bytes: 888173 },'
  );
  const r = scanSingleFile(scratch('unpinned.html', fixture(REGISTRY_FIXTURE + '\n' + unpinned)));
  const hits = r.violations.filter((v) => v.rule === 'unpinned-code-source');
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 unpinned-code-source, got ${hits.length}:\n${describe(r.violations)}`);
  }
  if (hits[0].excerpt.indexOf('runtime') === -1) throw new Error(`the entry was not named: ${hits[0].excerpt}`);
  if (hits[0].excerpt.indexOf('no integrity literal at all') === -1) {
    throw new Error(`wrong reason: ${hits[0].excerpt}`);
  }
});

s.test('NEGATIVE: rule 5 — an empty or non-sha256 integrity fails just as hard', () => {
  for (const [name, bad] of [
    ['empty', "integrity: ''"],
    ['not a digest', "integrity: 'trust-me'"],
    ['wrong algorithm', "integrity: 'md5-0123456789abcdef0123456789abcdef'"],
  ]) {
    const body = MODEL_FIXTURE.replace(
      "integrity: 'sha256-qlACtw54l5jaJj9fmcYr0+j80MEZJYpJPEDBgGSDZfo='",
      bad
    );
    const r = scanSingleFile(scratch(`integrity-${name.replace(/\s/g, '-')}.html`, fixture(REGISTRY_FIXTURE + '\n' + body)));
    const hits = r.violations.filter((v) => v.rule === 'unpinned-code-source');
    if (hits.length !== 1) {
      throw new Error(`"${name}": expected 1 unpinned-code-source, got ${hits.length}:\n${describe(r.violations)}`);
    }
  }
});

s.test('NEGATIVE: rule 5 — a kind:"weights" entry needs no digest (weights are data)', () => {
  const dataOnly = [
    'var LOCAL_MODEL_SOURCES = {',
    "  weights: { kind: 'weights', host: 'https://models.example.com/' }",
    '};',
  ].join('\n');
  const r = scanSingleFile(scratch('weights-only.html', fixture(REGISTRY_FIXTURE + '\n' + dataOnly)));
  const hits = r.violations.filter((v) => v.rule === 'unpinned-code-source');
  if (hits.length) throw new Error(`weights must not need pinning:\n${describe(r.violations)}`);
});

s.test('NEGATIVE: rule 4 — new Worker() on a URL literal is flagged, loopback included', () => {
  for (const [name, url] of [
    ['remote', 'https://cdn.example.com/worker.js'],
    ['protocol-relative', '//cdn.example.com/worker.js'],
    ['loopback', 'http://localhost:8080/worker.js'],
  ]) {
    const body = `${REGISTRY_FIXTURE}\nfunction spawn() { return new Worker('${url}'); }`;
    const r = scanSingleFile(scratch(`worker-${name}.html`, fixture(body)));
    const hits = r.violations.filter((v) => v.rule === 'worker-url');
    if (hits.length !== 1) {
      throw new Error(`"${name}": expected 1 worker-url violation, got ${hits.length}:\n${describe(r.violations)}`);
    }
  }
  // SharedWorker is the same hole with a different name.
  const shared = `${REGISTRY_FIXTURE}\nvar w = new SharedWorker("https://cdn.example.com/shared.js");`;
  const r = scanSingleFile(scratch('worker-shared.html', fixture(shared)));
  if (!r.violations.some((v) => v.rule === 'worker-url')) {
    throw new Error(`SharedWorker slipped through:\n${describe(r.violations)}`);
  }
});

s.test('NEGATIVE: rule 4 — a Blob-URL worker (how this app really spawns) passes', () => {
  const body = [
    REGISTRY_FIXTURE,
    'function spawn(id) {',
    '  var url = URL.createObjectURL(new Blob([id], { type: "text/javascript" }));',
    '  return new Worker(url, { type: "module" });',
    '}',
  ].join('\n');
  const r = scanSingleFile(scratch('worker-blob.html', fixture(body)));
  if (r.violations.length) throw new Error(`the Blob spawn pattern must scan clean:\n${describe(r.violations)}`);
});

s.test('NEGATIVE: #ai-worker-src is governed by rule 2 like the other inline scripts', () => {
  const html = fixture(REGISTRY_FIXTURE).replace(
    '<script id="app-main">',
    '<script id="ai-worker-src" type="text/js-worker">\n' +
      "var LEAK = 'https://cdn.example.com/model.onnx';\n" +
      '</' +
      'script>\n<script id="app-main">'
  );
  const r = scanSingleFile(scratch('ai-worker-url.html', html));
  const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
  if (hits.length !== 1 || hits[0].excerpt.indexOf('ai-worker-src') !== 0) {
    throw new Error(`expected 1 ai-worker-scoped violation, got:\n${describe(r.violations)}`);
  }
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

/* --- URL POLICY v3: the inline manifest (rule 6) and namespaces (rule 7) --- */

const MANIFEST_DATA_HREF = 'data:application/manifest+json;charset=utf-8,%7B%22name%22%3A%22x%22%7D';

s.test('rule 6: index.html ships exactly one manifest link, and it carries no href in source', () => {
  if (scan.manifestLinks.length !== 1) {
    throw new Error(
      `expected exactly 1 <link rel="manifest">, found ${scan.manifestLinks.length} — the inline ` +
        'manifest is one link whose href the boot script writes'
    );
  }
  const href = scan.manifestLinks[0].href;
  if (href !== null && href.trim() !== '') {
    throw new Error(
      `the manifest link ships with href="${href}"; it must be empty in source so the only manifest ` +
        'that ever exists is the data: URI built from var PWA_MANIFEST at boot'
    );
  }
});

s.test('rule 7: the SVG namespace is the ONLY non-registry, non-loopback literal', () => {
  const namespaces = scan.urlLiterals.filter((u) => u.namespace);
  if (!namespaces.length) {
    throw new Error(
      'no XML namespace literal found — the PWA icon is a standalone SVG document and cannot ' +
        'parse without one, so its absence means the icon is gone'
    );
  }
  for (const hit of namespaces) {
    if (XML_NAMESPACE_URIS.indexOf(hit.url) === -1) {
      throw new Error(`"${hit.url}" was tagged as a namespace but is not one of the two allowed names`);
    }
  }
  const unaccounted = scan.urlLiterals.filter((u) => !u.loopback && !u.inRegistry && !u.namespace);
  if (unaccounted.length) {
    throw new Error(`literals answering to no rule: ${unaccounted.map((u) => u.url).join(', ')}`);
  }
});

s.test('NEGATIVE: rule 6 — a data: manifest href scans clean, an absent one too', () => {
  for (const [name, link] of [
    ['absent href', '<link rel="manifest">'],
    ['empty href', '<link rel="manifest" href="">'],
    ['data href', `<link rel="manifest" href="${MANIFEST_DATA_HREF}">`],
    ['multi-token rel', `<link rel="manifest alternate" href="${MANIFEST_DATA_HREF}">`],
  ]) {
    const r = scanSingleFile(scratch(`manifest-ok-${name.replace(/\s/g, '-')}.html`, fixture(REGISTRY_FIXTURE, link)));
    if (r.violations.length) {
      throw new Error(`"${name}" must scan clean, got:\n${describe(r.violations)}`);
    }
    if (r.manifestLinks.length !== 1) throw new Error(`"${name}": the link was not seen at all`);
  }
});

s.test('NEGATIVE: rule 6 — a REMOTE manifest href still fails, on two rules at once', () => {
  for (const [name, href] of [
    ['https', 'https://cdn.example.com/manifest.json'],
    ['http', 'http://cdn.example.com/manifest.json'],
    ['protocol-relative', '//cdn.example.com/manifest.json'],
  ]) {
    const link = `<link rel="manifest" href="${href}">`;
    const r = scanSingleFile(scratch(`manifest-remote-${name}.html`, fixture(REGISTRY_FIXTURE, link)));
    const rules = r.violations.map((v) => v.rule);
    if (rules.indexOf('manifest-href') === -1) {
      throw new Error(`"${name}": rule 6 did not fire; saw: ${rules.join(', ') || '(none)'}`);
    }
    // Rule 1 has always caught this shape, and it must keep catching it: a
    // remote manifest is a boot-time network dependency whatever else it is.
    if (rules.indexOf('external-src-or-href') === -1) {
      throw new Error(`"${name}": rule 1 stopped firing on a remote href; saw: ${rules.join(', ')}`);
    }
  }

  // Loopback is NOT a licence here. A manifest served off localhost is still a
  // file this bundle does not contain.
  const loopback = scanSingleFile(
    scratch('manifest-loopback.html', fixture(REGISTRY_FIXTURE, '<link rel="manifest" href="http://localhost:8080/manifest.json">'))
  );
  if (!loopback.violations.some((v) => v.rule === 'manifest-href')) {
    throw new Error(`a loopback manifest slipped through:\n${describe(loopback.violations)}`);
  }
});

s.test('NEGATIVE: rule 6 — a RELATIVE manifest href fails, which is the whole point of the rule', () => {
  for (const href of ['manifest.json', './manifest.json', '/manifest.webmanifest', '../app/manifest.json']) {
    const link = `<link rel="manifest" href="${href}">`;
    const r = scanSingleFile(scratch(`manifest-rel-${href.replace(/[^a-z]/gi, '')}.html`, fixture(REGISTRY_FIXTURE, link)));
    const hits = r.violations.filter((v) => v.rule === 'manifest-href');
    if (hits.length !== 1) {
      throw new Error(
        `href="${href}" is a sibling file and must be flagged; got ${hits.length}:\n${describe(r.violations)}`
      );
    }
    // …and prove rule 1 really could not see it, so the new rule is not
    // duplicating one that already existed.
    if (r.violations.some((v) => v.rule === 'external-src-or-href')) {
      throw new Error(`href="${href}" was caught by rule 1 after all — rule 6 would be redundant`);
    }
  }
});

s.test('NEGATIVE: a <link> QUOTED inside a script is prose, a real one beside it is not', () => {
  // #app-main documents the inline manifest by naming the tag. That must not
  // register as a second link element…
  const body = `${REGISTRY_FIXTURE}\n/* the boot script fills in <link rel="manifest"> and <link rel="stylesheet"> */`;
  const quoted = scanSingleFile(scratch('link-in-script.html', fixture(body)));
  if (quoted.manifestLinks.length) throw new Error('a mention inside a script was counted as a link element');
  if (quoted.violations.length) throw new Error(`prose must scan clean:\n${describe(quoted.violations)}`);

  // …while a real one in the head is still seen, so the blanking cannot be
  // used to smuggle a link past the walk.
  const real = scanSingleFile(
    scratch('link-real.html', fixture(body, '<link rel="stylesheet" href="theme.css">\n<link rel="manifest" href="manifest.json">'))
  );
  const rules = real.violations.map((v) => v.rule);
  for (const expected of ['link-stylesheet', 'manifest-href']) {
    if (rules.indexOf(expected) === -1) throw new Error(`"${expected}" did not fire; saw: ${rules.join(', ') || '(none)'}`);
  }
  if (real.manifestLinks.length !== 1) throw new Error(`expected 1 manifest link, saw ${real.manifestLinks.length}`);
});

s.test('NEGATIVE: rule 7 — the two namespace names pass, a lookalike does not', () => {
  const allowed = XML_NAMESPACE_URIS.map((ns) => `var NS_${ns.length} = '${ns}';`).join('\n');
  const clean = scanSingleFile(scratch('ns-ok.html', fixture(`${REGISTRY_FIXTURE}\n${allowed}`)));
  if (clean.violations.length) {
    throw new Error(`the namespace names must scan clean:\n${describe(clean.violations)}`);
  }
  if (clean.urlLiterals.filter((u) => u.namespace).length !== XML_NAMESPACE_URIS.length) {
    throw new Error('not every namespace literal was recognised');
  }

  for (const lookalike of [
    'http://www.w3.org/2000/svg/steal.js',
    'https://www.w3.org/2000/svg',
    'http://www.w3.org/2000/',
    'http://evil.example.com/http://www.w3.org/2000/svg',
  ]) {
    const body = `${REGISTRY_FIXTURE}\nvar SNEAKY = '${lookalike}';`;
    const r = scanSingleFile(scratch(`ns-bad-${lookalike.replace(/[^a-z]/gi, '').slice(0, 24)}.html`, fixture(body)));
    const hits = r.violations.filter((v) => v.rule === 'unregistered-url-literal');
    if (hits.length !== 1) {
      throw new Error(`"${lookalike}" must not inherit the namespace allowance; got:\n${describe(r.violations)}`);
    }
  }
});

s.test('NEGATIVE: rule 7 does not extend to rule 3 — fetching a namespace is still a fetch', () => {
  const body = `${REGISTRY_FIXTURE}\nfunction ns() { return fetch('http://www.w3.org/2000/svg'); }`;
  const r = scanSingleFile(scratch('ns-fetch.html', fixture(body)));
  const hits = r.violations.filter((v) => v.rule === 'network-fetch-url');
  if (hits.length !== 1) {
    throw new Error(`a fetch() to a namespace must still be a network call; got:\n${describe(r.violations)}`);
  }
  // The literal itself is still allowed — it is the CALL that is refused.
  if (r.violations.some((v) => v.rule === 'unregistered-url-literal')) {
    throw new Error('the namespace literal must not be double-reported');
  }
});

s.test('scratch fixtures are cleaned up', () => {
  for (const file of scratchFiles) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (SCRATCH === null) throw new Error('no scratch directory was ever created — no fixture ran');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  if (fs.existsSync(SCRATCH)) throw new Error(`scratch dir survived: ${SCRATCH}`);
});

module.exports = {
  scanSingleFile,
  stripComments,
  stripScriptBodies,
  lexJs,
  findDeclarationSpan,
  findRegistrySpans,
  enclosingObject,
  listUrlLiterals,
  listUnpinnedCodeSources,
  isLoopbackUrl,
  isXmlNamespaceUri,
  PRESET_REGISTRY,
  MODEL_REGISTRY,
  ALLOWED_URL_REGISTRIES,
  GOVERNED_SCRIPT_IDS,
  XML_NAMESPACE_URIS,
};

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
