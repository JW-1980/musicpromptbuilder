'use strict';
/*
 * tests/audio-capture.test.js — behavioural tests for the live Web Audio
 * capture engine that lives in <script id="app-main"> inside index.html.
 *
 * The engine (`createAudioCapture`) is dependency-injected: production code
 * hands it the REAL navigator.mediaDevices.getUserMedia and the REAL
 * AudioContext constructor, while this suite hands it fakes. No audio is ever
 * synthesised inside index.html (docs/ENGINEERING-STANDARD.md §1.2) — the fakes
 * exist only here, in the test harness.
 *
 * The #app-main source is evaluated in a node:vm context that deliberately has
 * NO `document`, `window`, `navigator`, `Worker`, `Blob` or `localStorage`.
 * That proves two things at once:
 *   1. the boot IIFE is properly guarded and cannot fire outside a browser, and
 *   2. `createAudioCapture` is reachable as a top-level function declaration
 *      (top-level `const`/`let` are lexical and never become sandbox
 *      properties — see the notes in tests/lib/extract.js).
 *
 * SEQ POLICY (test 5): a restart after stop() is a NEW capture session and
 * `seq` RESTARTS AT 0. Rationale: seq is a per-session frame index that the DSP
 * worker echoes back in `chunk-ack`; resetting keeps a session's frame numbering
 * self-describing (frame 0 is always the first frame of that recording) instead
 * of leaking the length of previous sessions into the analysis stream.
 *
 * Node built-ins only: path, assert, vm.
 */

const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate #app-main in a DOM-free vm context.
 * The absence of `document` is the point: the boot IIFE must bail out.
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

/* -------------------------------------------------------------------------- */
/* Fakes (test-only; never present in production code paths)                  */
/* -------------------------------------------------------------------------- */

/** A manual interval scheduler: nothing fires until `tick()` is called. */
function makeFakeScheduler() {
  const timers = new Map();
  let nextId = 1;
  const api = {
    cleared: [],
    lastFn: null,
    lastMs: null,
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, fn);
      api.lastFn = fn;
      api.lastMs = ms;
      return id;
    },
    clearInterval(id) {
      api.cleared.push(id);
      timers.delete(id);
    },
    /** Fire every live timer `n` times. */
    tick(n) {
      const times = typeof n === 'number' ? n : 1;
      for (let i = 0; i < times; i += 1) {
        for (const fn of Array.from(timers.values())) fn();
      }
    },
    activeCount() {
      return timers.size;
    },
  };
  return api;
}

/**
 * A fake AudioContext whose analyser writes a deterministic, strictly non-zero
 * pattern that differs from frame to frame.
 */
function makeFakeAudioContext(options) {
  const opts = options || {};
  const calls = {
    constructed: 0,
    createMediaStreamSource: 0,
    createAnalyser: 0,
    close: 0,
    connects: [],
    sourceArg: null,
    analyser: null,
    instance: null,
    frames: 0,
  };

  function FakeAudioContext() {
    calls.constructed += 1;
    calls.instance = this;
    const ctx = this;
    this.sampleRate = typeof opts.sampleRate === 'number' ? opts.sampleRate : 44100;
    this.state = 'running';

    this.createMediaStreamSource = function (mediaStream) {
      calls.createMediaStreamSource += 1;
      calls.sourceArg = mediaStream;
      return {
        connect(node) {
          calls.connects.push(node);
        },
        disconnect() {},
      };
    };

    this.createAnalyser = function () {
      calls.createAnalyser += 1;
      const analyser = {
        fftSize: 32, // browser default-ish; the engine must overwrite this
        getFloatTimeDomainData(buf) {
          calls.frames += 1;
          const f = calls.frames;
          for (let i = 0; i < buf.length; i += 1) {
            // deterministic, never 0, and different on every frame
            buf[i] = (((i + f) % 17) + 1) / 20;
          }
        },
        disconnect() {},
      };
      calls.analyser = analyser;
      return analyser;
    };

    this.close = function () {
      calls.close += 1;
      ctx.state = 'closed';
      return Promise.resolve();
    };
  }

  return { Ctor: FakeAudioContext, calls };
}

