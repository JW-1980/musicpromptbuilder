'use strict';
/*
 * tests/lib/extract.js — inline-script extraction + Web Worker sandboxing.
 *
 * SunoPrompt Studio ships as a single zero-dependency index.html, so there is
 * no module to `require()`. These helpers pull the inline <script> blocks out
 * of the HTML by their stable ids (see the comment block at the top of
 * index.html) and run the DSP worker source inside a node:vm context with a
 * minimal `self` stub, giving us real behavioural tests without a browser.
 *
 * Node built-ins only: fs, path, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Parse an HTML attribute list (the raw text between `<script` and `>`) into a
 * lower-cased attribute map. Tolerant of arbitrary attribute order, extra
 * whitespace, single/double/unquoted values and valueless attributes.
 *
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseAttributes(raw) {
  const attrs = Object.create(null);
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = value;
  }
  return attrs;
}

/**
 * Enumerate every <script> element in an HTML string.
 *
 * @param {string} html
 * @returns {Array<{attrs: Record<string,string>, source: string, index: number}>}
 */
function listScripts(html) {
  const out = [];
  // Match an opening <script ...> tag; attributes may contain `>` only inside
  // quotes, which the alternation below accounts for.
  const openRe = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const bodyStart = m.index + m[0].length;
    const closeIdx = html.toLowerCase().indexOf('</script', bodyStart);
    if (closeIdx === -1) continue;
    out.push({
      attrs: parseAttributes(m[1]),
      source: html.slice(bodyStart, closeIdx),
      index: m.index,
    });
  }
  return out;
}

/**
 * Read an HTML file and return the inner source of the <script> whose `id`
 * attribute matches `id`.
 *
 * @param {string} htmlPath absolute path to the HTML file
 * @param {string} id value of the script's id attribute
 * @returns {string} the raw inner JavaScript source
 * @throws {Error} when the file is missing or no script carries that id
 */
function extractScriptById(htmlPath, id) {
  const resolved = path.resolve(htmlPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`extractScriptById: HTML file not found: ${resolved}`);
  }
  const html = fs.readFileSync(resolved, 'utf8');
  const scripts = listScripts(html);
  const hit = scripts.find((s) => s.attrs.id === id);
  if (!hit) {
    const seen = scripts.map((s) => s.attrs.id || '(no id)').join(', ') || '(none)';
    throw new Error(
      `extractScriptById: no <script> with id="${id}" in ${resolved}. Scripts found: ${seen}`
    );
  }
  return hit.source;
}

/**
 * Load the #dsp-worker-src block into a node:vm sandbox with a `self` stub.
 *
 * The stub captures every `self.postMessage(...)` call, and `send(msg)` drives
 * the worker exactly the way a browser would: `self.onmessage({data: msg})`.
 *
 * @param {string} htmlPath absolute path to index.html
 * @param {{id?: string}} [opts]
 * @returns {{sandbox: object, replies: any[], send: (msg: any) => any, source: string}}
 */
function loadWorkerSandbox(htmlPath, opts) {
  const id = (opts && opts.id) || 'dsp-worker-src';
  const source = extractScriptById(htmlPath, id);

  const replies = [];
  const self = {
    postMessage(payload) {
      replies.push(payload);
    },
    onmessage: null,
    addEventListener() {
      /* not used by the worker today; present so feature checks don't throw */
    },
  };

  const sandbox = {
    self,
    // Worker global scope has no `window`/`document`; keep it that way so the
    // worker source can never accidentally depend on DOM APIs.
    console,
    Math,
    Date,
    JSON,
    Float32Array,
    Float64Array,
    Int16Array,
    Uint8Array,
    ArrayBuffer,
    Number,
    String,
    Array,
    Object,
    Error,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
  };
  sandbox.self.self = sandbox.self;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: `${path.basename(htmlPath)}#${id}` });

  return {
    sandbox,
    source,
    replies,
    /**
     * Evaluate an expression inside the worker context.
     *
     * Needed because top-level `const`/`let`/`class` declarations are LEXICAL:
     * they live in the context's global lexical environment and never appear as
     * properties of the sandbox object (unlike `function`/`var`). They are,
     * however, visible to any later script run in the same context — which is
     * exactly what this does. Use `evaluate('typeof X')` to probe safely.
     *
     * @param {string} expression
     */
    evaluate(expression) {
      return vm.runInContext(expression, sandbox, { filename: `${id}#evaluate` });
    },
    /**
     * Deliver a message to the worker and return the reply it posted back.
     * Returns `undefined` if the worker posted nothing.
     */
    send(msg) {
      if (typeof sandbox.self.onmessage !== 'function') {
        throw new Error('loadWorkerSandbox: worker never assigned self.onmessage');
      }
      const before = replies.length;
      sandbox.self.onmessage({ data: msg });
      return replies.length > before ? replies[replies.length - 1] : undefined;
    },
  };
}

/**
 * Blank out every <script> BODY, keeping the tags and every newline so line
 * numbers survive.
 *
 * "Is this MARKUP?" and "is this anywhere in the file?" are different
 * questions, and several assertions want the first one. #app-main documents
 * the app's own DOM by quoting tags — `<link rel="manifest">`, `<svg xmlns=…>`
 * — and a tag named in a comment is prose, not an element in the document.
 * Callers that genuinely mean "anywhere in the file" simply do not use this.
 *
 * @param {string} html
 * @returns {string} the same length in lines, with script bodies spaced out
 */
function stripScriptBodies(html) {
  return String(html).replace(
    /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi,
    (whole, open, body, close) => open + body.replace(/[^\n]/g, ' ') + close
  );
}

module.exports = {
  extractScriptById,
  loadWorkerSandbox,
  listScripts,
  parseAttributes,
  stripScriptBodies,
};
