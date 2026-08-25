'use strict';
/*
 * tests/visualizer.test.js — the 3D WebGL frequency ribbon.
 *
 * Contract under test: docs/FEATURE-MECHANICS.md §1.5 (time-domain buffer maps
 * to Z-depth and Y-amplitude, the ribbon twists, the shader colour follows the
 * detected Harmonic Valence between EXACTLY vec3(0.0, 0.94, 1.0) for major and
 * vec3(0.54, 0.17, 0.89) for minor) and docs/FDD.md #11 (a WebGL wireframe
 * ribbon).
 *
 * There is no browser here and no GPU. Two things make that fine:
 *   1. every piece of maths — mesh, downsampling, colour, history shifting —
 *      is a top-level PURE function of #app-main, callable from a node:vm
 *      sandbox;
 *   2. createRibbonRenderer takes its context and its animation clock as
 *      injected dependencies, so a recording GL stub and a fake rAF drive the
 *      real renderer through its real code path.
 * What genuinely needs a GPU (that the shaders compile on a real driver, that
 * pixels land) is covered by the browser smoke pass and declared as a todo
 * below rather than faked here.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* docs/FEATURE-MECHANICS.md §1.5 — written out here so a drift in index.html
 * fails a test instead of quietly repainting the app. */
const MAJOR_RGB = [0.0, 0.94, 1.0];
const MINOR_RGB = [0.54, 0.17, 0.89];
const MAJOR_LITERAL = 'vec3(0.0, 0.94, 1.0)';
const MINOR_LITERAL = 'vec3(0.54, 0.17, 0.89)';

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/** Evaluate #app-main in a DOM-free vm context (the boot IIFE stays inert). */
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
    Uint16Array,
    Uint32Array,
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

/* -------------------------------------------------------------------------- */
/* Fakes (test-only)                                                          */
/* -------------------------------------------------------------------------- */

/** The WebGL2 enum values the renderer passes through. Real numbers, so a
 *  swapped pair of constants would show up in the recorded call log. */
const GL_ENUM = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  FLOAT: 0x1406,
  TRIANGLES: 0x0004,
  UNSIGNED_SHORT: 0x1403,
  UNSIGNED_INT: 0x1405,
  DEPTH_TEST: 0x0b71,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
};

/** Attribute slots a real linker would hand out for the ribbon program. */
const ATTRIB_SLOT = { aPosition: 0, aUv: 1, aLevel: 2 };

/**
 * A recording WebGL2 stand-in. Every call is logged with its arguments, so the
 * test can assert the renderer really compiled, linked, uploaded and drew.
 *
 * @param {{compileOk?:boolean, linkOk?:boolean, noVao?:boolean}} [options]
 */
function makeGlStub(options) {
  const o = options || {};
  const calls = [];
  const gl = {};
  for (const key of Object.keys(GL_ENUM)) gl[key] = GL_ENUM[key];

  let shaderSeq = 0;
  let bufferSeq = 0;
  function log(name, args, result) {
    calls.push({ name, args });
    return result;
  }

  gl.calls = calls;
  gl.names = () => calls.map((c) => c.name);
  gl.callsTo = (name) => calls.filter((c) => c.name === name);
  gl.drawingBufferWidth = 640;
  gl.drawingBufferHeight = 190;

  gl.createShader = (type) => log('createShader', [type], { kind: 'shader', type, id: (shaderSeq += 1) });
  gl.shaderSource = (shader, source) => log('shaderSource', [shader, source]);
  gl.compileShader = (shader) => log('compileShader', [shader]);
  gl.getShaderParameter = (shader, pname) =>
    log('getShaderParameter', [shader, pname], o.compileOk === false ? false : true);
  gl.getShaderInfoLog = (shader) => log('getShaderInfoLog', [shader], 'stub: compile log');
  gl.deleteShader = (shader) => log('deleteShader', [shader]);

  gl.createProgram = () => log('createProgram', [], { kind: 'program' });
  gl.attachShader = (program, shader) => log('attachShader', [program, shader]);
  gl.linkProgram = (program) => log('linkProgram', [program]);
  gl.getProgramParameter = (program, pname) =>
    log('getProgramParameter', [program, pname], o.linkOk === false ? false : true);
  gl.getProgramInfoLog = (program) => log('getProgramInfoLog', [program], 'stub: link log');
  gl.useProgram = (program) => log('useProgram', [program]);

  if (!o.noVao) {
    gl.createVertexArray = () => log('createVertexArray', [], { kind: 'vao' });
    gl.bindVertexArray = (vao) => log('bindVertexArray', [vao]);
  }

  gl.getAttribLocation = (program, name) => {
    const slot = Object.prototype.hasOwnProperty.call(ATTRIB_SLOT, name) ? ATTRIB_SLOT[name] : -1;
    return log('getAttribLocation', [program, name], slot);
  };
  gl.getUniformLocation = (program, name) =>
    log('getUniformLocation', [program, name], { kind: 'uniform', name });

  gl.createBuffer = () => log('createBuffer', [], { kind: 'buffer', id: (bufferSeq += 1) });
  gl.bindBuffer = (target, buffer) => log('bindBuffer', [target, buffer]);
  gl.bufferData = (target, data, usage) => log('bufferData', [target, data, usage]);
  gl.bufferSubData = (target, offset, data) => log('bufferSubData', [target, offset, data]);
  gl.enableVertexAttribArray = (loc) => log('enableVertexAttribArray', [loc]);
  gl.vertexAttribPointer = (loc, size, type, norm, stride, offset) =>
    log('vertexAttribPointer', [loc, size, type, norm, stride, offset]);

  gl.enable = (cap) => log('enable', [cap]);
  gl.clearColor = (r, g, b, a) => log('clearColor', [r, g, b, a]);
  gl.clear = (mask) => log('clear', [mask]);
  gl.viewport = (x, y, w, h) => log('viewport', [x, y, w, h]);
  gl.uniformMatrix4fv = (loc, transpose, value) => log('uniformMatrix4fv', [loc, transpose, value]);
  gl.uniform3f = (loc, x, y, z) => log('uniform3f', [loc, x, y, z]);
  gl.uniform1f = (loc, x) => log('uniform1f', [loc, x]);
  gl.drawElements = (mode, count, type, offset) => log('drawElements', [mode, count, type, offset]);

  return gl;
}

/** A canvas with a laid-out box. `context` is what getContext() will return. */
function makeCanvas(context) {
  return {
    clientWidth: 320,
    clientHeight: 190,
    width: 300,
    height: 150,
    contextRequests: [],
    getContext(id, attrs) {
      this.contextRequests.push({ id, attrs });
      return context === undefined ? null : context;
    },
  };
}

/** An injectable animation clock the test drives by hand. */
function makeClock() {
  const pending = [];
  const cancelled = [];
  let nextId = 1;
  const raf = (callback) => {
    const id = nextId;
    nextId += 1;
    pending.push({ id, callback });
    return id;
  };
  const caf = (id) => {
    cancelled.push(id);
    const at = pending.findIndex((job) => job.id === id);
    if (at !== -1) pending.splice(at, 1);
  };
  return {
    raf,
    caf,
    cancelled,
    pending,
    /** Run up to `count` scheduled frames, honouring anything they reschedule. */
    flush(count) {
      let ran = 0;
      for (let i = 0; i < (count || 1); i += 1) {
        const job = pending.shift();
        if (!job) break;
        job.callback(16.7 * (i + 1));
        ran += 1;
      }
      return ran;
    },
  };
}

/** Build a renderer over a stub context, with the fake clock attached. */
function makeRenderer(options) {
  const o = options || {};
  const gl = o.gl === undefined ? makeGlStub(o.glOptions) : o.gl;
  const clock = makeClock();
  const renderer = app.sandbox.createRibbonRenderer({
    canvas: o.canvas === undefined ? makeCanvas(null) : o.canvas,
    gl: gl || undefined,
    cols: o.cols,
    rows: o.rows,
    raf: o.noClock ? undefined : clock.raf,
    caf: o.noClock ? undefined : clock.caf,
    devicePixelRatio: 1,
  });
  return { renderer, gl, clock };
}

function readIndex() {
  return fs.readFileSync(INDEX, 'utf8');
}

/** Squared distance between two RGB triples. */
function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

const s = suite('visualizer (3D WebGL frequency ribbon)');

/* -------------------------------------------------------------------------- */
/* Reachability                                                               */
/* -------------------------------------------------------------------------- */

s.test('every ribbon function is a reachable top-level declaration', () => {
  for (const name of [
    'buildRibbonGeometry',
    'downsampleBuffer',
    'valenceToColor',
    'pushRibbonRow',
    'perspectiveMatrix4',
    'ribbonNeutralColor',
    'ribbonGridSize',
    'createRibbonRenderer',
  ]) {
    assert.strictEqual(
      typeof app.sandbox[name],
      'function',
      `${name} is not reachable as a top-level function declaration`
    );
  }
  for (const name of ['RIBBON_VERTEX_SOURCE', 'RIBBON_FRAGMENT_SOURCE']) {
    assert.strictEqual(typeof app.sandbox[name], 'string', `${name} must be a top-level var string`);
  }
  // The §1.5 palette is a `var` so a test can read it rather than re-type it.
  assert.deepStrictEqual(Array.from(app.sandbox.RIBBON_MAJOR_RGB), MAJOR_RGB, 'major anchor drifted');
  assert.deepStrictEqual(Array.from(app.sandbox.RIBBON_MINOR_RGB), MINOR_RGB, 'minor anchor drifted');
});

/* -------------------------------------------------------------------------- */
/* buildRibbonGeometry                                                        */
/* -------------------------------------------------------------------------- */

s.test('buildRibbonGeometry emits a cols x rows lattice with matching buffers', () => {
  const g = app.sandbox.buildRibbonGeometry(8, 5);

  assert.strictEqual(g.cols, 8, 'cols was not honoured');
  assert.strictEqual(g.rows, 5, 'rows was not honoured');
  assert.strictEqual(g.vertexCount, 40, 'a 8x5 grid has 40 vertices');
  assert.strictEqual(g.positions.length, 40 * 3, 'positions must hold xyz per vertex');
  assert.strictEqual(g.uvs.length, 40 * 2, 'uvs must hold uv per vertex');
  assert.ok(g.positions instanceof Float32Array, 'positions must be a Float32Array');
  assert.ok(g.uvs instanceof Float32Array, 'uvs must be a Float32Array');

  // 6 indices per quad, (cols-1) * (rows-1) quads.
  assert.strictEqual(g.indexCount, 7 * 4 * 6, 'index count does not match the quad count');
  assert.strictEqual(g.indices.length, g.indexCount, 'the index buffer is the wrong length');
});

s.test('buildRibbonGeometry: x spans -1..1, z spans 0..1 (the time axis), y is flat', () => {
  const g = app.sandbox.buildRibbonGeometry(16, 9);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < g.vertexCount; i += 1) {
    const x = g.positions[i * 3];
    const y = g.positions[i * 3 + 1];
    const z = g.positions[i * 3 + 2];
    assert.strictEqual(y, 0, `vertex ${i} is pre-displaced in Y; the shader owns that`);
    assert.ok(x >= -1 && x <= 1, `vertex ${i} x=${x} escaped -1..1`);
    assert.ok(z >= 0 && z <= 1, `vertex ${i} z=${z} escaped 0..1`);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  assert.strictEqual(minX, -1, 'the ribbon must reach the left edge');
  assert.strictEqual(maxX, 1, 'the ribbon must reach the right edge');
  assert.strictEqual(minZ, 0, 'row 0 must sit at depth 0 — the newest frame');
  assert.strictEqual(maxZ, 1, 'the last row must sit at depth 1 — the oldest frame');

  // UVs mirror the same parameterisation, which is what the wireframe and the
  // depth fade in the fragment shader read.
  for (let i = 0; i < g.vertexCount; i += 1) {
    const u = g.uvs[i * 2];
    const v = g.uvs[i * 2 + 1];
    assert.ok(u >= 0 && u <= 1, `uv.u ${u} escaped 0..1`);
    assert.ok(v >= 0 && v <= 1, `uv.v ${v} escaped 0..1`);
    assert.ok(Math.abs(u * 2 - 1 - g.positions[i * 3]) < 1e-6, 'uv.u must track x');
    assert.ok(Math.abs(v - g.positions[i * 3 + 2]) < 1e-6, 'uv.v must track z');
  }
});