/** A fake MediaStream with countable track.stop() calls. */
function makeFakeStream(trackCount) {
  const tracks = [];
  const n = typeof trackCount === 'number' ? trackCount : 2;
  for (let i = 0; i < n; i += 1) {
    tracks.push({
      kind: 'audio',
      readyState: 'live',
      stopCalls: 0,
      stop() {
        this.stopCalls += 1;
        this.readyState = 'ended';
      },
    });
  }
  return {
    tracks,
    getTracks() {
      return tracks;
    },
    getAudioTracks() {
      return tracks;
    },
  };
}

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** Build a capture engine with sane fake defaults; `over` patches the deps. */
function buildCapture(app, over) {
  const patch = over || {};
  const statuses = [];
  const chunks = [];
  const scheduler = makeFakeScheduler();
  const audio = makeFakeAudioContext(patch.audioOptions);
  const stream = patch.stream || makeFakeStream(2);

  const deps = {
    getUserMedia:
      'getUserMedia' in patch
        ? patch.getUserMedia
        : function () {
            return Promise.resolve(stream);
          },
    AudioContextCtor: 'AudioContextCtor' in patch ? patch.AudioContextCtor : audio.Ctor,
    onChunk(chunk) {
      chunks.push(chunk);
    },
    onStatus(state, detail) {
      statuses.push({ state, detail });
    },
    intervalScheduler: scheduler.setInterval,
    clearScheduler: scheduler.clearInterval,
    now() {
      return 1000 + chunks.length;
    },
  };

  const capture = app.sandbox.createAudioCapture(deps);
  return { capture, statuses, chunks, scheduler, audio, stream, deps };
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

const s = suite('audio-capture (#app-main Web Audio / AnalyserNode engine)');

/* --- sandbox / boot guard ------------------------------------------------- */

s.test('#app-main evaluates in a DOM-free sandbox without running the boot IIFE', () => {
  let app;
  assert.doesNotThrow(() => {
    app = loadAppSandbox();
  }, '#app-main threw when evaluated without a document — boot IIFE is not guarded');
  // Nothing may have reached for the DOM and created these along the way.
  for (const forbidden of ['document', 'window', 'navigator', 'localStorage', 'Worker', 'Blob', 'URL']) {
    assert.strictEqual(
      app.sandbox[forbidden],
      undefined,
      `#app-main referenced/created "${forbidden}" outside the boot guard`
    );
  }
});

s.test('createAudioCapture is a top-level function declaration reachable from the sandbox', () => {
  const app = loadAppSandbox();
  assert.strictEqual(
    typeof app.sandbox.createAudioCapture,
    'function',
    'createAudioCapture must be a top-level `function` declaration, before the boot IIFE'
  );
  assert.strictEqual(
    typeof app.sandbox.micTroubleshootingSteps,
    'function',
    'micTroubleshootingSteps must be a top-level function so guidance is shared with the UI'
  );
});

s.test('APP_VERSION is declared at top level and semver-shaped', () => {
  const app = loadAppSandbox();
  assert.strictEqual(app.evaluate('typeof APP_VERSION'), 'string');
  const version = app.evaluate('APP_VERSION');
  assert.ok(SEMVER.test(version), `APP_VERSION "${version}" is not semver-shaped`);
});

s.test('a fresh engine reports state "idle" and zero chunks', () => {
  const app = loadAppSandbox();
  const h = buildCapture(app);
  assert.strictEqual(h.capture.getState(), 'idle');
  assert.strictEqual(h.capture.chunkCount(), 0);
});

/* --- 1. unsupported ------------------------------------------------------- */

s.test('1. missing getUserMedia -> state "unsupported", no throw', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app, { getUserMedia: undefined });
  let returned;
  assert.doesNotThrow(() => {
    returned = h.capture.start();
  }, 'start() threw when getUserMedia is unavailable');
  assert.strictEqual(returned, 'unsupported', 'start() should return the new state');
  assert.strictEqual(h.capture.getState(), 'unsupported');
  assert.strictEqual(await h.capture.ready(), 'unsupported');

  const last = h.statuses[h.statuses.length - 1];
  assert.strictEqual(last.state, 'unsupported');
  assert.ok(last.detail, 'unsupported status carried no detail');
  assert.ok(
    Array.isArray(last.detail.missing) && last.detail.missing.includes('getUserMedia'),
    `detail.missing should name getUserMedia, got ${JSON.stringify(last.detail.missing)}`
  );
  assert.ok(
    /getUserMedia/.test(last.detail.message) && /Web Audio/i.test(last.detail.message),
    `unsupported message must explain what is missing; got "${last.detail.message}"`
  );
  assert.strictEqual(h.chunks.length, 0, 'unsupported must not emit chunks');
});

