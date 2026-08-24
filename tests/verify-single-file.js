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
 * This suite is a *static* scan, so it must pass TODAY and every day after.
 * `scanSingleFile(htmlPath)` is exported so other harnesses (and the negative
 * test) can point it at an arbitrary file.
 *
 * Node built-ins only: fs, path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { suite } = require('./lib/runner.js');
const { listScripts, parseAttributes } = require('./lib/extract.js');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/**
 * Strip HTML comments so commented-out examples (and the doc block at the top
 * of index.html) never trigger a false positive.
 * @param {string} html
 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Scan an HTML file for anything that would make it depend on the network or
 * on a sibling file.
 *
 * @param {string} htmlPath
 * @returns {{
 *   path: string, exists: boolean, bytes: number, hasDoctype: boolean,
 *   scriptIds: string[], workerScriptType: string|null,
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
    // Worker importScripts() with a URL literal.
    { rule: 'importscripts-url', re: /importScripts\s*\(\s*(?:"|'|`)[^"'`)]*:?\/\//gi },
    // Any bare absolute URL used as a JS string that would be fetched.
    {
      rule: 'network-fetch-url',
      re: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(\s*(?:"|'|`)\s*(?:https?:)?\/\//gi,
    },
    // <base href> would repoint every relative URL.
    { rule: 'base-href', re: /<base\b(?:[^>"']|"[^"]*"|'[^']*')*href/gi },
  ];

  for (const { rule, re } of RULES) {
    let m;
    while ((m = re.exec(html)) !== null) add(rule, m[0]);
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

  return report;
}

function describe(violations) {
  return violations
    .map((v) => `  [${v.rule}] line ${v.line}: ${v.excerpt}`)
    .join('\n');
}

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

s.test('no CSS @import of a remote URL', () => {
  const hits = scan.violations.filter((v) => v.rule === 'css-import-url');
  if (hits.length) throw new Error(`${hits.length} remote @import(s):\n${describe(hits)}`);
});

s.test('no importScripts() with a URL literal', () => {
  const hits = scan.violations.filter((v) => v.rule === 'importscripts-url');
  if (hits.length) throw new Error(`${hits.length} remote importScripts():\n${describe(hits)}`);
});

s.test('no network calls to absolute URLs (fetch/XHR/WebSocket/beacon)', () => {
  const hits = scan.violations.filter((v) => v.rule === 'network-fetch-url');
  if (hits.length) throw new Error(`${hits.length} network call(s):\n${describe(hits)}`);
});

s.test('safe to run from file:// (no violations at all)', () => {
  if (scan.violations.length) {
    throw new Error(`${scan.violations.length} total violation(s):\n${describe(scan.violations)}`);
  }
});

module.exports = { scanSingleFile, stripComments };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