s.test('buildRibbonGeometry: indexed triangles, none of them degenerate', () => {
  const g = app.sandbox.buildRibbonGeometry(6, 4);
  assert.strictEqual(g.indexCount % 3, 0, 'an index list of triangles must be a multiple of 3');

  const seen = new Set();
  for (let t = 0; t < g.indexCount; t += 3) {
    const a = g.indices[t];
    const b = g.indices[t + 1];
    const c = g.indices[t + 2];
    // A triangle-strip walk over a grid needs degenerate connector triangles;
    // an indexed triangle list must not contain a single one.
    assert.ok(
      a !== b && b !== c && a !== c,
      `triangle ${t / 3} is degenerate: (${a}, ${b}, ${c})`
    );
    for (const index of [a, b, c]) {
      assert.ok(
        Number.isInteger(index) && index >= 0 && index < g.vertexCount,
        `index ${index} is outside the 0..${g.vertexCount - 1} vertex range`
      );
    }
    const key = [a, b, c].sort((x, y) => x - y).join('/');
    assert.ok(!seen.has(key), `triangle (${a}, ${b}, ${c}) is emitted twice`);
    seen.add(key);

    // Every triangle must have real area in the XZ plane — a zero-area face
    // would be invisible and would prove the winding walked off the grid.
    const ax = g.positions[a * 3];
    const az = g.positions[a * 3 + 2];
    const bx = g.positions[b * 3];
    const bz = g.positions[b * 3 + 2];
    const cx = g.positions[c * 3];
    const cz = g.positions[c * 3 + 2];
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    assert.ok(area > 0, `triangle ${t / 3} has zero area in the XZ plane`);
  }
  assert.strictEqual(seen.size, 5 * 3 * 2, 'a 6x4 grid is 15 quads, so 30 triangles');
});

s.test('buildRibbonGeometry picks an index type the vertex count can address', () => {
  const small = app.sandbox.buildRibbonGeometry(64, 64);
  assert.ok(small.indices instanceof Uint16Array, '4096 vertices fit in 16-bit indices');

  // Past 65536 vertices a Uint16 index cannot name every vertex.
  const large = app.sandbox.buildRibbonGeometry(300, 300);
  assert.ok(
    large.indices instanceof Uint32Array,
    '90000 vertices need 32-bit indices, or the far half of the mesh is unreachable'
  );
  let maxIndex = 0;
  for (let i = 0; i < large.indices.length; i += 1) {
    if (large.indices[i] > maxIndex) maxIndex = large.indices[i];
  }
  assert.strictEqual(maxIndex, large.vertexCount - 1, 'the last vertex must be addressable');
});

s.test('buildRibbonGeometry clamps nonsense into a mesh that can still be drawn', () => {
  for (const bad of [undefined, null, NaN, 0, 1, -40, 'lots', {}]) {
    const g = app.sandbox.buildRibbonGeometry(bad, bad);
    assert.ok(g.cols >= 2 && g.rows >= 2, `cols/rows collapsed below 2 for ${String(bad)}`);
    assert.ok(g.indexCount > 0, `no triangles at all for ${String(bad)}`);
    assert.strictEqual(g.positions.length, g.vertexCount * 3, 'buffers disagree with vertexCount');
  }
  const huge = app.sandbox.buildRibbonGeometry(100000, 100000);
  assert.ok(huge.cols <= 512 && huge.rows <= 512, 'an absurd request must be capped, not allocated');

  // The default grid is the one the renderer actually uses.
  const fallback = app.sandbox.buildRibbonGeometry(undefined, undefined);
  assert.strictEqual(fallback.cols, app.sandbox.RIBBON_COLS, 'default cols drifted');
  assert.strictEqual(fallback.rows, app.sandbox.RIBBON_ROWS, 'default rows drifted');
});

/* -------------------------------------------------------------------------- */
/* downsampleBuffer                                                           */
/* -------------------------------------------------------------------------- */

s.test('downsampleBuffer contracts a capture frame to the ribbon width', () => {
  const frame = new Float32Array(2048);
  for (let i = 0; i < frame.length; i += 1) frame[i] = Math.sin((i / 2048) * Math.PI * 8) * 0.5;

  const row = app.sandbox.downsampleBuffer(frame, 128);
  assert.ok(row instanceof Float32Array, 'the row must be a Float32Array');
  assert.strictEqual(row.length, 128, `2048 samples must contract to 128, got ${row.length}`);

  // Deterministic: the same frame twice is the same row twice.
  const again = app.sandbox.downsampleBuffer(frame, 128);
  assert.deepStrictEqual(Array.from(row), Array.from(again), 'downsampling is not deterministic');

  for (const target of [1, 2, 7, 64, 2047]) {
    assert.strictEqual(
      app.sandbox.downsampleBuffer(frame, target).length,
      target,
      `a ${target}-bucket request produced the wrong length`
    );
  }
});

s.test('downsampleBuffer is peak-preserving: a single spike survives, with its sign', () => {
  const frame = new Float32Array(2048);
  frame[1337] = 0.91;
  const row = app.sandbox.downsampleBuffer(frame, 128);

  let peak = 0;
  for (let i = 0; i < row.length; i += 1) peak = Math.max(peak, row[i]);
  assert.ok(
    Math.abs(peak - 0.91) < 1e-6,
    `the spike was averaged away: the largest surviving value is ${peak}`
  );
  // …and it landed in the bucket that actually contains sample 1337.
  const bucket = Math.floor((1337 * 128) / 2048);
  assert.ok(Math.abs(row[bucket] - 0.91) < 1e-6, `the spike moved to the wrong bucket`);

  // A negative spike keeps its sign: the ribbon displaces downward, and a
  // magnitude-only reduction would fold the whole waveform upward.
  const negative = new Float32Array(2048);
  negative[900] = -0.77;
  const negativeRow = app.sandbox.downsampleBuffer(negative, 128);
  let trough = 0;
  for (let i = 0; i < negativeRow.length; i += 1) trough = Math.min(trough, negativeRow[i]);
  assert.ok(Math.abs(trough + 0.77) < 1e-6, `a negative spike lost its sign: ${trough}`);

  // Larger magnitude wins inside a bucket, whichever side it is on.
  const mixed = new Float32Array(8);
  mixed[0] = 0.2;
  mixed[1] = -0.9;
  mixed[2] = 0.3;
  mixed[3] = 0.1;
  const mixedRow = app.sandbox.downsampleBuffer(mixed, 2);
  assert.ok(Math.abs(mixedRow[0] + 0.9) < 1e-6, `the loudest sample in bucket 0 was dropped`);
});

s.test('downsampleBuffer returns nothing for nothing, and never invents samples', () => {
  for (const empty of [new Float32Array(0), [], null, undefined, 42, 'audio', {}]) {
    const out = app.sandbox.downsampleBuffer(empty, 128);
    assert.ok(out instanceof Float32Array, `downsampleBuffer(${String(empty)}) must still return an array`);
    assert.strictEqual(out.length, 0, `downsampleBuffer(${String(empty)}) must be empty, not padded`);
  }
  for (const bad of [0, -1, NaN, undefined, 'wide']) {
    assert.strictEqual(
      app.sandbox.downsampleBuffer(new Float32Array(64), bad).length,
      0,
      `a ${String(bad)}-bucket request must produce nothing`
    );
  }

  // Shorter than the target: copied verbatim, NOT stretched with made-up values.
  const short = new Float32Array([0.1, -0.2, 0.3]);
  const copied = app.sandbox.downsampleBuffer(short, 128);
  assert.strictEqual(copied.length, 3, 'a short buffer must not be padded out to the target');
  assert.deepStrictEqual(Array.from(copied).map((v) => Math.round(v * 10) / 10), [0.1, -0.2, 0.3]);

  // NaN/Infinity in the input cannot poison the mesh.
  const dirty = new Float32Array([NaN, Infinity, -Infinity, 0.4]);
  const clean = app.sandbox.downsampleBuffer(dirty, 2);
  for (let i = 0; i < clean.length; i += 1) {
    assert.ok(Number.isFinite(clean[i]), `bucket ${i} passed a non-finite value through`);
  }
});

/* -------------------------------------------------------------------------- */
/* valenceToColor                                                             */
/* -------------------------------------------------------------------------- */

s.test('valenceToColor hits the §1.5 endpoints exactly at full strength', () => {
  // Array.from re-homes the vm realm's array: a cross-realm array has a
  // different prototype, which deepStrictEqual (rightly) refuses to ignore.
  assert.deepStrictEqual(
    Array.from(app.sandbox.valenceToColor({ mode: 'major', strength: 1 })),
    MAJOR_RGB,
    'a fully-confident major must be exactly vec3(0.0, 0.94, 1.0)'
  );
  assert.deepStrictEqual(
    Array.from(app.sandbox.valenceToColor({ mode: 'minor', strength: 1 })),
    MINOR_RGB,
    'a fully-confident minor must be exactly vec3(0.54, 0.17, 0.89)'
  );
  // Out-of-range strength is clamped, not extrapolated past the anchor.
  assert.deepStrictEqual(
    Array.from(app.sandbox.valenceToColor({ mode: 'major', strength: 9 })),
    MAJOR_RGB,
    'strength above 1 must clamp to the anchor, never overshoot it'
  );
});

s.test('valenceToColor answers "not known" with a dim neutral, never a mode', () => {
  const neutral = app.sandbox.valenceToColor(null);

  // It is the midpoint of the two anchors, dimmed — so it can never be mistaken
  // for either mode at a glance.
  const midpoint = [
    (MINOR_RGB[0] + MAJOR_RGB[0]) / 2,
    (MINOR_RGB[1] + MAJOR_RGB[1]) / 2,
    (MINOR_RGB[2] + MAJOR_RGB[2]) / 2,
  ];
  const dim = app.sandbox.RIBBON_NEUTRAL_DIM;
  assert.ok(dim > 0 && dim < 1, `the neutral dim factor must actually dim, got ${dim}`);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(
      Math.abs(neutral[i] - midpoint[i] * dim) < 1e-9,
      `neutral channel ${i} is not the dimmed midpoint`
    );
  }
  const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(luminance(neutral) < luminance(MAJOR_RGB), 'the neutral must be dimmer than major');
  assert.ok(luminance(neutral) < luminance(MINOR_RGB) * 2, 'the neutral must be a dimmed blend');

  // Everything that is not a called mode lands on the same neutral.
  for (const nothing of [
    null,
    undefined,
    {},
    { mode: null, strength: 1 },
    { mode: 'ionian', strength: 1 },
    { mode: 'major' },
    { mode: 'major', strength: 0 },
    { mode: 'minor', strength: NaN },
    { mode: 'major', strength: -3 },
    'major',
    42,
  ]) {
    assert.deepStrictEqual(
      app.sandbox.valenceToColor(nothing),
      neutral,
      `${JSON.stringify(nothing)} must paint the neutral — a mode was invented`
    );
  }
});