s.test('1b. missing AudioContext -> state "unsupported" naming AudioContext', () => {
  const app = loadAppSandbox();
  const h = buildCapture(app, { AudioContextCtor: undefined });
  h.capture.start();
  assert.strictEqual(h.capture.getState(), 'unsupported');
  const last = h.statuses[h.statuses.length - 1];
  assert.ok(
    last.detail.missing.includes('AudioContext'),
    `detail.missing should name AudioContext, got ${JSON.stringify(last.detail.missing)}`
  );
});

/* --- 2. denied ------------------------------------------------------------ */

s.test('2. getUserMedia rejects NotAllowedError -> "denied" with real guidance in detail', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app, {
    getUserMedia() {
      return Promise.reject(namedError('NotAllowedError', 'Permission denied'));
    },
  });

  assert.strictEqual(h.capture.start(), 'requesting', 'start() should enter "requesting" first');
  const settled = await h.capture.ready();
  assert.strictEqual(settled, 'denied');
  assert.strictEqual(h.capture.getState(), 'denied');

  const seen = h.statuses.map((e) => e.state);
  assert.deepStrictEqual(seen, ['requesting', 'denied'], `state trail was ${seen.join(' -> ')}`);

  const detail = h.statuses[h.statuses.length - 1].detail;
  assert.ok(detail, 'denied status carried no detail');
  assert.strictEqual(detail.name, 'NotAllowedError', 'detail must carry the error name');
  assert.strictEqual(detail.message, 'Permission denied', 'detail must carry the error message');
  assert.ok(Array.isArray(detail.steps) && detail.steps.length >= 4, 'detail.steps must carry troubleshooting guidance');

  // The guidance has to be genuinely actionable, not filler.
  const guidance = detail.steps.join('\n');
  for (const needle of [/padlock/i, /Site settings/i, /Privacy/i, /file:\/\//, /localhost/i]) {
    assert.ok(needle.test(guidance), `troubleshooting guidance is missing ${needle}`);
  }
  assert.strictEqual(h.chunks.length, 0, 'a denied mic must never produce chunks');
});

s.test('2b. PermissionDeniedError also maps to "denied"; other errors map to "error"', async () => {
  const app = loadAppSandbox();

  const legacy = buildCapture(app, {
    getUserMedia() {
      return Promise.reject(namedError('PermissionDeniedError', 'legacy denial'));
    },
  });
  legacy.capture.start();
  assert.strictEqual(await legacy.capture.ready(), 'denied');

  const broken = buildCapture(app, {
    getUserMedia() {
      return Promise.reject(namedError('NotFoundError', 'no input device'));
    },
  });
  broken.capture.start();
  assert.strictEqual(await broken.capture.ready(), 'error');
  const detail = broken.statuses[broken.statuses.length - 1].detail;
  assert.strictEqual(detail.name, 'NotFoundError');
  assert.strictEqual(detail.message, 'no input device');
});

/* --- 3. grant -> live ----------------------------------------------------- */

s.test('3. grant -> "live": AnalyserNode wired at fftSize 2048 and polled on a timer', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app);

  h.capture.start();
  assert.strictEqual(await h.capture.ready(), 'live');
  assert.strictEqual(h.capture.getState(), 'live');

  assert.strictEqual(h.audio.calls.constructed, 1, 'exactly one AudioContext should be created');
  assert.strictEqual(h.audio.calls.createMediaStreamSource, 1, 'stream was not routed through createMediaStreamSource');
  assert.strictEqual(h.audio.calls.sourceArg, h.stream, 'createMediaStreamSource got the wrong stream');
  assert.strictEqual(h.audio.calls.createAnalyser, 1, 'no AnalyserNode created');
  assert.strictEqual(h.audio.calls.analyser.fftSize, 2048, 'fftSize must be set to 2048');
  assert.strictEqual(h.audio.calls.connects.length, 1, 'source was not connected to the analyser');
  assert.strictEqual(h.audio.calls.connects[0], h.audio.calls.analyser, 'source connected to the wrong node');

  // 2048 / 44100 s ~= 46ms, clamped to >= 20ms.
  assert.ok(
    h.scheduler.lastMs >= 20 && h.scheduler.lastMs <= 60,
    `poll interval should be ~46ms (>=20ms clamp), got ${h.scheduler.lastMs}ms`
  );
  assert.strictEqual(h.scheduler.activeCount(), 1, 'exactly one polling timer should be live');
  assert.strictEqual(h.chunks.length, 0, 'no chunk should be emitted before the first tick');
});

s.test('3b. each tick emits a FRESH Float32Array of 2048 samples with monotonic seq from 0', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app);
  h.capture.start();
  await h.capture.ready();

  h.scheduler.tick(3);

  assert.strictEqual(h.chunks.length, 3, `expected 3 chunks, got ${h.chunks.length}`);
  assert.strictEqual(h.capture.chunkCount(), 3, 'chunkCount() drifted from the emitted chunks');

  for (let i = 0; i < h.chunks.length; i += 1) {
    const chunk = h.chunks[i];
    assert.strictEqual(chunk.seq, i, `chunk ${i} has seq ${chunk.seq}; seq must start at 0 and increment by 1`);
    assert.strictEqual(chunk.sampleRate, 44100, `chunk ${i} sampleRate should be 44100, got ${chunk.sampleRate}`);
    assert.ok(chunk.samples instanceof Float32Array, `chunk ${i}.samples is not a Float32Array`);
    assert.strictEqual(chunk.samples.length, 2048, `chunk ${i}.samples length is ${chunk.samples.length}, expected 2048`);
    // Deterministic fake data: strictly non-zero everywhere.
    assert.ok(chunk.samples[0] !== 0, `chunk ${i} starts with a zero sample — the analyser was not read`);
    assert.ok(chunk.samples[2047] !== 0, `chunk ${i} ends with a zero sample — the buffer was only partially filled`);
  }

  // Fresh instance per chunk: the previous buffer is transferred to the worker
  // and detached, so reusing one would corrupt in-flight audio.
  assert.notStrictEqual(h.chunks[1].samples, h.chunks[0].samples, 'chunk 1 reused chunk 0 buffer object');
  assert.notStrictEqual(h.chunks[2].samples, h.chunks[1].samples, 'chunk 2 reused chunk 1 buffer object');
  assert.notStrictEqual(
    h.chunks[1].samples.buffer,
    h.chunks[0].samples.buffer,
    'chunks share one ArrayBuffer — transferring it would detach a live buffer'
  );
  // The fake varies per frame, so a stale copy would be detectable here.
  assert.notStrictEqual(h.chunks[0].samples[0], h.chunks[1].samples[0], 'chunk contents did not advance between polls');
});