s.test('valenceToColor blends monotonically from neutral to the anchor', () => {
  const neutral = app.sandbox.valenceToColor(null);

  for (const [mode, anchor] of [['major', MAJOR_RGB], ['minor', MINOR_RGB]]) {
    let previous = null;
    for (let step = 0; step <= 10; step += 1) {
      const strength = step / 10;
      const color = app.sandbox.valenceToColor({ mode, strength });

      if (previous) {
        // Closer to the anchor and further from "not known" at every step.
        assert.ok(
          distance(color, anchor) < distance(previous.color, anchor) + 1e-12,
          `${mode} at strength ${strength} moved away from its anchor`
        );
        assert.ok(
          distance(color, neutral) > distance(previous.color, neutral) - 1e-12,
          `${mode} at strength ${strength} moved back toward the neutral`
        );
        // Every channel moves monotonically — no hue detour on the way.
        for (let c = 0; c < 3; c += 1) {
          const direction = Math.sign(anchor[c] - neutral[c]);
          const delta = color[c] - previous.color[c];
          assert.ok(
            direction === 0 ? Math.abs(delta) < 1e-12 : Math.sign(delta) === direction,
            `${mode} channel ${c} did not move monotonically at strength ${strength}`
          );
        }
      }
      previous = { color, strength };
    }
    // Half strength is literally half way.
    const half = app.sandbox.valenceToColor({ mode, strength: 0.5 });
    for (let c = 0; c < 3; c += 1) {
      assert.ok(
        Math.abs(half[c] - (neutral[c] + anchor[c]) / 2) < 1e-9,
        `${mode} at strength 0.5 is not the midpoint of neutral and anchor`
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* pushRibbonRow                                                              */
/* -------------------------------------------------------------------------- */

s.test('pushRibbonRow shifts history exactly one row and writes the newest at row 0', () => {
  const cols = 4;
  const rows = 3;
  const history = new Float32Array(cols * rows);

  app.sandbox.pushRibbonRow(history, [1, 2, 3, 4], rows, cols);
  assert.deepStrictEqual(
    Array.from(history),
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0],
    'the first row must land at the front of the buffer'
  );

  app.sandbox.pushRibbonRow(history, [5, 6, 7, 8], rows, cols);
  assert.deepStrictEqual(
    Array.from(history),
    [5, 6, 7, 8, 1, 2, 3, 4, 0, 0, 0, 0],
    'the previous row must move back exactly one row, not two and not zero'
  );

  app.sandbox.pushRibbonRow(history, [9, 10, 11, 12], rows, cols);
  assert.deepStrictEqual(
    Array.from(history),
    [9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4],
    'three pushes must fill the ribbon in order'
  );

  // The oldest row falls off the back rather than growing the buffer.
  const returned = app.sandbox.pushRibbonRow(history, [13, 14, 15, 16], rows, cols);
  assert.strictEqual(returned, history, 'pushRibbonRow must return the same buffer it mutated');
  assert.strictEqual(history.length, cols * rows, 'the history length must be invariant');
  assert.deepStrictEqual(
    Array.from(history),
    [13, 14, 15, 16, 9, 10, 11, 12, 5, 6, 7, 8],
    'the oldest row must be discarded off the far end'
  );
});

s.test('pushRibbonRow refuses a shape it would scramble, and never overruns', () => {
  const history = new Float32Array(12);
  history.fill(0.5);
  const snapshot = Array.from(history);

  // rows*cols must equal the buffer length or the mesh mapping is wrong.
  for (const [rows, cols] of [[3, 5], [4, 4], [0, 4], [3, 0], [-3, -4]]) {
    app.sandbox.pushRibbonRow(history, [1, 2, 3, 4], rows, cols);
    assert.deepStrictEqual(
      Array.from(history),
      snapshot,
      `a ${rows}x${cols} shape against a 12-slot buffer must be refused, not applied`
    );
  }
  for (const bad of [null, undefined, 5, 'history']) {
    assert.doesNotThrow(
      () => app.sandbox.pushRibbonRow(bad, [1, 2], 3, 4),
      `pushRibbonRow(${String(bad)}) must not throw`
    );
  }

  // A short row is zero-filled rather than leaving the previous frame's tail
  // behind (which would smear stale audio across the newest row).
  const short = new Float32Array(8);
  app.sandbox.pushRibbonRow(short, [1, 1, 1, 1], 2, 4);
  app.sandbox.pushRibbonRow(short, [9], 2, 4);
  assert.deepStrictEqual(Array.from(short), [9, 0, 0, 0, 1, 1, 1, 1], 'a short row must zero-fill');

  // An over-long row is truncated, never written past the row boundary.
  const tight = new Float32Array(8);
  app.sandbox.pushRibbonRow(tight, [1, 2, 3, 4, 5, 6, 7, 8, 9], 2, 4);
  assert.deepStrictEqual(Array.from(tight), [1, 2, 3, 4, 0, 0, 0, 0], 'the row overran into row 1');

  // Non-finite values are neutralised so the vertex buffer stays drawable.
  const dirty = new Float32Array(4);
  app.sandbox.pushRibbonRow(dirty, [NaN, Infinity, undefined, 0.25], 1, 4);
  assert.deepStrictEqual(Array.from(dirty), [0, 0, 0, 0.25], 'a non-finite level reached the mesh');
});

/* -------------------------------------------------------------------------- */
/* perspectiveMatrix4                                                         */
/* -------------------------------------------------------------------------- */

s.test('perspectiveMatrix4 is a real column-major perspective, not an identity', () => {
  const m = app.sandbox.perspectiveMatrix4(Math.PI / 4, 2, 1, 11);
  assert.ok(m instanceof Float32Array && m.length === 16, 'a 4x4 matrix is 16 floats');

  const focal = 1 / Math.tan(Math.PI / 8);
  assert.ok(Math.abs(m[0] - focal / 2) < 1e-5, 'm[0] must be focal / aspect');
  assert.ok(Math.abs(m[5] - focal) < 1e-5, 'm[5] must be the focal length');
  assert.ok(Math.abs(m[10] - -12 / 10) < 1e-5, 'm[10] must be (far + near) / (near - far)');
  assert.strictEqual(m[11], -1, 'm[11] must be -1 — this is what makes it a perspective');
  assert.ok(Math.abs(m[14] - -22 / 10) < 1e-5, 'm[14] must be 2 * far * near / (near - far)');
  for (const zero of [1, 2, 3, 4, 6, 7, 8, 9, 12, 13, 15]) {
    assert.strictEqual(m[zero], 0, `m[${zero}] must be 0 in a perspective matrix`);
  }
  // Narrower field of view magnifies; a wider aspect spreads horizontally.
  assert.ok(
    app.sandbox.perspectiveMatrix4(0.4, 1, 0.1, 10)[5] >
      app.sandbox.perspectiveMatrix4(1.4, 1, 0.1, 10)[5],
    'a narrower FOV must produce a larger focal length'
  );
  for (const bad of [[NaN, NaN, NaN, NaN], [0, 0, 0, 0], [-1, -1, -1, -1]]) {
    const safe = app.sandbox.perspectiveMatrix4(bad[0], bad[1], bad[2], bad[3]);
    for (let i = 0; i < 16; i += 1) {
      assert.ok(Number.isFinite(safe[i]), `nonsense arguments produced a non-finite m[${i}]`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Shader sources (static)                                                    */
/* -------------------------------------------------------------------------- */

s.test('both shaders are GLSL ES 3.00 with a precision qualifier and no legacy syntax', () => {
  const shaders = {
    vertex: app.sandbox.RIBBON_VERTEX_SOURCE,
    fragment: app.sandbox.RIBBON_FRAGMENT_SOURCE,
  };
  for (const [name, src] of Object.entries(shaders)) {
    assert.ok(
      src.startsWith('#version 300 es\n'),
      `the ${name} shader must open with #version 300 es — the directive must be the first token`
    );
    assert.ok(
      /^precision\s+(?:highp|mediump|lowp)\s+float\s*;$/m.test(src),
      `the ${name} shader declares no float precision qualifier`
    );
    // GLSL 100 keywords: their presence means the shader would not compile as
    // 300 es at all.
    assert.ok(!/\battribute\b/.test(src), `the ${name} shader uses the GLSL 100 keyword "attribute"`);
    assert.ok(!/\bvarying\b/.test(src), `the ${name} shader uses the GLSL 100 keyword "varying"`);
    assert.ok(!/\bgl_FragColor\b/.test(src), `the ${name} shader uses gl_FragColor, removed in 300 es`);
    assert.ok(!/\btexture2D\s*\(/.test(src), `the ${name} shader uses texture2D, removed in 300 es`);
    assert.ok(/\bin\s+\w+\s+\w+\s*;/.test(src), `the ${name} shader declares no "in" input`);
  }

  // Vertex stage: the amplitude arrives as a per-vertex float input, Z is the
  // row depth, and the cross-section is rotated — the §1.5 twist.
  const vs = shaders.vertex;
  assert.ok(/in\s+vec3\s+aPosition\s*;/.test(vs), 'the vertex shader takes no position input');
  assert.ok(/in\s+float\s+aLevel\s*;/.test(vs), 'the amplitude must arrive as a per-vertex float');
  assert.ok(/uniform\s+mat4\s+uProjection\s*;/.test(vs), 'no projection matrix uniform');
  assert.ok(/uniform\s+float\s+uTwist\s*;/.test(vs), 'no twist uniform — §1.5 requires the twist');
  assert.ok(/\bcos\s*\(/.test(vs) && /\bsin\s*\(/.test(vs), 'the twist must be a real rotation');
  assert.ok(/aLevel\s*\*\s*uLift/.test(vs), 'Y displacement must come from the level input');
  assert.ok(/gl_Position\s*=\s*uProjection\s*\*/.test(vs), 'the vertex must be projected');

  // Fragment stage: a declared output, the smoothed colour uniform, and the
  // wireframe of FDD #11.
  const fs = shaders.fragment;
  assert.ok(/out\s+vec4\s+fragColor\s*;/.test(fs), 'the fragment shader declares no out vec4');
  assert.ok(/uniform\s+vec3\s+uColor\s*;/.test(fs), 'the fragment shader has no uColor uniform');
  assert.ok(/fwidth\s*\(/.test(fs), 'the wireframe needs a derivative to stay one pixel wide');
  assert.ok(/\babs\s*\(\s*vLevel\s*\)/.test(fs), 'brightness must be scaled by the amplitude');
});

s.test('the §1.5 colour anchors appear EXACTLY, in the shader and in the JS', () => {
  const fs = app.sandbox.RIBBON_FRAGMENT_SOURCE;
  assert.ok(
    fs.indexOf(MINOR_LITERAL) !== -1,
    `the fragment shader must contain the minor anchor literally as ${MINOR_LITERAL}`
  );
  assert.ok(
    fs.indexOf(MAJOR_LITERAL) !== -1,
    `the fragment shader must contain the major anchor literally as ${MAJOR_LITERAL}`
  );

  // The GLSL constants and the JS constants must be the same numbers — the
  // shader ages rows toward the neutral, the JS lerps toward the anchors, and
  // a drift between them would make the two halves disagree on screen.
  const parse = (name) => {
    const m = new RegExp(`const\\s+vec3\\s+${name}\\s*=\\s*vec3\\(([^)]*)\\)`).exec(fs);
    assert.ok(m, `the fragment shader declares no const vec3 ${name}`);
    return m[1].split(',').map((n) => parseFloat(n.trim()));
  };
  assert.deepStrictEqual(parse('MODE_MINOR'), MINOR_RGB, 'MODE_MINOR drifted from §1.5');
  assert.deepStrictEqual(parse('MODE_MAJOR'), MAJOR_RGB, 'MODE_MAJOR drifted from §1.5');
  assert.ok(
    /const\s+vec3\s+MODE_NEUTRAL\s*=\s*\(MODE_MINOR\s*\+\s*MODE_MAJOR\)\s*\*\s*0\.5/.test(fs),
    'the shader neutral must be derived from the two anchors, not typed out separately'
  );

  // …and the shader's neutral, dimmed by the uniform the renderer passes, is
  // the same colour valenceToColor() returns when nothing was measured.
  const shaderNeutral = [0, 1, 2].map(
    (c) => ((MINOR_RGB[c] + MAJOR_RGB[c]) / 2) * app.sandbox.RIBBON_NEUTRAL_DIM
  );
  const jsNeutral = app.sandbox.valenceToColor(null);
  for (let c = 0; c < 3; c += 1) {
    assert.ok(
      Math.abs(shaderNeutral[c] - jsNeutral[c]) < 1e-9,
      `channel ${c}: the shader neutral and the JS neutral disagree`
    );
  }

  // The stylesheet cannot own these values (they are GPU floats, not CSS), so
  // they must live in the JS/GLSL strings — never as a CSS hex that
  // high-contrast mode would swap out from under the shader.
  const html = readIndex();
  const style = /<style>([\s\S]*?)<\/style>/i.exec(html)[1];
  assert.strictEqual(style.indexOf('vec3('), -1, 'shader colours must not leak into the stylesheet');
});

/* -------------------------------------------------------------------------- */
/* createRibbonRenderer                                                       */
/* -------------------------------------------------------------------------- */

s.test('createRibbonRenderer compiles, links and wires the program against a stub context', () => {
  const { renderer, gl } = makeRenderer({ cols: 8, rows: 6 });

  assert.strictEqual(renderer.contextOk(), true, `renderer refused a working stub: ${renderer.failureMessage()}`);
  assert.strictEqual(renderer.failureMessage(), null, 'a working context must report no failure');

  const shaderCalls = gl.callsTo('createShader');
  assert.strictEqual(shaderCalls.length, 2, 'exactly one vertex and one fragment shader');
  assert.deepStrictEqual(
    shaderCalls.map((c) => c.args[0]),
    [GL_ENUM.VERTEX_SHADER, GL_ENUM.FRAGMENT_SHADER],
    'the vertex shader must be created first, then the fragment shader'
  );
  assert.strictEqual(gl.callsTo('compileShader').length, 2, 'both shaders must be compiled');
  assert.strictEqual(gl.callsTo('createProgram').length, 1, 'exactly one program');
  assert.strictEqual(gl.callsTo('attachShader').length, 2, 'both shaders must be attached');
  assert.strictEqual(gl.callsTo('linkProgram').length, 1, 'the program must be linked');

  // The sources handed to the driver are the real ones.
  const sources = gl.callsTo('shaderSource').map((c) => c.args[1]);
  assert.strictEqual(sources[0], app.sandbox.RIBBON_VERTEX_SOURCE, 'the vertex source was not uploaded');
  assert.strictEqual(sources[1], app.sandbox.RIBBON_FRAGMENT_SOURCE, 'the fragment source was not uploaded');

  // Compile/link status is actually CHECKED, with the right enum.
  const shaderStatus = gl.callsTo('getShaderParameter').map((c) => c.args[1]);
  assert.deepStrictEqual(shaderStatus, [GL_ENUM.COMPILE_STATUS, GL_ENUM.COMPILE_STATUS], 'COMPILE_STATUS unchecked');
  assert.deepStrictEqual(
    gl.callsTo('getProgramParameter').map((c) => c.args[1]),
    [GL_ENUM.LINK_STATUS],
    'LINK_STATUS unchecked'
  );

  // Every attribute and uniform the shaders declare is looked up.
  const attribs = gl.callsTo('getAttribLocation').map((c) => c.args[1]);
  assert.deepStrictEqual(attribs, ['aPosition', 'aUv', 'aLevel'], `attribute lookups: ${attribs.join(', ')}`);
  // Closed list: every uniform the shaders declare is looked up, and nothing
  // else is. uScrollT joined it in 0.14.0 — it carries the sub-row scroll that
  // slides the history between two REAL captured rows.
  const uniforms = gl.callsTo('getUniformLocation').map((c) => c.args[1]).sort();
  assert.deepStrictEqual(
    uniforms,
    ['uColor', 'uDim', 'uLift', 'uProjection', 'uScrollT', 'uTwist'],
    `uniform lookups: ${uniforms.join(', ')}`
  );

  // Geometry reached the GPU: positions, uvs, levels and the index list.
  const uploads = gl.callsTo('bufferData');
  assert.strictEqual(uploads.length, 4, `expected 4 buffer uploads, saw ${uploads.length}`);
  const geometry = renderer.geometry();
  assert.strictEqual(uploads[0].args[1], geometry.positions, 'positions were not uploaded');
  assert.strictEqual(uploads[1].args[1], geometry.uvs, 'uvs were not uploaded');
  assert.strictEqual(uploads[2].args[2], GL_ENUM.DYNAMIC_DRAW, 'the level buffer must be DYNAMIC_DRAW');
  assert.strictEqual(uploads[3].args[0], GL_ENUM.ELEMENT_ARRAY_BUFFER, 'indices need ELEMENT_ARRAY_BUFFER');
  assert.strictEqual(uploads[3].args[1], geometry.indices, 'the index list was not uploaded');
  assert.strictEqual(
    gl.callsTo('vertexAttribPointer').length,
    3,
    'all three attributes must be pointed at their buffers'
  );
  assert.ok(gl.names().includes('enable'), 'depth testing must be enabled');
});

s.test('createRibbonRenderer reports a compile or link failure instead of drawing garbage', () => {
  const broken = makeRenderer({ glOptions: { compileOk: false } });
  assert.strictEqual(broken.renderer.contextOk(), false, 'a shader that will not compile is not a context');
  assert.ok(
    /compile/i.test(String(broken.renderer.failureMessage())),
    `the failure must name the problem, got "${broken.renderer.failureMessage()}"`
  );
  assert.strictEqual(broken.renderer.renderOnce(), false, 'a broken renderer must not draw');
  assert.strictEqual(broken.renderer.start(), false, 'a broken renderer must not start a loop');

  const unlinked = makeRenderer({ glOptions: { linkOk: false } });
  assert.strictEqual(unlinked.renderer.contextOk(), false, 'a program that will not link is not a context');
  assert.ok(
    /link/i.test(String(unlinked.renderer.failureMessage())),
    `the failure must name the problem, got "${unlinked.renderer.failureMessage()}"`
  );

  // A context that throws mid-setup is caught, not propagated into boot.
  const hostile = makeGlStub();
  hostile.linkProgram = () => {
    throw new Error('driver reset');
  };
  let thrown = null;
  let renderer = null;
  try {
    renderer = app.sandbox.createRibbonRenderer({ canvas: makeCanvas(null), gl: hostile });
  } catch (err) {
    thrown = err;
  }
  assert.strictEqual(thrown, null, 'a throwing driver must not escape the constructor');
  assert.strictEqual(renderer.contextOk(), false, 'a throwing driver must leave contextOk false');
  assert.ok(/driver reset/.test(String(renderer.failureMessage())), 'the driver error must be reported');
});

s.test('no WebGL2 context: the renderer constructs, reports it, and every method is a safe no-op', () => {
  const canvas = makeCanvas(); // getContext() returns null, like a browser without WebGL2
  let renderer = null;
  assert.doesNotThrow(() => {
    renderer = app.sandbox.createRibbonRenderer({ canvas });
  }, 'a missing WebGL2 context must never throw during construction');

  assert.strictEqual(renderer.contextOk(), false, 'contextOk must be false without a context');
  assert.ok(
    /WebGL2/i.test(String(renderer.failureMessage())),
    `the failure message must say what is missing, got "${renderer.failureMessage()}"`
  );
  assert.strictEqual(canvas.contextRequests.length, 1, 'the renderer must actually ask for a context');
  assert.strictEqual(canvas.contextRequests[0].id, 'webgl2', 'it must ask for webgl2, not webgl');

  assert.strictEqual(renderer.renderOnce(), false, 'renderOnce must be a no-op without a context');
  assert.strictEqual(renderer.start(), false, 'start must be refused without a context');
  assert.strictEqual(renderer.isRunning(), false, 'nothing can be running without a context');
  assert.strictEqual(renderer.stop(), false, 'stop must be safe when nothing is running');

  // The history still accumulates, so the feature is off — not broken.
  const frame = new Float32Array(2048);
  frame[10] = 0.5;
  assert.strictEqual(renderer.pushFrame(frame, null), true, 'pushFrame must keep working headlessly');
  assert.strictEqual(renderer.framesPushed(), 1, 'the frame counter must still advance');

  // No canvas at all (and no deps at all) is equally survivable.
  assert.doesNotThrow(() => {
    const bare = app.sandbox.createRibbonRenderer();
    assert.strictEqual(bare.contextOk(), false);
    assert.strictEqual(bare.renderOnce(), false);
    bare.stop();
    bare.reset();
  }, 'createRibbonRenderer() with no deps at all must not throw');
});

s.test('pushFrame writes the newest frame at the front of the history and tracks its level', () => {
  const { renderer } = makeRenderer({ cols: 8, rows: 4 });
  const history = renderer.history();
  assert.strictEqual(history.length, 32, 'the history must be cols * rows levels');

  const first = new Float32Array(64);
  first[3] = 0.8;
  assert.strictEqual(renderer.pushFrame(first, null), true, 'a real frame must be accepted');
  assert.strictEqual(renderer.framesPushed(), 1, 'the frame must be counted');
  let peak = 0;
  for (let i = 0; i < 8; i += 1) peak = Math.max(peak, Math.abs(history[i]));
  assert.ok(Math.abs(peak - 0.8) < 1e-6, 'the frame peak must reach row 0 of the history');

  const second = new Float32Array(64);
  second[40] = -0.4;
  renderer.pushFrame(second, null);
  let oldPeak = 0;
  for (let i = 8; i < 16; i += 1) oldPeak = Math.max(oldPeak, Math.abs(history[i]));
  assert.ok(Math.abs(oldPeak - 0.8) < 1e-6, 'the previous frame must have moved back exactly one row');

  // The smoothed level drives the twist, and it rises with real input.
  assert.ok(renderer.levelNow() > 0, 'a loud frame must raise the smoothed level');
  const loud = renderer.levelNow();
  for (let i = 0; i < 30; i += 1) renderer.pushFrame(new Float32Array(64), null);
  assert.ok(renderer.levelNow() < loud, 'silence must let the smoothed level fall back');

  // Nothing usable pushes nothing.
  assert.strictEqual(renderer.pushFrame(new Float32Array(0), null), false, 'an empty frame is not a frame');
  assert.strictEqual(renderer.pushFrame(null, null), false, 'a null frame is not a frame');

  // reset() is the session boundary: no stale audio survives it.
  renderer.pushFrame(first, { mode: 'major', strength: 1 });
  renderer.reset();
  assert.strictEqual(renderer.framesPushed(), 0, 'reset must clear the frame counter');
  assert.strictEqual(renderer.levelNow(), 0, 'reset must clear the smoothed level');
  for (let i = 0; i < history.length; i += 1) {
    assert.strictEqual(history[i], 0, `reset left level ${i} behind`);
  }
  assert.deepStrictEqual(
    renderer.colorNow(),
    app.sandbox.valenceToColor(null),
    'reset must return the colour to "nothing measured yet"'
  );
});

s.test('renderOnce draws the whole mesh and lerps the colour toward the valence target', () => {
  const { renderer, gl } = makeRenderer({ cols: 8, rows: 6 });
  const geometry = renderer.geometry();

  const start = renderer.colorNow();
  assert.deepStrictEqual(start, app.sandbox.valenceToColor(null), 'a fresh ribbon starts neutral');

  const frame = new Float32Array(64);
  frame[5] = 0.6;
  renderer.pushFrame(frame, { mode: 'major', strength: 1 });
  assert.strictEqual(renderer.renderOnce(), true, 'renderOnce must draw with a working context');

  const draws = gl.callsTo('drawElements');
  assert.strictEqual(draws.length, 1, 'exactly one draw call per rendered frame');
  assert.strictEqual(draws[0].args[0], GL_ENUM.TRIANGLES, 'the mesh is a triangle list');
  assert.strictEqual(draws[0].args[1], geometry.indexCount, 'every triangle must be drawn');
  assert.strictEqual(draws[0].args[2], GL_ENUM.UNSIGNED_SHORT, 'a small mesh uses 16-bit indices');

  // The new levels were uploaded, and the viewport follows the canvas box.
  const sub = gl.callsTo('bufferSubData');
  assert.strictEqual(sub.length, 1, 'the level buffer must be re-uploaded once per dirty frame');
  assert.strictEqual(sub[0].args[2], renderer.history(), 'the level upload must be the live history');
  const viewport = gl.callsTo('viewport')[0].args;
  assert.deepStrictEqual(viewport, [0, 0, 320, 190], `viewport should match the canvas box, got ${viewport}`);
  assert.ok(gl.names().includes('clear'), 'the frame must be cleared before drawing');

  // Uniforms carry the interpolated colour, the twist and the neutral dim.
  const colorUniform = gl.callsTo('uniform3f').pop().args;
  const painted = [colorUniform[1], colorUniform[2], colorUniform[3]];
  assert.deepStrictEqual(painted, Array.from(renderer.colorNow()), 'uColor must be the renderer colour');
  const matrix = gl.callsTo('uniformMatrix4fv').pop().args;
  assert.strictEqual(matrix[1], false, 'the matrix is already column-major; it must not be transposed');
  assert.strictEqual(matrix[2].length, 16, 'a 4x4 matrix must be uploaded');

  // §1.5 colour interpolation: about 5% of the remaining distance per frame,
  // so a key change washes in rather than snapping.
  const target = app.sandbox.valenceToColor({ mode: 'major', strength: 1 });
  const afterOne = renderer.colorNow();
  const step = app.sandbox.RIBBON_COLOR_LERP;
  assert.ok(step > 0 && step <= 0.1, `the lerp step must be gentle, got ${step}`);
  for (let c = 0; c < 3; c += 1) {
    const expected = start[c] + (target[c] - start[c]) * step;
    assert.ok(
      Math.abs(afterOne[c] - expected) < 1e-9,
      `channel ${c} moved ${afterOne[c] - start[c]} instead of ${expected - start[c]}`
    );
  }
  assert.ok(distance(afterOne, target) > 0.01, 'one frame must NOT arrive at the target');

  // …and it does converge.
  for (let i = 0; i < 400; i += 1) renderer.renderOnce();
  assert.ok(
    distance(renderer.colorNow(), target) < 1e-3,
    `the colour never converged: ${renderer.colorNow()} vs ${target}`
  );

  // A frame with no new levels does not re-upload the level buffer.
  const uploadsBefore = gl.callsTo('bufferSubData').length;
  renderer.renderOnce();
  assert.strictEqual(
    gl.callsTo('bufferSubData').length,
    uploadsBefore,
    'an unchanged history must not be re-uploaded every frame'
  );
});

s.test('the twist uniform rises with the measured level and is zero in silence', () => {
  const { renderer, gl } = makeRenderer({ cols: 8, rows: 6 });

  renderer.renderOnce();
  const quiet = gl.callsTo('uniform1f').filter((c) => c.args[0].name === 'uTwist').pop().args[1];
  assert.strictEqual(quiet, 0, 'an untouched ribbon must not twist');

  const loud = new Float32Array(64);
  for (let i = 0; i < loud.length; i += 1) loud[i] = i % 2 === 0 ? 0.9 : -0.9;
  for (let i = 0; i < 20; i += 1) renderer.pushFrame(loud, null);
  renderer.renderOnce();
  const twisted = gl.callsTo('uniform1f').filter((c) => c.args[0].name === 'uTwist').pop().args[1];
  assert.ok(twisted > quiet, 'a loud performance must twist the ribbon');
  assert.ok(
    twisted <= app.sandbox.RIBBON_MAX_TWIST + 1e-9,
    `the twist must stay inside its documented cap, got ${twisted}`
  );

  // The dim uniform ties the shader's neutral to the JS constant.
  const dim = gl.callsTo('uniform1f').filter((c) => c.args[0].name === 'uDim').pop().args[1];
  assert.strictEqual(dim, app.sandbox.RIBBON_NEUTRAL_DIM, 'uDim must carry the JS neutral dim factor');
});

s.test('start/stop are idempotent and the loop only runs between them', () => {
  const { renderer, gl, clock } = makeRenderer({ cols: 8, rows: 6 });

  assert.strictEqual(renderer.isRunning(), false, 'a fresh renderer must be idle — no idle GPU burn');
  assert.strictEqual(renderer.stop(), false, 'stopping an idle renderer is a no-op');

  assert.strictEqual(renderer.start(), true, 'start must report that it started the loop');
  assert.strictEqual(renderer.isRunning(), true, 'isRunning must reflect the loop');
  assert.strictEqual(clock.pending.length, 1, 'exactly one frame must be scheduled');

  assert.strictEqual(renderer.start(), false, 'a second start must be refused, not stacked');
  assert.strictEqual(clock.pending.length, 1, 'a double start must not double the loop');

  const before = gl.callsTo('drawElements').length;
  clock.flush(5);
  const drawn = gl.callsTo('drawElements').length - before;
  assert.strictEqual(drawn, 5, `five scheduled frames must draw five times, drew ${drawn}`);
  assert.strictEqual(clock.pending.length, 1, 'the loop must keep exactly one frame in flight');

  assert.strictEqual(renderer.stop(), true, 'stop must report that it stopped the loop');
  assert.strictEqual(renderer.isRunning(), false, 'isRunning must go false');
  assert.strictEqual(clock.cancelled.length, 1, 'the pending frame must be cancelled, not left to fire');
  assert.strictEqual(renderer.stop(), false, 'a second stop must be a no-op');

  const afterStop = gl.callsTo('drawElements').length;
  clock.flush(5);
  assert.strictEqual(
    gl.callsTo('drawElements').length,
    afterStop,
    'nothing may be drawn after stop() — that is the whole point of stopping'
  );

  // Restartable.
  assert.strictEqual(renderer.start(), true, 'the loop must be restartable');
  clock.flush(1);
  assert.ok(gl.callsTo('drawElements').length > afterStop, 'a restarted loop must draw again');
  renderer.stop();

  // A callback that fires after stop (a frame already in the host queue) must
  // not resurrect the loop.
  const late = makeRenderer({ cols: 8, rows: 6 });
  late.renderer.start();
  const job = late.clock.pending.shift();
  late.renderer.stop();
  const drawsBefore = late.gl.callsTo('drawElements').length;
  job.callback(0);
  assert.strictEqual(
    late.gl.callsTo('drawElements').length,
    drawsBefore,
    'a late animation callback must not draw after stop()'
  );
  assert.strictEqual(late.clock.pending.length, 0, 'a late callback must not reschedule itself');
});

s.test('without an injected animation clock the loop is refused rather than faked', () => {
  const { renderer } = makeRenderer({ cols: 8, rows: 6, noClock: true });
  assert.strictEqual(renderer.contextOk(), true, 'the context is fine; only the clock is missing');
  assert.strictEqual(renderer.start(), false, 'no rAF means no loop, and start must say so');
  assert.strictEqual(renderer.isRunning(), false, 'nothing may claim to be running');
  // Manual rendering still works, which is what boot uses for the resting frame.
  assert.strictEqual(renderer.renderOnce(), true, 'renderOnce must still work without a clock');
});

/* -------------------------------------------------------------------------- */
/* formatAnalysis: the key chip                                               */
/* -------------------------------------------------------------------------- */

s.test('formatAnalysis reports a measured key and refuses to name an unmeasured one', () => {
  const format = app.sandbox.formatAnalysis;

  assert.strictEqual(
    format({ valence: { root: 0, rootName: 'C', mode: 'major', strength: 0.87 } }).valence,
    'C major 87%',
    'a measured key must read as root, mode and the confidence behind it'
  );
  assert.strictEqual(
    format({ valence: { root: 9, rootName: 'A', mode: 'minor', strength: 1 } }).valence,
    'A minor 100%',
    'a fully-confident minor must read as 100%'
  );
  assert.strictEqual(
    format({ valence: { root: 0, rootName: 'C', mode: null, strength: 0 } }).valence,
    'C · no third',
    'a root with no third must say so rather than picking a mode'
  );
  for (const nothing of [undefined, null, {}, { valence: null }, { valence: {} }, { valence: 'C major' }]) {
    const view = format(nothing && nothing.valence !== undefined ? nothing : { valence: nothing });
    assert.strictEqual(view.valence, '—', `${JSON.stringify(nothing)} must degrade to an em dash`);
  }

  // The pre-existing fields are untouched by the addition.
  const full = format({ rms: 0.1234, gated: false, pitchHz: 440, midiNote: 69, bpm: 123.6, valence: null });
  assert.strictEqual(full.pitch, '440.0 Hz A4', 'the pitch chip regressed');
  assert.strictEqual(full.rms, '0.12', 'the rms chip regressed');
  assert.strictEqual(full.bpm, '124', 'the bpm chip regressed');
  assert.strictEqual(full.gated, false, 'the gated flag regressed');
});

/* -------------------------------------------------------------------------- */
/* Static markup + wiring contracts                                           */
/* -------------------------------------------------------------------------- */

s.test('the canvas ships inside the Hum view with real accessible fallback content', () => {
  const html = readIndex();

  const humStart = html.indexOf('id="view-hum"');
  const editorStart = html.indexOf('id="view-editor"');
  assert.ok(humStart !== -1 && editorStart > humStart, 'the view order changed');
  const humMarkup = html.slice(humStart, editorStart);

  assert.ok(humMarkup.indexOf('id="viz-ribbon"') !== -1, '#viz-ribbon must live inside the Hum view');
  assert.ok(humMarkup.indexOf('id="viz-note"') !== -1, '#viz-note must live beside the canvas');
  assert.ok(humMarkup.indexOf('id="metric-valence"') !== -1, 'the key chip must live in the Hum view');

  const canvas = /<canvas\b([\s\S]*?)<\/canvas>/i.exec(humMarkup);
  assert.ok(canvas, 'no <canvas> element in the Hum view');
  assert.ok(/id="viz-ribbon"/.test(canvas[1]), 'the canvas must be #viz-ribbon');
  assert.ok(/aria-label="[^"]{40,}"/.test(canvas[1]), 'the canvas needs a descriptive aria-label');
  assert.ok(/role="img"/.test(canvas[1]), 'a canvas that shows a picture must be role="img"');

  // Canvas fallback content is what a browser that cannot draw it shows, so it
  // has to be a real sentence pointing at the text readouts — not a placeholder.
  const fallback = canvas[1].slice(canvas[1].indexOf('>') + 1).trim();
  assert.ok(fallback.length > 60, `the canvas fallback text is too thin to be useful: "${fallback}"`);
  assert.ok(/WebGL2/.test(fallback), 'the fallback should name what is missing');
});

s.test('the visualizer styles are token-driven and survive High-Contrast mode', () => {
  const html = readIndex();
  const style = /<style>([\s\S]*?)<\/style>/i.exec(html)[1];

  const card = /\.viz-canvas\s*\{([^}]*)\}/.exec(style);
  assert.ok(card, 'no .viz-canvas rule');
  assert.ok(/var\(--/.test(card[1]), 'the canvas surface must be token-driven like every other surface');
  assert.ok(/\.viz-canvas\[hidden\]\s*\{[^}]*display:\s*none/.test(style), '[hidden] must beat display:block');
  assert.ok(/\.viz-note\[hidden\]\s*\{[^}]*display:\s*none/.test(style), 'the note must be hideable');

  // FDD #17 keeps meaning visible: high-contrast must not hide the canvas —
  // it is content, not chrome.
  assert.ok(
    !/\.high-contrast[^{]*\.viz-canvas[^{]*\{[^}]*display:\s*none/.test(style),
    'High-Contrast mode must not hide the visualizer'
  );
});

s.test('boot binds the ribbon to the capture pipeline, and only animates while live', () => {
  const source = extractScriptById(INDEX, 'app-main');

  // The frame must be handed to the ribbon BEFORE the buffer is transferred to
  // the worker — a transferred ArrayBuffer is detached and its samples are gone.
  const pushAt = source.indexOf('ribbon.pushFrame(chunk.samples');
  const postAt = source.indexOf("type: 'analyze'");
  assert.ok(pushAt !== -1, 'boot never feeds captured frames into the ribbon');
  assert.ok(
    postAt !== -1 && pushAt < postAt,
    'the ribbon must read the frame before it is transferred to the worker, or it reads a detached buffer'
  );

  // The valence from the worker's analysis reply is what colours it.
  assert.ok(
    /lastValence\s*=\s*data\.valence\s*\|\|\s*null/.test(source),
    "boot must take the ribbon's colour from the worker's 'analysis' reply"
  );
  assert.ok(
    /ribbon\.pushFrame\(chunk\.samples,\s*lastValence\)/.test(source),
    'pushFrame must receive the measured valence, not a constant'
  );

  // rAF runs only while capture is live.
  assert.ok(
    /if\s*\(state === 'live'\)\s*\{\s*ribbon\.start\(\);/.test(source),
    'the loop must start when capture goes live'
  );
  assert.ok(
    /\}\s*else\s*\{\s*ribbon\.stop\(\);/.test(source),
    'the loop must stop for every non-live state — an idle tab must not burn the GPU'
  );
  assert.ok(/ribbon\.reset\(\)/.test(source), 'a new capture session must start from an empty ribbon');

  // The honest note, verbatim, for a browser without WebGL2.
  assert.ok(
    source.indexOf('WebGL2 not available — 3D visualizer disabled') !== -1,
    'the documented WebGL2-unavailable message is missing'
  );
  assert.ok(
    /vizCanvas\.hidden = true/.test(source),
    'the canvas must be hidden when there is no context to draw into'
  );

  // Zero-dependency check: raw WebGL only, no smuggled library. §1.5 allows an
  // "embedded lightweight Three.js"; this build deliberately does not take that
  // option, so nothing may quietly reintroduce it. Comments are stripped first
  // — the header comment that RULES THE LIBRARY OUT must not read as using it.
  // (The [^:] guard keeps `http://` out of the line-comment rule.)
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/\bTHREE\s*\./.test(code), 'no THREE.* API may appear in this file');
  assert.ok(!/three\.js/i.test(code), 'no Three.js may be embedded in this file');
  assert.ok(/getContext\('webgl2'/.test(source), 'the renderer must ask for a raw WebGL2 context');
});

/* -------------------------------------------------------------------------- *
 * 0.14.0 ribbon refinement.
 *
 * The theme of this release is HONESTY BEFORE POLISH: the twist is gated at a
 * real noise floor, one shared response curve replaces three linear ceilings,
 * the stopped ribbon settles to neutral instead of freezing a vivid frame, and
 * the reduced-motion preference reaches the only spinning thing on the panel.
 * The polish that follows (sub-row scroll, analytic lighting, fog, vignette)
 * is only defensible on top of that, which is why it is tested after it.
 * -------------------------------------------------------------------------- */

/** makeRenderer with every dependency overridable — clock, motion, sizing. */
function makeRendererWith(extra) {
  const gl = makeGlStub();
  const clock = makeClock();
  const renderer = app.sandbox.createRibbonRenderer(
    Object.assign(
      {
        canvas: makeCanvas(null),
        gl,
        cols: 8,
        rows: 6,
        raf: clock.raf,
        caf: clock.caf,
        devicePixelRatio: 1,
      },
      extra || {}
    )
  );
  return { renderer, gl, clock };
}

/** The last value a named float uniform was given. */
function lastUniform(gl, name) {
  const calls = gl.callsTo('uniform1f').filter((c) => c.args[0] && c.args[0].name === name);
  return calls.length ? calls[calls.length - 1].args[1] : undefined;
}

/** A frame whose every downsampled bucket ends up at ±level. */
function squareFrame(level, length) {
  const frame = new Float32Array(length || 64);
  for (let i = 0; i < frame.length; i += 1) frame[i] = i % 2 === 0 ? level : -level;
  return frame;
}

s.test('the 0.14.0 ribbon helpers and their constants are reachable and sane', () => {
  for (const name of [
    'ribbonAmplitudeResponse',
    'ribbonRowDrive',
    'ribbonScrollOffset',
    'ribbonTwistCap',
    'ribbonSurfaceSize',
  ]) {
    assert.strictEqual(
      typeof app.sandbox[name],
      'function',
      `${name} is not reachable as a top-level function declaration`
    );
  }

  const S = app.sandbox;
  assert.ok(S.RIBBON_NOISE_FLOOR > 0, 'a floor of zero gates nothing');
  assert.ok(S.RIBBON_NOISE_FLOOR < 0.1, `a floor of ${S.RIBBON_NOISE_FLOOR} would swallow a quiet hum`);
  // The worker gates the CHIPS at RMS_GATE = 0.015 over a full frame. This one
  // is compared against the largest magnitude in the frame, and the peak of a
  // signal is always the larger number — copying the constant across would be
  // comparing two different quantities and calling it agreement.
  assert.notStrictEqual(
    S.RIBBON_NOISE_FLOOR,
    0.015,
    'the peak-domain floor must not be a copy of the worker RMS gate'
  );
  assert.ok(S.RIBBON_RMS_DRIVE > 1, 'the RMS drive has to make up for RMS being below peak');
  assert.ok(S.RIBBON_RESPONSE_KNEE > 0, 'a knee of zero is a division by zero, not a curve');
  assert.ok(
    S.RIBBON_REDUCED_TWIST_SCALE >= 0 && S.RIBBON_REDUCED_TWIST_SCALE < 1,
    'reduced motion must reduce the twist, not amplify it'
  );
  assert.ok(
    S.RIBBON_SETTLE_FRAMES > 0 && S.RIBBON_SETTLE_FRAMES <= 90,
    `the settle must be bounded and short, got ${S.RIBBON_SETTLE_FRAMES} frames`
  );
  assert.ok(S.RIBBON_MAX_ROW_GAP_MS > 100, 'the stall threshold must be well past a normal chunk');
  assert.ok(S.RIBBON_GAP_LERP > 0 && S.RIBBON_GAP_LERP <= 1, 'the cadence EMA needs a real weight');
});

s.test('ribbonAmplitudeResponse is a soft knee rooted at EXACTLY zero', () => {
  const f = app.sandbox.ribbonAmplitudeResponse;

  // The anti-simulation edge: no input, no output. Not 1e-9 — zero.
  assert.strictEqual(f(0), 0, 'silence must map to exactly 0, never a small pretend value');
  assert.strictEqual(f(1), 1, 'full scale must map to exactly 1, so the twist cap still holds');

  // Monotonic, and never outside the unit range.
  let previous = -1;
  for (let i = 0; i <= 100; i += 1) {
    const y = f(i / 100);
    assert.ok(y >= previous, `the curve dips at x=${i / 100}`);
    assert.ok(y >= 0 && y <= 1, `x=${i / 100} left the unit range at ${y}`);
    previous = y;
  }

  // It is a KNEE, not a line: quiet input gains contrast.
  for (const x of [0.05, 0.1, 0.2, 0.4]) {
    assert.ok(f(x) > x, `a soft knee must lift quiet input; f(${x}) = ${f(x)}`);
  }
  assert.ok(f(0.1) / 0.1 > 1.5, 'a 10% signal should be visibly more than 10% of the twist');

  // Nonsense in, clamped out — never NaN on the GPU path.
  assert.strictEqual(f(-3), 0, 'a negative amplitude is not motion');
  assert.strictEqual(f(9), 1, 'past full scale is still full scale');
  assert.strictEqual(f(NaN), 0, 'NaN must not reach a uniform');
  assert.strictEqual(f(undefined), 0, 'a missing amplitude is silence');
});

s.test('ribbonRowDrive gates mic hiss to exactly zero and follows RMS, not a lone spike', () => {
  const drive = app.sandbox.ribbonRowDrive;
  const floor = app.sandbox.RIBBON_NOISE_FLOOR;

  // 1. THE GATE. A silent room and a hissing microphone both read nothing,
  //    because the chips beside the ribbon read nothing.
  assert.strictEqual(drive(new Float32Array(8)), 0, 'silence must not twist the ribbon');
  const hiss = new Float32Array(8);
  for (let i = 0; i < hiss.length; i += 1) hiss[i] = (i % 2 === 0 ? 1 : -1) * (floor * 0.9);
  assert.strictEqual(drive(hiss), 0, 'noise below the floor must be exactly 0, not merely small');

  // …and the gate is a floor, not a wall: real quiet signal still moves.
  const quiet = new Float32Array(8);
  for (let i = 0; i < quiet.length; i += 1) quiet[i] = (i % 2 === 0 ? 1 : -1) * (floor * 3);
  assert.ok(drive(quiet) > 0, 'a quiet hum above the floor must still drive the twist');

  // 2. RMS, NOT PEAK. Two rows with the SAME peak — one lone transient, one
  //    sustained tone. The old peak*2.2 rule scored them identically; loudness
  //    does not work that way and neither does the level chip.
  const spike = new Float32Array(8);
  spike[0] = 0.35;
  const sustained = new Float32Array(8);
  for (let i = 0; i < sustained.length; i += 1) sustained[i] = i % 2 === 0 ? 0.35 : -0.35;
  assert.ok(
    drive(sustained) > drive(spike) + 0.2,
    `same peak, very different loudness: spike ${drive(spike)} vs sustained ${drive(sustained)}`
  );
  assert.ok(drive(spike) > 0, 'a real transient is still real — it just is not full twist');

  // 3. BOUNDED. Whatever arrives, the twist cap survives.
  const clipping = new Float32Array(8).fill(1);
  assert.strictEqual(drive(clipping), 1, 'a full-scale row must saturate at exactly 1');
  const over = new Float32Array(8).fill(4);
  assert.strictEqual(drive(over), 1, 'a hot buffer must clamp, not overshoot the cap');

  // 4. GARBAGE-SAFE. A NaN in the buffer must not poison the uniform.
  const dirty = new Float32Array(8);
  dirty[0] = NaN;
  dirty[1] = 0.5;
  dirty[2] = 0.5;
  const value = drive(dirty);
  assert.ok(isFinite(value) && value > 0, `a NaN sample must be skipped, got ${value}`);
  assert.strictEqual(drive(null), 0, 'no row is no drive');
  assert.strictEqual(drive(new Float32Array(0)), 0, 'an empty row is no drive');
});

s.test('ribbonScrollOffset interpolates between two REAL rows and never past one', () => {
  const offset = app.sandbox.ribbonScrollOffset;

  // One row gap in the same 0..1 units the mesh uses — read off the real
  // geometry rather than re-typed, so a grid change cannot desync them.
  const geometry = app.sandbox.buildRibbonGeometry(4, 5);
  const gap = geometry.positions[4 * 3 + 2] - geometry.positions[2];
  assert.ok(Math.abs(gap - 1 / 4) < 1e-9, `row spacing sanity: ${gap}`);

  assert.strictEqual(offset(0, 46, 5), 0, 'the instant a row lands the offset is zero');
  assert.ok(Math.abs(offset(23, 46, 5) - gap * 0.5) < 1e-9, 'half an interval is half a row');
  assert.ok(
    Math.abs(offset(46, 46, 5) - gap) < 1e-9,
    'a full interval must land EXACTLY where pushRibbonRow will put the row'
  );

  // A stall parks on the rows; it never slides off into a position no data
  // supports, and it never runs backwards.
  assert.ok(Math.abs(offset(5000, 46, 5) - gap) < 1e-9, 'a stalled capture must clamp at one row');
  assert.strictEqual(offset(-20, 46, 5), 0, 'a clock that went backwards offsets nothing');

  // Nothing to interpolate along means no interpolation, not a guess.
  assert.strictEqual(offset(23, 0, 5), 0, 'no measured cadence, no scroll');
  assert.strictEqual(offset(23, NaN, 5), 0, 'a nonsense cadence must not reach the GPU');
  assert.strictEqual(offset(23, 46, 1), 0, 'a one-row mesh has no gap to slide along');
  assert.strictEqual(offset(23, 46, 0), 0, 'a zero-row mesh has no gap to slide along');

  // Monotonic across the interval.
  let previous = -1;
  for (let ms = 0; ms <= 60; ms += 1) {
    const y = offset(ms, 46, 96);
    assert.ok(y >= previous, `the scroll went backwards at ${ms} ms`);
    assert.ok(y <= 1 / 95 + 1e-12, `the scroll passed one row gap at ${ms} ms`);
    previous = y;
  }
});

s.test('ribbonTwistCap defaults to the full cap and only reduced motion scales it', () => {
  const cap = app.sandbox.ribbonTwistCap;
  const max = app.sandbox.RIBBON_MAX_TWIST;

  // DEFAULT OFF, deliberately: a renderer built with no opinion about motion
  // twists exactly as much as it always did.
  assert.strictEqual(cap(false), max, 'no preference means the full documented cap');
  assert.strictEqual(cap(undefined), max, 'an unset preference is not a preference');
  assert.strictEqual(cap(null), max, 'a null preference is not a preference');
  assert.strictEqual(cap('true'), max, 'only a real boolean true may reduce the motion');

  const reduced = cap(true);
  assert.ok(reduced < max, 'prefers-reduced-motion must actually reduce the spin');
  assert.ok(reduced >= 0, 'the cap can never go negative');
  assert.strictEqual(reduced, max * app.sandbox.RIBBON_REDUCED_TWIST_SCALE, 'the scale is the contract');
});

s.test('ribbonSurfaceSize is the DPR buffer maths: capped, rounded, honest about no box', () => {
  const maxDpr = app.sandbox.RIBBON_MAX_DPR;
  // The sandbox has its own Object realm, so compare the numbers, not the box.
  const size = (w, h, r) => {
    const out = app.sandbox.ribbonSurfaceSize(w, h, r);
    return out === null ? null : { width: out.width, height: out.height, dpr: out.dpr };
  };

  assert.deepStrictEqual(size(320, 190, 1), { width: 320, height: 190, dpr: 1 }, '1x is 1:1');
  assert.deepStrictEqual(size(320, 190, 2), { width: 640, height: 380, dpr: 2 }, 'retina doubles the buffer');

  // Retina is worth paying for; a phone's 3x is not.
  const capped = size(320, 190, 3);
  assert.strictEqual(capped.dpr, maxDpr, `3x must be capped at ${maxDpr}`);
  assert.deepStrictEqual(
    [capped.width, capped.height],
    [320 * maxDpr, 190 * maxDpr],
    'the capped ratio must be what actually sizes the buffer'
  );
  assert.strictEqual(size(1280, 190, 2).width, 2560, 'a 1280 px canvas at DPR 2 is a 2560 px buffer');

  // A hidden view reports a 0x0 box. Saying so lets the caller skip the frame
  // instead of allocating a 1x1 buffer it would immediately throw away.
  assert.strictEqual(size(0, 190, 2), null, 'a zero-width box is not a box');
  assert.strictEqual(size(320, 0, 2), null, 'a zero-height box is not a box');
  assert.strictEqual(size(NaN, 190, 2), null, 'a nonsense box is not a box');
  assert.strictEqual(size(undefined, undefined, 2), null, 'no box at all is not a box');

  // Sub-pixel CSS boxes round, and never round away to nothing.
  assert.deepStrictEqual(size(100.4, 50.6, 1), { width: 100, height: 51, dpr: 1 });
  assert.deepStrictEqual(size(0.2, 0.2, 1), { width: 1, height: 1, dpr: 1 }, 'never a zero-pixel buffer');

  // A missing or broken ratio falls back to 1 rather than to zero pixels.
  assert.strictEqual(size(320, 190, 0).dpr, 1, 'a zero ratio is not a ratio');
  assert.strictEqual(size(320, 190, NaN).dpr, 1, 'a NaN ratio is not a ratio');
});

s.test('mic hiss does not twist the ribbon, but is still drawn as the sample it was', () => {
  const { renderer, gl } = makeRendererWith({});
  const floor = app.sandbox.RIBBON_NOISE_FLOOR;

  const hiss = squareFrame(floor * 0.6);
  for (let i = 0; i < 40; i += 1) renderer.pushFrame(hiss, null);
  renderer.renderOnce();

  assert.strictEqual(
    lastUniform(gl, 'uTwist'),
    0,
    'the ribbon must not writhe on noise the chips above it are reporting as nothing'
  );
  assert.strictEqual(renderer.levelNow(), 0, 'the smoothed level must be exactly 0, not merely small');

  // The GATE is on the claim, not on the record: those samples were really
  // captured, so they are really on the mesh.
  assert.strictEqual(renderer.framesPushed(), 40, 'gated frames are still frames');
  const history = renderer.history();
  let peak = 0;
  for (let i = 0; i < 8; i += 1) peak = Math.max(peak, Math.abs(history[i]));
  assert.ok(peak > 0, 'the captured samples must still reach the geometry');

  // And the floor is not a wall.
  const audible = squareFrame(floor * 4);
  renderer.pushFrame(audible, null);
  assert.ok(renderer.levelNow() > 0, 'a hum above the floor must move the ribbon again');
});

s.test('the reduced-motion dependency scales the twist and nothing else', () => {
  const loud = squareFrame(0.9);
  const feed = (r) => {
    for (let i = 0; i < 20; i += 1) r.pushFrame(loud, { mode: 'major', strength: 1 });
    r.renderOnce();
  };

  const full = makeRendererWith({ reducedMotion: false });
  const easy = makeRendererWith({ reducedMotion: true });
  feed(full.renderer);
  feed(easy.renderer);

  const twistFull = lastUniform(full.gl, 'uTwist');
  const twistEasy = lastUniform(easy.gl, 'uTwist');
  assert.ok(twistFull > 0.5, `the control renderer must really be twisting, got ${twistFull}`);
  assert.ok(twistEasy < twistFull, 'reduced motion must take the spin out');
  assert.ok(
    Math.abs(twistEasy - twistFull * app.sandbox.RIBBON_REDUCED_TWIST_SCALE) < 1e-12,
    'the reduction must be exactly the documented scale'
  );

  // NO MEASUREMENT CUE IS LOST. Height, colour and the neutral dim are
  // readouts, not decoration, so reduced motion leaves them alone.
  assert.strictEqual(lastUniform(easy.gl, 'uLift'), lastUniform(full.gl, 'uLift'), 'the lift must survive');
  assert.strictEqual(lastUniform(easy.gl, 'uDim'), lastUniform(full.gl, 'uDim'), 'the dim must survive');
  assert.deepStrictEqual(
    easy.renderer.colorNow(),
    full.renderer.colorNow(),
    'the valence colour must survive reduced motion'
  );
  assert.ok(easy.renderer.levelNow() > 0, 'the measured level itself is untouched — only its cap moves');

  // The preference is read PER FRAME, so toggling the OS setting takes effect
  // without rebuilding the renderer (the stylesheet already behaves that way).
  let reduced = false;
  const live = makeRendererWith({ reducedMotion: () => reduced });
  feed(live.renderer);
  const before = lastUniform(live.gl, 'uTwist');
  reduced = true;
  live.renderer.renderOnce();
  const after = lastUniform(live.gl, 'uTwist');
  assert.ok(after < before, 'flipping the preference must reach the very next frame');
});

s.test('uScrollT slides the history between two real rows, and stays 0 without a cadence', () => {
  let clock = 1000;
  const { renderer, gl } = makeRendererWith({ cols: 8, rows: 5, now: () => clock });
  const scroll = () => lastUniform(gl, 'uScrollT');
  const gap = 1 / 4;
  const frame = new Float32Array(64);
  frame[3] = 0.6;

  renderer.renderOnce();
  assert.strictEqual(scroll(), 0, 'nothing has landed yet, so nothing may slide');

  renderer.pushFrame(frame, null);
  clock += 8;
  renderer.renderOnce();
  assert.strictEqual(scroll(), 0, 'one row is not a cadence — there is no interval to interpolate along');

  clock += 38; // the second row lands 46 ms after the first: a measured interval
  renderer.pushFrame(frame, null);
  assert.strictEqual(scroll(), 0, 'a fresh row starts the interval at zero');

  clock += 23;
  renderer.renderOnce();
  assert.ok(Math.abs(scroll() - gap * 0.5) < 1e-9, `half an interval is half a row, got ${scroll()}`);
  assert.strictEqual(renderer.scrollNow(), scroll(), 'scrollNow must mirror what the GPU was given');

  clock += 23;
  renderer.renderOnce();
  assert.ok(
    Math.abs(scroll() - gap) < 1e-9,
    'a full interval must land exactly on the next row, so the discrete push is seamless'
  );

  clock += 5000;
  renderer.renderOnce();
  assert.ok(Math.abs(scroll() - gap) < 1e-9, 'a stalled capture parks on the rows, it does not drift');

  // A stall must not be MEASURED as a cadence either — otherwise the ribbon
  // would creep along an interval nobody is producing rows at.
  renderer.reset();
  renderer.renderOnce();
  assert.strictEqual(scroll(), 0, 'reset must forget the cadence with the history');
  renderer.pushFrame(frame, null);
  clock += 900; // longer than RIBBON_MAX_ROW_GAP_MS: a stall, not a rhythm
  renderer.pushFrame(frame, null);
  clock += 20;
  renderer.renderOnce();
  assert.strictEqual(scroll(), 0, 'a stalled gap must not seed a phantom cadence');
});

s.test('settle() drains the twist and the valence claim over a bounded run, then stops itself', () => {
  const { renderer, gl, clock } = makeRendererWith({});
  const neutral = app.sandbox.valenceToColor(null);
  const loud = squareFrame(0.9);
  for (let i = 0; i < 20; i += 1) renderer.pushFrame(loud, { mode: 'major', strength: 1 });
  renderer.start();
  clock.flush(60);
  renderer.stop();

  const liveTwist = renderer.twistNow();
  const liveColor = renderer.colorNow();
  const recorded = Array.from(renderer.history());
  assert.ok(liveTwist > 0.5, `the live ribbon must really be twisted, got ${liveTwist}`);
  assert.ok(distance(liveColor, neutral) > 0.1, 'the live ribbon must really be carrying a mode colour');

  assert.strictEqual(renderer.settle(), true, 'settle must report that it armed the drain');
  assert.strictEqual(renderer.isRunning(), false, 'settling is NOT the live loop');
  assert.strictEqual(renderer.isSettling(), true, 'and it must say what it is doing');

  const ran = clock.flush(500);
  assert.ok(
    ran <= app.sandbox.RIBBON_SETTLE_FRAMES,
    `the drain must be bounded, ran ${ran} frames of ${app.sandbox.RIBBON_SETTLE_FRAMES}`
  );
  assert.strictEqual(clock.pending.length, 0, 'a settle that ended must leave NOTHING scheduled');
  assert.strictEqual(renderer.isSettling(), false, 'the countdown must reach zero on its own');

  // The CLAIM drains…
  assert.ok(
    renderer.twistNow() < liveTwist * 0.05,
    `the twist must relax, went from ${liveTwist} to ${renderer.twistNow()}`
  );
  // The drain has to ARRIVE, not stop most of the way there: a ribbon still
  // leaning cyan beside a chip reading "—" is the exact disagreement settle()
  // exists to remove. RIBBON_SETTLE_FRAMES is sized off RIBBON_COLOR_LERP for
  // precisely this assertion.
  assert.ok(
    distance(renderer.colorNow(), neutral) < 0.02,
    `the colour must reach "nothing measured", got ${renderer.colorNow()} vs ${neutral}`
  );
  assert.ok(
    distance(liveColor, neutral) > 0.5,
    'sanity: the live colour really was far from neutral before the drain'
  );
  // …but the RECORD stays. Those samples really were captured.
  assert.deepStrictEqual(
    Array.from(renderer.history()),
    recorded,
    'settling must not erase the waveform that really was measured'
  );

  // No idle GPU burn: once it is over, it is over.
  const drawn = gl.callsTo('drawElements').length;
  clock.flush(20);
  assert.strictEqual(gl.callsTo('drawElements').length, drawn, 'a finished settle must not keep drawing');
});

s.test('a settle never stacks, and start/stop/reset all take the ribbon back off it', () => {
  const { renderer, clock } = makeRendererWith({});
  const loud = squareFrame(0.9);
  for (let i = 0; i < 10; i += 1) renderer.pushFrame(loud, { mode: 'minor', strength: 1 });

  renderer.settle();
  assert.strictEqual(clock.pending.length, 1, 'the drain is one frame at a time');
  renderer.settle();
  assert.strictEqual(clock.pending.length, 1, 'a second settle must restart the countdown, not stack a loop');

  // stop() wins over a settle in flight.
  renderer.stop();
  assert.strictEqual(renderer.isSettling(), false, 'stop must abandon the drain');
  assert.strictEqual(clock.pending.length, 0, 'stop must leave nothing scheduled');

  // A new live session wins over a settle in flight — otherwise the drain would
  // keep pulling the colour away from what is being measured right now.
  renderer.settle();
  assert.strictEqual(renderer.start(), true, 'a settling ribbon must still be startable');
  assert.strictEqual(renderer.isSettling(), false, 'going live must abandon the drain');
  assert.strictEqual(clock.pending.length, 1, 'only the live loop may be scheduled');
  renderer.stop();

  // reset() is the session boundary and clears it too.
  renderer.settle();
  renderer.reset();
  assert.strictEqual(renderer.isSettling(), false, 'reset must abandon the drain');
  assert.strictEqual(clock.pending.length, 0, 'reset must leave nothing scheduled');

  // Without an animation clock there is nothing to drain ALONG, so it lands on
  // the settled state in one frame rather than pretending to animate.
  const headless = makeRendererWith({ raf: undefined, caf: undefined });
  for (let i = 0; i < 10; i += 1) headless.renderer.pushFrame(loud, { mode: 'major', strength: 1 });
  assert.strictEqual(headless.renderer.settle(), false, 'no clock means no animated drain, and it says so');
  assert.strictEqual(headless.renderer.levelNow(), 0, 'it must still arrive at rest');
  assert.deepStrictEqual(
    headless.renderer.colorNow(),
    app.sandbox.valenceToColor(null),
    'and at the "nothing measured" colour'
  );
});

s.test('the shader refinements are wired: sub-row scroll, analytic normal, eye-space fog', () => {
  const vs = app.sandbox.RIBBON_VERTEX_SOURCE;
  const fs = app.sandbox.RIBBON_FRAGMENT_SOURCE;

  // Sub-row scroll offsets the DEPTH, so the whole history slides as one rigid
  // body and lands exactly where pushRibbonRow's discrete shift will put it.
  assert.ok(/uniform\s+float\s+uScrollT\s*;/.test(vs), 'no uScrollT uniform in the vertex stage');
  assert.ok(
    /float\s+depth\s*=\s*aPosition\.z\s*\+\s*uScrollT\s*;/.test(vs),
    'uScrollT must offset the row depth, before the Z placement'
  );

  // The linear amplitude term is UNTOUCHED; the perceptual lift is additive on
  // top of it, so the sample itself is still literally on screen.
  assert.ok(
    /float\s+height\s*=\s*aLevel\s*\*\s*uLift\s*;/.test(vs),
    'the linear height term must stay exactly what it was — the sample is the truth'
  );
  assert.ok(/height\s*\+=/.test(vs), 'the perceptual lift must be ADDED to it, never replace it');
  assert.ok(/sign\s*\(\s*aLevel\s*\)/.test(vs), 'the additive lift must carry the sample sign');
  assert.ok(/pow\s*\(\s*abs\s*\(\s*aLevel\s*\)/.test(vs), 'the additive lift must be a curve on the real level');

  // One eye-space position, shared by the lighting and the fog.
  assert.ok(/out\s+vec3\s+vEyePos\s*;/.test(vs), 'the vertex stage emits no eye-space position');
  assert.ok(
    /vEyePos\s*=\s*eyePos\s*;/.test(vs),
    'vEyePos must be the same eyePos gl_Position is built from, not a second guess'
  );
  assert.ok(/in\s+vec3\s+vEyePos\s*;/.test(fs), 'the fragment stage never receives it');

  // The normal is DERIVED from the surface being rasterised, not authored.
  assert.ok(
    /cross\s*\(\s*dFdx\s*\(\s*vEyePos\s*\)\s*,\s*dFdy\s*\(\s*vEyePos\s*\)\s*\)/.test(fs),
    'the normal must be the derivative of the real geometry'
  );
  // …and the wireframe derivative FDD #11 depends on is still there.
  assert.ok(/fwidth\s*\(\s*cell\s*\)/.test(fs), 'the wireframe still needs fwidth on the cell');

  // Depth cue: a real exponential on a real distance, not a flat UV ramp.
  assert.ok(/length\s*\(\s*vEyePos\s*\)/.test(fs), 'the fog must measure an actual eye-space distance');
  assert.ok(/exp\s*\(\s*-\s*FOG_K/.test(fs), 'the depth cue must be an exponential falloff');
  assert.ok(
    !/1\.0\s*-\s*0\.55\s*\*\s*vUv\.y/.test(fs),
    'the old flat UV depth ramp must be gone, not left alongside the fog'
  );

  // ONE response curve for the whole feature: the same number on both sides.
  const knee = /const\s+float\s+RESPONSE_KNEE\s*=\s*([0-9.]+)\s*;/.exec(fs);
  assert.ok(knee, 'the fragment shader declares no RESPONSE_KNEE');
  assert.strictEqual(
    parseFloat(knee[1]),
    app.sandbox.RIBBON_RESPONSE_KNEE,
    'the shader knee drifted from RIBBON_RESPONSE_KNEE — the twist and the brightness would disagree'
  );
  assert.ok(/softKnee\s*\(/.test(fs), 'the fragment energy must go through the shared response curve');
  assert.ok(/\babs\s*\(\s*vLevel\s*\)/.test(fs), 'brightness must still be scaled by the amplitude');
});

s.test('every fragment shading term is brightness-only, so the §1.5 endpoints survive', () => {
  const fs = app.sandbox.RIBBON_FRAGMENT_SOURCE;

  // THE WHOLE CONTRACT IN ONE LINE. The pixel is the §1.5 colour times a single
  // scalar, and the scalar is clamped BEFORE the multiply. Clamping the scalar
  // keeps the ratio between the channels; letting a channel saturate instead
  // would quietly walk a bright major pixel off vec3(0.0, 0.94, 1.0).
  assert.ok(
    /fragColor\s*=\s*vec4\(\s*aged\s*\*\s*clamp\(\s*lit\s*,\s*0\.0\s*,\s*1\.0\s*\)\s*,\s*1\.0\s*\)\s*;/.test(fs),
    'the pixel must be `aged * clamp(lit, 0.0, 1.0)` — one scalar, clamped before the multiply'
  );

  // Vignette and footlight touch the scalar, never the colour.
  assert.ok(
    /lit\s*\*=\s*1\.0\s*-\s*0\.30\s*\*\s*pow\(\s*abs\(\s*vUv\.x\s*\*\s*2\.0\s*-\s*1\.0\s*\)/.test(fs),
    'the vignette must be a multiplicative brightness term on lit'
  );
  assert.ok(/lit\s*\+=\s*0\.06\s*\*\s*wire/.test(fs), 'the footlight must be an additive brightness term on lit');

  // The aged colour is still nothing but the smoothed uniform blended toward
  // the shader's own neutral — no grade, no tint, no white mixed into peaks.
  const agedLine = /vec3\s+aged\s*=\s*([^;]+);/.exec(fs);
  assert.ok(agedLine, 'the fragment shader builds no aged colour');
  assert.strictEqual(
    agedLine[1].trim(),
    'mix(uColor, MODE_NEUTRAL * uDim, vUv.y * 0.6)',
    `the aged colour must stay the uColor -> neutral blend, got "${agedLine[1].trim()}"`
  );

  // Nothing may reach for a hue/saturation space or mix white in.
  const lower = fs.toLowerCase();
  for (const banned of ['hsv', 'hsl', 'saturat', 'vec3(1.0)', 'vec3(1.0, 1.0, 1.0)']) {
    assert.strictEqual(
      lower.indexOf(banned.toLowerCase()),
      -1,
      `a "${banned}" grade would move the displayed pixel off the §1.5 endpoints`
    );
  }
  // The anchors themselves are, as ever, exactly the two §1.5 values.
  assert.ok(fs.indexOf(MAJOR_LITERAL) !== -1, 'the major anchor must survive the shading rewrite');
  assert.ok(fs.indexOf(MINOR_LITERAL) !== -1, 'the minor anchor must survive the shading rewrite');
});

s.test('boot settles the ribbon, injects the motion preference, and catches every resize', () => {
  const source = extractScriptById(INDEX, 'app-main');

  // Leaving 'live' must not freeze a vivid full-twist frame beside chips that
  // have already blanked to an em dash.
  assert.ok(
    /ribbon\.stop\(\);\s*ribbon\.settle\(\);/.test(source),
    'leaving the live state must settle the ribbon, not freeze it'
  );

  // The renderer stays HEADLESS: the OS preference is resolved in boot and
  // injected, never read from inside createRibbonRenderer.
  const bootAt = source.indexOf("if (typeof document === 'undefined') return;");
  const ribbonAt = source.indexOf('function createRibbonRenderer');
  assert.ok(bootAt !== -1 && ribbonAt !== -1 && ribbonAt < bootAt, 'the ribbon/boot boundary moved');
  // Comments stripped first: the header comments that RULE OUT reading the
  // media query themselves name it, and must not read as doing it.
  const rendererCode = source
    .slice(ribbonAt, bootAt)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.strictEqual(
    rendererCode.indexOf('matchMedia'),
    -1,
    'createRibbonRenderer must never read matchMedia — it has to stay drivable from a DOM-free sandbox'
  );
  assert.ok(/prefers-reduced-motion: reduce/.test(source), 'boot never asks for the motion preference');
  assert.ok(/reducedMotion:/.test(source), '…and never injects it into the renderer');

  // Resize triggers: the window event alone misses a container-only reflow
  // (switching back from the Editor un-hides a box that was 0x0) and misses a
  // DPR change entirely.
  assert.ok(/window\.addEventListener\('resize'/.test(source), 'the window resize listener is gone');
  assert.ok(
    /typeof ResizeObserver === 'function'/.test(source),
    'a ResizeObserver must be feature-guarded, not assumed'
  );
  assert.ok(
    /new ResizeObserver\([\s\S]{0,40}\)\.observe\(vizCanvas\)/.test(source),
    'the ResizeObserver must watch the canvas itself'
  );
  assert.ok(/dppx/.test(source), 'a DPR change fires no resize event; the resolution query is the only signal');

  // Every one of those triggers goes through the SAME idle-only repaint, so
  // none of them can start a second loop.
  const repaints = source.match(/if \(!ribbon\.isRunning\(\)\) ribbon\.renderOnce\(\);/g) || [];
  assert.strictEqual(repaints.length, 1, 'every resize trigger must share one idle-only repaint path');

  // The context asks for the discrete GPU where there is one.
  assert.ok(
    /powerPreference: 'high-performance'/.test(source),
    'the WebGL2 context should ask for the high-performance adapter'
  );

  // Still exactly two things may schedule an animation frame: the live loop and
  // the bounded settle. Each arms once and reschedules once — four call sites,
  // and no fifth, because a fifth would be an idle loop.
  assert.strictEqual((source.match(/raf\(tick\)/g) || []).length, 2, 'the live loop arms once and reschedules once');
  assert.strictEqual((source.match(/raf\(drain\)/g) || []).length, 2, 'the bounded drain arms once and reschedules once');
  assert.strictEqual(
    (source.match(/\braf\(/g) || []).length,
    4,
    'nothing else in this file may schedule an animation frame — an idle tab must not burn the GPU'
  );
});

/* ------------------------------------------------------------------------ *
 * TODO: coverage that needs a real GPU or a browser driver.
 * ------------------------------------------------------------------------ */

s.todo(
  'the shaders compile on a real driver and the ribbon writes non-black pixels',
  'needs a GPU: covered manually by the browser smoke pass (gl.readPixels over the live canvas); a headless WebGL2 driver is not available under the zero-dependency policy'
);
s.todo(
  'the rAF loop is measured at 60 FPS with the DSP worker under load',
  'needs a browser performance timeline; today the loop is asserted structurally through an injected clock'
);
s.todo(
  'the ribbon colour is sampled from real pixels after a hummed major/minor phrase',
  'needs a synthetic microphone stream in a real browser (getUserMedia cannot be faked from this harness without simulating audio, which ENGINEERING-STANDARD.md §1.2 forbids in product code)'
);

module.exports = { loadAppSandbox, makeGlStub, makeCanvas, makeClock, GL_ENUM };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