s.test('3c. a non-standard AudioContext sampleRate is honoured and the poll interval is clamped', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app, { audioOptions: { sampleRate: 192000 } });
  h.capture.start();
  await h.capture.ready();
  h.scheduler.tick(1);

  assert.strictEqual(h.chunks[0].sampleRate, 192000, 'the engine must report the context sample rate, not a constant');
  // 2048 / 192000 s ~= 10.6ms -> clamped to the 20ms floor.
  assert.strictEqual(h.scheduler.lastMs, 20, `poll interval should clamp to 20ms, got ${h.scheduler.lastMs}ms`);
});

/* --- 4. stop -------------------------------------------------------------- */

s.test('4. stop() clears the timer, stops every track, closes the context and is idempotent', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app);
  h.capture.start();
  await h.capture.ready();
  h.scheduler.tick(2);
  assert.strictEqual(h.chunks.length, 2);

  const pollFn = h.scheduler.lastFn;
  h.capture.stop();

  assert.strictEqual(h.capture.getState(), 'stopped');
  assert.strictEqual(h.scheduler.activeCount(), 0, 'polling timer was not cleared');
  assert.strictEqual(h.scheduler.cleared.length, 1, 'clearScheduler was not called exactly once');
  for (let i = 0; i < h.stream.tracks.length; i += 1) {
    assert.strictEqual(
      h.stream.tracks[i].stopCalls,
      1,
      `track ${i}.stop() was called ${h.stream.tracks[i].stopCalls} times — the mic stays hot`
    );
  }
  assert.strictEqual(h.audio.calls.close, 1, 'AudioContext.close() was not called');
  assert.strictEqual(h.audio.calls.instance.state, 'closed');

  // Idempotent, and no double-close / double-track-stop.
  assert.doesNotThrow(() => {
    h.capture.stop();
    h.capture.stop();
  }, 'stop() is not idempotent');
  assert.strictEqual(h.capture.getState(), 'stopped');
  assert.strictEqual(h.audio.calls.close, 1, 'stop() closed the AudioContext more than once');
  assert.strictEqual(h.stream.tracks[0].stopCalls, 1, 'stop() stopped a track more than once');

  // Even a stray timer callback must not produce audio after stop().
  const before = h.chunks.length;
  h.scheduler.tick(3);
  assert.strictEqual(h.chunks.length, before, 'ticks after stop() still produced chunks');
  assert.doesNotThrow(() => pollFn(), 'a stray poll callback threw after stop()');
  assert.strictEqual(h.chunks.length, before, 'a stray poll callback produced a chunk after stop()');
  assert.strictEqual(h.capture.chunkCount(), 2, 'chunkCount() changed after stop()');
});

s.test('4b. stop() during "requesting" releases the stream the prompt later grants', async () => {
  const app = loadAppSandbox();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const stream = makeFakeStream(1);
  const h = buildCapture(app, {
    stream,
    getUserMedia() {
      return pending;
    },
  });

  h.capture.start();
  assert.strictEqual(h.capture.getState(), 'requesting');
  h.capture.stop();
  assert.strictEqual(h.capture.getState(), 'stopped');

  release(stream);
  await pending;
  await Promise.resolve();

  assert.strictEqual(h.capture.getState(), 'stopped', 'a late grant must not resurrect a stopped capture');
  assert.strictEqual(stream.tracks[0].stopCalls, 1, 'the late-granted stream was never released — mic stays hot');
  assert.strictEqual(h.audio.calls.constructed, 0, 'a stopped capture must not build an audio graph');
  assert.strictEqual(h.chunks.length, 0);
});

/* --- 5. restart ----------------------------------------------------------- */

s.test('5. restart after stop() returns to requesting -> live and RESETS seq to 0', async () => {
  const app = loadAppSandbox();
  const h = buildCapture(app);

  h.capture.start();
  await h.capture.ready();
  h.scheduler.tick(2);
  h.capture.stop();
  assert.strictEqual(h.chunks.length, 2);

  const returned = h.capture.start();
  assert.strictEqual(returned, 'requesting', 'restart must re-enter "requesting"');
  assert.strictEqual(await h.capture.ready(), 'live', 'restart must reach "live" again');

  h.scheduler.tick(2);
  const session2 = h.chunks.slice(2);
  assert.strictEqual(session2.length, 2, 'the restarted session emitted no chunks');

  // DOCUMENTED CHOICE: seq restarts at 0 for each capture session.
  assert.strictEqual(session2[0].seq, 0, 'seq must RESET to 0 on restart (documented policy)');
  assert.strictEqual(session2[1].seq, 1, 'seq must increment from 0 within the new session');
  assert.strictEqual(h.capture.chunkCount(), 2, 'chunkCount() must also restart with the new session');

  assert.strictEqual(h.audio.calls.constructed, 2, 'restart must build a fresh AudioContext');
  assert.strictEqual(h.scheduler.activeCount(), 1, 'restart must leave exactly one polling timer live');

  const trail = h.statuses.map((e) => e.state);
  assert.deepStrictEqual(
    trail,
    ['requesting', 'live', 'stopped', 'requesting', 'live'],
    `state trail was ${trail.join(' -> ')}`
  );
});

s.test('5b. start() while requesting or live is a no-op returning the current state', async () => {
  const app = loadAppSandbox();
  let calls = 0;
  const stream = makeFakeStream(1);
  const h = buildCapture(app, {
    stream,
    getUserMedia() {
      calls += 1;
      return Promise.resolve(stream);
    },
  });

  h.capture.start();
  assert.strictEqual(h.capture.start(), 'requesting', 'start() during "requesting" must be a no-op');
  await h.capture.ready();
  assert.strictEqual(h.capture.start(), 'live', 'start() during "live" must be a no-op');
  assert.strictEqual(calls, 1, `getUserMedia was called ${calls} times; re-entrant start() must not re-prompt`);
  assert.strictEqual(h.audio.calls.constructed, 1, 'a second audio graph was built');
  assert.strictEqual(h.scheduler.activeCount(), 1, 'a second polling timer was scheduled');
});

/* --- guidance ------------------------------------------------------------- */

s.test('micTroubleshootingSteps() returns concrete, non-placeholder recovery steps', () => {
  const app = loadAppSandbox();
  const steps = app.sandbox.micTroubleshootingSteps();
  assert.ok(Array.isArray(steps) && steps.length >= 4, 'expected at least 4 troubleshooting steps');
  for (const step of steps) {
    assert.strictEqual(typeof step, 'string');
    assert.ok(step.trim().length > 40, `troubleshooting step is too thin to be useful: "${step}"`);
    assert.ok(!/TODO|TBD|placeholder|lorem/i.test(step), `placeholder text in guidance: "${step}"`);
  }
});

s.test('index.html ships the #mic-help panel and #btn-record control with accessible labels', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(INDEX, 'utf8');
  for (const id of ['btn-record', 'status-mic', 'mic-help', 'capture-readout']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing an element with id="${id}"`);
  }
  assert.ok(/id="btn-record"[\s\S]{0,240}aria-label=/.test(html), '#btn-record has no aria-label');
  assert.ok(/id="mic-help"[\s\S]{0,200}hidden/.test(html), '#mic-help should start hidden');
});

/* ------------------------------------------------------------------------ *
 * TODO: coverage that activates with later features.
 * ------------------------------------------------------------------------ */

s.todo(
  'chunks flow end-to-end into the DSP worker and come back as chunk-ack',
  'needs a shared main<->worker harness; today dsp-worker.test.js covers the worker half'
);
s.todo(
  'capture surfaces an RMS-gated "silence" state instead of shipping dead frames',
  'activates when the RMS noise gate ships in #dsp-worker-src (FEATURE-MECHANICS.md 1.2)'
);
s.todo(
  'device change (mic unplugged mid-capture) transitions live -> error with guidance',
  'needs MediaStreamTrack "ended" event plumbing'
);

module.exports = { loadAppSandbox, makeFakeScheduler, makeFakeAudioContext, makeFakeStream };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
