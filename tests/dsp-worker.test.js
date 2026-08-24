'use strict';
/*
 * tests/dsp-worker.test.js — behavioural tests for the inline DSP Web Worker.
 *
 * The worker source lives in <script id="dsp-worker-src" type="text/js-worker">
 * inside index.html. tests/lib/extract.js pulls it out and runs it in a
 * node:vm sandbox with a `self` stub, so we exercise the REAL message protocol
 * with no browser and no build step.
 *
 * Covered here: the message protocol (ping/pong, 'audio-chunk' transport,
 * 'analyze', malformed input) AND the DSP maths itself — YIN pitch detection,
 * the RMS noise gate, onset detection and the BPM tracker.
 *
 * SIGNAL SYNTHESIS LIVES HERE, NEVER IN index.html. docs/ENGINEERING-STANDARD
 * §1.2 forbids the product from ever manufacturing audio; the harness, by
 * contrast, MUST manufacture it — a sine of known frequency is the only way to
 * check a pitch detector against ground truth. Everything below is
 * deterministic (a seeded LCG, no Math.random) so a failure is reproducible.
 *
 * Node built-ins only: path, assert.
 */

const path = require('node:path');
const assert = require('node:assert');
const { suite } = require('./lib/runner.js');
const { loadWorkerSandbox } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/* Analysis window contract (docs/FEATURE-MECHANICS.md §1.2). */
const SR = 44100;
const FRAME = 2048;
/* Studio reference tempo used across the FDD examples. */
const REF_BPM = 124;

/* -------------------------------------------------------------------------- */
/* Deterministic test-signal synthesis (harness only)                          */
/* -------------------------------------------------------------------------- */

/**
 * Seeded 32-bit linear congruential generator (Numerical Recipes constants),
 * mapped to [-1, 1). Used instead of Math.random() so "white noise must not
 * produce a pitch" is a REPRODUCIBLE claim, not a dice roll.
 * @param {number} seed
 * @returns {() => number}
 */
function lcg(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
}

/**
 * A sine of `freq` Hz.
 * @param {number} freq
 * @param {{length?:number, sampleRate?:number, amplitude?:number, phase?:number}} [opts]
 * @returns {Float32Array}
 */
function sine(freq, opts) {
  const o = opts || {};
  const n = o.length || FRAME;
  const sr = o.sampleRate || SR;
  const amp = o.amplitude === undefined ? 0.5 : o.amplitude;
  const phase = o.phase || 0;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    buf[i] = amp * Math.sin(2 * Math.PI * freq * (i / sr) + phase);
  }
  return buf;
}

/** White noise from a seeded LCG. */
function whiteNoise(length, amplitude, seed) {
  const next = lcg(seed);
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i += 1) buf[i] = next() * amplitude;
  return buf;
}

/**
 * A percussive click train at `bpm`, plus any extra (spurious) clicks.
 * Each click is a 4 ms exponentially decaying 1.8 kHz burst — a real transient
 * with an attack, not a single-sample impulse.
 *
 * @param {{bpm:number, seconds:number, extraMs?:number[], noise?:number,
 *          sampleRate?:number}} spec
 * @returns {{samples:Float32Array, clickTimesMs:number[]}}
 */
function clickTrain(spec) {
  const sr = spec.sampleRate || SR;
  const total = Math.round(sr * spec.seconds);
  const buf = new Float32Array(total);

  if (spec.noise) {
    const next = lcg(20240824);
    for (let i = 0; i < total; i += 1) buf[i] = next() * spec.noise;
  }

  const beatMs = 60000 / spec.bpm;
  const beats = [];
  for (let t = 0; t * beatMs < spec.seconds * 1000 - 1; t += 1) beats.push(t * beatMs);

  const all = beats.concat(spec.extraMs || []).sort(function (a, b) {
    return a - b;
  });
  const burst = Math.round(sr * 0.004);
  const tau = sr * 0.0009;
  for (let k = 0; k < all.length; k += 1) {
    const start = Math.round((all[k] / 1000) * sr);
    for (let i = 0; i < burst && start + i < total; i += 1) {
      buf[start + i] += 0.9 * Math.exp(-i / tau) * Math.sin((2 * Math.PI * 1800 * i) / sr);
    }
  }
  return { samples: buf, clickTimesMs: beats };
}

/** Split a buffer into consecutive `size`-sample views (the capture pump's shape). */
function chunksOf(samples, size) {
  const out = [];
  for (let off = 0; off + size <= samples.length; off += size) {
    out.push(samples.subarray(off, off + size));
  }
  return out;
}

/** Relative error in percent. */
function errorPct(actual, expected) {
  return (Math.abs(actual - expected) / expected) * 100;
}

/**
 * Strip block and line comments so a source scan cannot be tripped by prose.
 * (The worker's own header explains that it uses no random source; that
 * sentence must not be mistaken for the call it forbids.)
 * @param {string} source
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const s = suite('dsp-worker (inline Web Worker message protocol)');

s.test('worker source loads in a vm sandbox and installs self.onmessage', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(
    typeof w.sandbox.self.onmessage,
    'function',
    'worker did not assign self.onmessage'
  );
});

s.test('DSP_ENGINE_VERSION is declared at top level and semver-shaped', () => {
  const w = loadWorkerSandbox(INDEX);
  // Top-level `const` is a lexical binding, so it is NOT a sandbox property —
  // probe it inside the worker context instead.
  assert.strictEqual(
    w.evaluate('typeof DSP_ENGINE_VERSION'),
    'string',
    'DSP_ENGINE_VERSION is not declared at worker top level as a string'
  );
  const version = w.evaluate('DSP_ENGINE_VERSION');
  assert.ok(SEMVER.test(version), `DSP_ENGINE_VERSION "${version}" is not semver-shaped`);
});

s.test('handleMessage is a top-level pure function (callable without self)', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(typeof w.sandbox.handleMessage, 'function', 'handleMessage not at top level');
  const reply = w.sandbox.handleMessage({ type: 'ping' });
  assert.strictEqual(reply.type, 'pong');
});

s.test("ping -> pong with engine 'dsp'", () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send({ type: 'ping' });
  assert.ok(reply, 'worker posted no reply to ping');
  assert.strictEqual(reply.type, 'pong', `expected type "pong", got "${reply.type}"`);
  assert.strictEqual(reply.engine, 'dsp', `expected engine "dsp", got "${reply.engine}"`);
});

s.test('pong carries a semver-shaped version matching DSP_ENGINE_VERSION', () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send({ type: 'ping' });
  assert.ok(SEMVER.test(String(reply.version)), `version "${reply.version}" is not semver-shaped`);
  assert.strictEqual(
    reply.version,
    w.evaluate('DSP_ENGINE_VERSION'),
    'pong.version drifted from DSP_ENGINE_VERSION'
  );
});

s.test('unknown message type -> error reply naming the type', () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send({ type: 'definitely-not-a-real-command' });
  assert.ok(reply, 'worker posted no reply to an unknown type');
  assert.strictEqual(reply.type, 'error', `expected type "error", got "${reply.type}"`);
  assert.strictEqual(typeof reply.error, 'string', 'error reply has no string .error');
  assert.ok(
    reply.error.includes('definitely-not-a-real-command'),
    `error message should name the offending type; got "${reply.error}"`
  );
});

s.test('null message -> error reply, no throw', () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send(null);
  assert.ok(reply, 'worker posted no reply to null');
  assert.strictEqual(reply.type, 'error');
  assert.strictEqual(typeof reply.error, 'string');
});

s.test('malformed messages (undefined, primitives, missing/non-string type) -> error, no throw', () => {
  const malformed = [undefined, 42, 'ping', true, [], {}, { type: 7 }, { type: null }, { notType: 'ping' }];
  for (const msg of malformed) {
    const w = loadWorkerSandbox(INDEX);
    let reply;
    assert.doesNotThrow(() => {
      reply = w.send(msg);
    }, `worker threw on malformed message: ${JSON.stringify(msg) ?? String(msg)}`);
    assert.ok(reply, `no reply for malformed message: ${String(msg)}`);
    assert.strictEqual(
      reply.type,
      'error',
      `expected error for malformed message ${JSON.stringify(msg) ?? String(msg)}, got "${reply.type}"`
    );
  }
});

s.test('worker replies exactly once per message', () => {
  const w = loadWorkerSandbox(INDEX);
  w.send({ type: 'ping' });
  assert.strictEqual(w.replies.length, 1, `expected 1 reply, got ${w.replies.length}`);
  w.send({ type: 'ping' });
  assert.strictEqual(w.replies.length, 2, `expected 2 replies, got ${w.replies.length}`);
});

s.test('worker source touches no DOM globals (window/document/localStorage)', () => {
  const w = loadWorkerSandbox(INDEX);
  // A Worker global scope has none of these; referencing one would have thrown
  // during evaluation above. Assert the sandbox never grew them either.
  for (const forbidden of ['window', 'document', 'localStorage']) {
    assert.strictEqual(
      w.sandbox[forbidden],
      undefined,
      `worker source referenced/created "${forbidden}" — DSP must stay DOM-free`
    );
  }
});

/* ------------------------------------------------------------------------ *
 * Capture transport: 'audio-chunk' carries live AnalyserNode frames from the
 * main thread (see createAudioCapture in #app-main) into the worker.
 * ------------------------------------------------------------------------ */

s.test('audio-chunk -> chunk-ack echoing seq and the sample count', () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send({
    type: 'audio-chunk',
    seq: 0,
    sampleRate: 44100,
    samples: new Float32Array(2048),
  });
  assert.ok(reply, 'worker posted no reply to audio-chunk');
  assert.strictEqual(reply.type, 'chunk-ack', `expected "chunk-ack", got "${reply.type}"`);
  assert.strictEqual(reply.seq, 0, 'chunk-ack must echo the chunk seq');
  assert.strictEqual(reply.samples, 2048, 'chunk-ack must report the received frame count');
});

s.test('audio-chunk acks preserve monotonic seq across a burst of frames', () => {
  const w = loadWorkerSandbox(INDEX);
  for (let seq = 0; seq < 5; seq += 1) {
    const reply = w.send({
      type: 'audio-chunk',
      seq,
      sampleRate: 48000,
      samples: new Float32Array(1024),
    });
    assert.strictEqual(reply.type, 'chunk-ack');
    assert.strictEqual(reply.seq, seq, `ack ${seq} echoed seq ${reply.seq}`);
    assert.strictEqual(reply.samples, 1024);
  }
  assert.strictEqual(w.replies.length, 5, `expected 5 acks, got ${w.replies.length}`);
});

s.test('malformed audio-chunk (missing seq / non-array-like samples) -> error, no throw', () => {
  const malformed = [
    { type: 'audio-chunk', sampleRate: 44100, samples: new Float32Array(8) },
    { type: 'audio-chunk', seq: '0', sampleRate: 44100, samples: new Float32Array(8) },
    { type: 'audio-chunk', seq: NaN, sampleRate: 44100, samples: new Float32Array(8) },
    { type: 'audio-chunk', seq: 0, sampleRate: 44100 },
    { type: 'audio-chunk', seq: 0, sampleRate: 44100, samples: null },
    { type: 'audio-chunk', seq: 0, sampleRate: 44100, samples: 2048 },
    { type: 'audio-chunk', seq: 0, sampleRate: 44100, samples: 'not-audio' },
  ];
  for (const msg of malformed) {
    const w = loadWorkerSandbox(INDEX);
    let reply;
    assert.doesNotThrow(() => {
      reply = w.send(msg);
    }, `worker threw on malformed audio-chunk: ${JSON.stringify(msg)}`);
    assert.ok(reply, `no reply for malformed audio-chunk: ${JSON.stringify(msg)}`);
    assert.strictEqual(
      reply.type,
      'error',
      `expected "error" for ${JSON.stringify(msg)}, got "${reply.type}"`
    );
    assert.ok(/audio-chunk/.test(reply.error), `error should name audio-chunk; got "${reply.error}"`);
  }
});

s.test('Float32Array survives the vm sandbox roundtrip intact', () => {
  const w = loadWorkerSandbox(INDEX);

  // Host-created typed array -> worker.
  const host = new Float32Array([0.25, -0.5, 0.75, -1]);
  const ack = w.send({ type: 'audio-chunk', seq: 7, sampleRate: 44100, samples: host });
  assert.strictEqual(ack.type, 'chunk-ack');
  assert.strictEqual(ack.seq, 7);
  assert.strictEqual(ack.samples, 4);

  // The worker context sees it as a real Float32Array with intact values.
  w.sandbox.probeSamples = host;
  assert.strictEqual(w.evaluate('probeSamples instanceof Float32Array'), true, 'lost its Float32Array identity in the sandbox');
  assert.strictEqual(w.evaluate('probeSamples.length'), 4);
  assert.strictEqual(w.evaluate('probeSamples[0]'), 0.25);
  assert.strictEqual(w.evaluate('probeSamples[3]'), -1);

  // Sandbox-created typed array -> back out to the host and through the protocol.
  const built = w.evaluate('new Float32Array([1, 2, 3])');
  assert.ok(built instanceof Float32Array, 'sandbox Float32Array is not recognised on the host side');
  assert.strictEqual(built.length, 3);
  assert.strictEqual(built[2], 3);
  const ack2 = w.send({ type: 'audio-chunk', seq: 8, sampleRate: 44100, samples: built });
  assert.strictEqual(ack2.type, 'chunk-ack');
  assert.strictEqual(ack2.samples, 3);

  // A structured-clone survivor (plain array) is accepted too.
  const ack3 = w.send({ type: 'audio-chunk', seq: 9, sampleRate: 44100, samples: [0, 0.1, 0.2] });
  assert.strictEqual(ack3.type, 'chunk-ack');
  assert.strictEqual(ack3.samples, 3);
});

/* ------------------------------------------------------------------------ *
 * YIN pitch detection (docs/FEATURE-MECHANICS.md §1.2)
 * ------------------------------------------------------------------------ */

s.test('YIN: detects synthesized sine pitch across 65-1050 Hz within tolerance', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(typeof w.sandbox.yinPitch, 'function', 'yinPitch() is not a top-level function');

  // Both ends of the declared band plus musical anchors in between. 261.63 and
  // 523.25 are deliberately off-bin: sr/tau can never land on them exactly.
  const sweep = [70, 110, 220, 261.63, 440, 523.25, 880, 1040];
  const worst = [];
  for (const freq of sweep) {
    const detected = w.sandbox.yinPitch(sine(freq, { length: FRAME }), SR);
    assert.ok(detected !== null, `yinPitch returned null for a clean ${freq} Hz sine`);
    const err = errorPct(detected, freq);
    worst.push({ freq, detected, err });
    assert.ok(
      err <= 1,
      `${freq} Hz detected as ${detected.toFixed(3)} Hz — ${err.toFixed(3)}% off, tolerance is 1%`
    );
  }

  // A detector that reported a constant would also pass a single-frequency
  // check; assert the results are actually distinct and ordered.
  for (let i = 1; i < worst.length; i += 1) {
    assert.ok(
      worst[i].detected > worst[i - 1].detected,
      `detected pitches are not monotonic with the input sweep: ${JSON.stringify(worst)}`
    );
  }

  // Phase must not matter: the difference function is phase-invariant.
  const shifted = w.sandbox.yinPitch(sine(440, { phase: 1.234 }), SR);
  assert.ok(errorPct(shifted, 440) <= 1, `440 Hz at a shifted phase detected as ${shifted}`);
});

s.test('YIN: difference/CMND threshold of 0.1 selects the first qualifying dip', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(w.evaluate('YIN_THRESHOLD'), 0.1, 'the absolute threshold must be 0.1');

  // A periodic signal dips at tau0 AND at every multiple of it. Taking the
  // FIRST qualifying dip is exactly what stops the classic octave-down error:
  // 220 Hz must not be reported as its 110 Hz subharmonic.
  const detail = w.sandbox.yinDetect(sine(220, { length: FRAME }), SR);
  assert.ok(detail, 'yinDetect returned null for a clean 220 Hz sine');
  assert.ok(detail.cmnd < 0.1, `the selected dip has CMND ${detail.cmnd}, which is not below 0.1`);
  const expectedTau = SR / 220;
  assert.ok(
    Math.abs(detail.tauRaw - expectedTau) <= 1,
    `selected tau ${detail.tauRaw} is not the fundamental period (~${expectedTau.toFixed(1)}); ` +
      'a multiple of it means a later dip was chosen'
  );
  assert.ok(errorPct(detail.hz, 220) <= 1, `220 Hz reported as ${detail.hz} — subharmonic error`);

  // Raising the bar until nothing qualifies must yield null, not the deepest
  // dip found anyway: the threshold has to be a real gate.
  assert.strictEqual(
    w.sandbox.yinPitch(sine(440, { length: FRAME }), SR, 1e-9),
    null,
    'an unreachable threshold still produced a pitch — the 0.1 gate is not being applied'
  );
  // ...and the same buffer at the contract threshold does resolve.
  assert.ok(
    w.sandbox.yinPitch(sine(440, { length: FRAME }), SR, 0.1) !== null,
    'the same buffer failed at the contract threshold of 0.1'
  );
});

s.test('YIN: parabolic interpolation refines the tau estimate sub-sample', () => {
  const w = loadWorkerSandbox(INDEX);

  // Off-bin frequencies: no integer tau can represent them, so interpolation is
  // the only thing that can close the gap. 1040 Hz sits at the top of the band
  // where integer-tau granularity is coarsest (tau ~ 42).
  for (const freq of [261.63, 523.25, 1040]) {
    const detail = w.sandbox.yinDetect(sine(freq, { length: FRAME }), SR);
    assert.ok(detail, `yinDetect returned null for ${freq} Hz`);
    assert.notStrictEqual(
      detail.tau,
      detail.tauRaw,
      `${freq} Hz produced an integer tau (${detail.tau}) — no interpolation happened`
    );
    assert.ok(
      Math.abs(detail.tau - detail.tauRaw) < 1,
      `${freq} Hz: interpolation moved tau by more than one sample (${detail.tauRaw} -> ${detail.tau})`
    );
    const refined = errorPct(detail.hz, freq);
    const raw = errorPct(detail.hzRaw, freq);
    assert.ok(
      refined < raw,
      `${freq} Hz: interpolated error ${refined.toFixed(4)}% did not beat raw integer-tau error ` +
        `${raw.toFixed(4)}% (${detail.hz.toFixed(3)} vs ${detail.hzRaw.toFixed(3)} Hz)`
    );
    assert.ok(
      refined < 0.1,
      `${freq} Hz: interpolated error ${refined.toFixed(4)}% is too large for sub-sample precision`
    );
  }
});

s.test('YIN: 2048-sample buffer @44.1kHz is the analysis window', () => {
  const w = loadWorkerSandbox(INDEX);

  assert.strictEqual(w.evaluate('F0_MIN_HZ'), 65, 'F0 search band must start at 65 Hz');
  assert.strictEqual(w.evaluate('F0_MAX_HZ'), 1050, 'F0 search band must end at 1050 Hz');

  const detail = w.sandbox.yinDetect(sine(440, { length: FRAME }), SR);
  assert.ok(detail, 'yinDetect returned null for the reference 2048-sample frame');
  assert.strictEqual(
    detail.tauMin,
    Math.ceil(SR / 1050),
    `tau search must start at ceil(sr/1050) = ${Math.ceil(SR / 1050)}, got ${detail.tauMin}`
  );
  assert.strictEqual(
    detail.tauMax,
    Math.floor(SR / 65),
    `tau search must end at floor(sr/65) = ${Math.floor(SR / 65)}, got ${detail.tauMax}`
  );

  // The window has to be long enough to hold the longest period it searches for,
  // twice over, or the lowest lags would be measured on a fraction of a cycle.
  assert.ok(
    FRAME >= 2 * detail.tauMax,
    `a ${FRAME}-sample window cannot support a maximum lag of ${detail.tauMax} samples`
  );

  // A buffer too short to hold even the shortest searched lag has no pitch to
  // report — and must say so rather than throw or invent one.
  let short;
  assert.doesNotThrow(() => {
    short = w.sandbox.yinPitch(new Float32Array(4), SR);
  }, 'yinPitch threw on a buffer shorter than the search band');
  assert.strictEqual(short, null, 'a 4-sample buffer produced a pitch');

  // The window is a parameter, not a hard-coded constant: a different (valid)
  // sample rate rescales the band instead of breaking it.
  const at48k = w.sandbox.yinDetect(sine(440, { length: FRAME, sampleRate: 48000 }), 48000);
  assert.ok(at48k, 'yinDetect returned null at 48 kHz');
  assert.strictEqual(at48k.tauMin, Math.ceil(48000 / 1050), 'tauMin did not follow the sample rate');
  assert.ok(errorPct(at48k.hz, 440) <= 1, `440 Hz at 48 kHz detected as ${at48k.hz}`);
});

s.test('YIN: returns null/-1 (not a fabricated Hz) for silence and pure noise', () => {
  const w = loadWorkerSandbox(INDEX);

  assert.strictEqual(
    w.sandbox.yinPitch(new Float32Array(FRAME), SR),
    null,
    'digital silence produced a pitch'
  );

  // A DC offset is perfectly "periodic" at every lag and is the classic way a
  // naive autocorrelator invents a reading.
  assert.strictEqual(
    w.sandbox.yinPitch(new Float32Array(FRAME).fill(0.5), SR),
    null,
    'a constant DC buffer produced a pitch'
  );

  // Seeded noise: reproducible, and broad enough that a lucky seed cannot hide
  // a detector that guesses.
  for (let seed = 1; seed <= 12; seed += 1) {
    const noise = whiteNoise(FRAME, 0.6, seed * 7919);
    const detected = w.sandbox.yinPitch(noise, SR);
    assert.strictEqual(
      detected,
      null,
      `white noise (seed ${seed * 7919}) produced a pitch of ${detected} Hz`
    );
  }

  // The worker must contain no random source at all (anti-simulation rule).
  assert.ok(
    !/Math\s*\.\s*random/.test(stripComments(w.source)),
    '#dsp-worker-src calls Math.random — DSP output must be measured, never generated'
  );

  // ...and analysis must be deterministic: the same frame in, the same numbers
  // out, every time. A detector that guessed could not manage that.
  const probe = sine(330, { length: FRAME });
  const first = w.sandbox.handleMessage({ type: 'analyze', seq: 0, sampleRate: SR, samples: probe });
  const second = w.sandbox.handleMessage({ type: 'analyze', seq: 0, sampleRate: SR, samples: probe });
  for (const field of ['rms', 'gated', 'pitchHz', 'midiNote']) {
    assert.strictEqual(
      second[field],
      first[field],
      `"${field}" changed between two identical analyses (${first[field]} -> ${second[field]})`
    );
  }
});

/* ------------------------------------------------------------------------ *
 * RMS + noise gate (docs/FEATURE-MECHANICS.md §1.2)
 * ------------------------------------------------------------------------ */

s.test('RMS noise gate: buffers below 0.015 RMS are gated out', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(w.evaluate('RMS_GATE'), 0.015, 'the noise gate threshold must be 0.015');

  // A clean 440 Hz tone, just too quiet to be a deliberate hum.
  const quiet = sine(440, { amplitude: 0.01 });
  const level = w.sandbox.rms(quiet);
  assert.ok(level < 0.015, `test signal is not actually below the gate (rms ${level})`);
  assert.strictEqual(w.sandbox.isGated(level), true, `rms ${level} should have been gated`);

  const reply = w.sandbox.handleMessage({ type: 'analyze', seq: 0, sampleRate: SR, samples: quiet });
  assert.strictEqual(reply.gated, true, 'analyze did not report the frame as gated');
  assert.strictEqual(reply.pitchHz, null, 'a gated frame must not carry a pitch');
  assert.strictEqual(reply.midiNote, null, 'a gated frame must not carry a MIDI note');
  assert.ok(reply.rms < 0.015, 'analyze reported an rms above the gate for a gated frame');

  // Silence is gated too, and reports an honest zero rather than a floor value.
  const silent = w.sandbox.handleMessage({
    type: 'analyze',
    seq: 1,
    sampleRate: SR,
    samples: new Float32Array(FRAME),
  });
  assert.strictEqual(silent.gated, true, 'digital silence was not gated');
  assert.strictEqual(silent.rms, 0, `silence reported rms ${silent.rms}`);
  assert.strictEqual(silent.pitchHz, null, 'silence produced a pitch');
});

s.test('RMS noise gate: buffers at or above 0.015 RMS pass through to pitch analysis', () => {
  const w = loadWorkerSandbox(INDEX);
  const GATE = 0.015;

  // The boundary rule, stated exactly: the gate is a strict "below".
  assert.strictEqual(w.sandbox.isGated(GATE), false, 'a frame AT exactly 0.015 must pass');
  assert.strictEqual(
    w.sandbox.isGated(GATE - Number.EPSILON),
    true,
    'the next representable value below 0.015 must be gated'
  );
  assert.strictEqual(w.sandbox.isGated(0), true, 'silence must be gated');

  // ...and on a real buffer. A plain array of doubles is used so the amplitude
  // is not first rounded down by Float32 storage (0.015 has no exact float32
  // representation, and 0.014999999 would be gated — correctly).
  const atGate = [];
  for (let i = 0; i < 512; i += 1) atGate.push(i % 2 === 0 ? GATE : -GATE);
  const level = w.sandbox.rms(atGate);
  assert.ok(level >= GATE, `constructed buffer sits below the gate (rms ${level})`);
  assert.strictEqual(w.sandbox.isGated(level), false, `rms ${level} was gated at the boundary`);

  // A comfortably audible hum passes and is analysed.
  const audible = sine(220, { amplitude: 0.4 });
  const reply = w.sandbox.handleMessage({
    type: 'analyze',
    seq: 0,
    sampleRate: SR,
    samples: audible,
  });
  assert.strictEqual(reply.gated, false, 'an audible frame was gated');
  assert.ok(reply.rms >= GATE, `audible frame reported rms ${reply.rms}`);
  assert.ok(reply.pitchHz !== null, 'an ungated, clearly pitched frame produced no pitch');
  assert.ok(errorPct(reply.pitchHz, 220) <= 1, `220 Hz hum reported as ${reply.pitchHz} Hz`);
});

s.test('RMS: computed as sqrt(mean(x^2)) over the whole buffer', () => {
  const w = loadWorkerSandbox(INDEX);

  // The closed form: a sine of amplitude A has RMS exactly A/sqrt(2).
  for (const amp of [1, 0.5, 0.25, 0.1, 0.02]) {
    // A whole number of cycles inside the frame, so the identity is exact.
    const buf = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) buf[i] = amp * Math.sin((2 * Math.PI * 20 * i) / FRAME);
    const got = w.sandbox.rms(buf);
    const expected = amp / Math.SQRT2;
    assert.ok(
      errorPct(got, expected) < 1e-4,
      `amplitude ${amp}: rms ${got} != A/sqrt(2) = ${expected}`
    );
  }

  // Degenerate shapes, each with an unambiguous right answer.
  assert.strictEqual(w.sandbox.rms(new Float32Array(FRAME)), 0, 'rms of silence must be 0');
  assert.strictEqual(w.sandbox.rms(new Float32Array(0)), 0, 'rms of an empty buffer must be 0');
  assert.strictEqual(w.sandbox.rms([3, -3, 3, -3]), 3, 'rms of a +/-3 square must be 3');
  assert.strictEqual(w.sandbox.rms([0.5, 0.5]), 0.5, 'rms of a constant must be that constant');
  // sqrt(mean([1,4,9])) = sqrt(14/3)
  assert.ok(
    Math.abs(w.sandbox.rms([1, 2, 3]) - Math.sqrt(14 / 3)) < 1e-12,
    'rms is not sqrt(mean(x^2)) on a hand-computed case'
  );
  // Sign must be irrelevant — it is a magnitude.
  assert.strictEqual(
    w.sandbox.rms([1, 2, 3]),
    w.sandbox.rms([-1, -2, -3]),
    'rms changed with the sign of the input'
  );
  // Non-buffers must not throw.
  assert.doesNotThrow(() => w.sandbox.rms(null), 'rms threw on null');
  assert.strictEqual(w.sandbox.rms(null), 0);
});

/* ------------------------------------------------------------------------ *
 * Onset detection + BPM (docs/FEATURE-MECHANICS.md §1.3)
 * ------------------------------------------------------------------------ */

s.test('Onset detection: energy/spectral-flux peaks locate transients in a click train', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(typeof w.sandbox.detectOnsets, 'function', 'detectOnsets() is not top-level');

  const train = clickTrain({ bpm: REF_BPM, seconds: 4 });
  // priorEnergy 0 states "silence preceded this buffer", so the click sitting on
  // sample 0 is a genuine rise rather than an unknown.
  const onsets = w.sandbox.detectOnsets(train.samples, SR, { priorEnergy: 0 });

  assert.strictEqual(
    onsets.length,
    train.clickTimesMs.length,
    `expected ${train.clickTimesMs.length} onsets, got ${onsets.length}: ` +
      onsets.map((x) => x.toFixed(1)).join(', ')
  );
  for (let i = 0; i < onsets.length; i += 1) {
    const drift = Math.abs(onsets[i] - train.clickTimesMs[i]);
    assert.ok(
      drift <= 2,
      `onset ${i} landed at ${onsets[i].toFixed(2)} ms, ${drift.toFixed(2)} ms from the click at ` +
        `${train.clickTimesMs[i].toFixed(2)} ms (tolerance 2 ms)`
    );
  }
  // Ascending and never double-triggering on one transient.
  for (let i = 1; i < onsets.length; i += 1) {
    assert.ok(onsets[i] > onsets[i - 1], `onsets are not ascending at index ${i}`);
  }

  // Nothing to find means nothing reported. (Arrays built inside the vm realm
  // do not share the host's Array.prototype, so compare lengths, not shapes.)
  const fromSilence = w.sandbox.detectOnsets(new Float32Array(SR), SR, { priorEnergy: 0 });
  assert.strictEqual(fromSilence.length, 0, `silence produced ${fromSilence.length} onsets`);

  // A frame below the noise gate cannot host a beat, however "spiky" it is.
  const tooQuiet = clickTrain({ bpm: REF_BPM, seconds: 2 });
  for (let i = 0; i < tooQuiet.samples.length; i += 1) tooQuiet.samples[i] *= 0.005;
  const fromQuiet = w.sandbox.detectOnsets(tooQuiet.samples, SR, { priorEnergy: 0 });
  assert.strictEqual(
    fromQuiet.length,
    0,
    `transients below the RMS gate were reported as ${fromQuiet.length} onsets`
  );

  // The energy envelope itself: one value per 256-sample hop.
  const env = w.sandbox.energyEnvelope(new Float32Array(2048), 256);
  assert.strictEqual(env.length, 8, `a 2048-sample frame should yield 8 hops, got ${env.length}`);
});

s.test('BPM: estimated as 60000 / median inter-onset-interval (ms)', () => {
  const w = loadWorkerSandbox(INDEX);

  // The median itself, on hand-computable inputs.
  assert.strictEqual(w.sandbox.medianOf([3, 1, 2]), 2, 'median of an odd-length list');
  assert.strictEqual(w.sandbox.medianOf([1, 2, 3, 4]), 2.5, 'median of an even-length list');
  assert.strictEqual(w.sandbox.medianOf([1, 2, 3, 1000]), 2.5, 'an outlier moved the median');
  assert.strictEqual(w.sandbox.medianOf([]), null, 'median of nothing must be null');

  const beatMs = 60000 / REF_BPM;

  // One spurious onset, 30% of the way into a beat, splits a single interval
  // into two short ones. The median must not notice; the mean cannot help it.
  const clean = clickTrain({ bpm: REF_BPM, seconds: 6 });
  const spiked = clickTrain({ bpm: REF_BPM, seconds: 6, extraMs: [10 * beatMs + 0.3 * beatMs] });

  function trackAll(samples) {
    const tracker = w.sandbox.createBpmTracker(SR);
    let last = null;
    for (const chunk of chunksOf(samples, FRAME)) last = tracker.push(chunk);
    return { tracker, last };
  }

  const a = trackAll(clean.samples);
  const b = trackAll(spiked.samples);
  assert.ok(a.last.bpm !== null && b.last.bpm !== null, 'the tracker produced no estimate');
  assert.ok(
    b.tracker.onsetCount() > a.tracker.onsetCount(),
    'the spurious click was never detected, so this proves nothing'
  );
  assert.ok(
    Math.abs(b.last.bpm - a.last.bpm) < 0.5,
    `a single spurious onset moved the estimate from ${a.last.bpm.toFixed(3)} to ` +
      `${b.last.bpm.toFixed(3)} BPM — the estimator is not using the median`
  );

  // Show that the mean WOULD have been fooled, so the assertion above has teeth.
  const times = b.tracker.onsetTimes();
  const meanIbi = (times[times.length - 1] - times[0]) / (times.length - 1);
  const meanBpm = 60000 / meanIbi;
  assert.ok(
    Math.abs(meanBpm - REF_BPM) > 5,
    `the mean IBI would also have given ${meanBpm.toFixed(1)} BPM — pick a harsher spurious onset ` +
      'or this test cannot distinguish median from mean'
  );

  // And the reported value really is 60000 / median(IBI) of the window.
  const ibis = [];
  for (let i = 1; i < times.length; i += 1) ibis.push(times[i] - times[i - 1]);
  const expected = 60000 / w.sandbox.medianOf(ibis);
  assert.ok(
    Math.abs(b.last.bpm - expected) < 1e-9,
    `reported ${b.last.bpm} but 60000/median(IBI) over the window is ${expected}`
  );
});

s.test('BPM: a synthesized 124 BPM click train resolves to 124 +/- 1', () => {
  const w = loadWorkerSandbox(INDEX);

  // Driven through the REAL message protocol, chunk by chunk, exactly as the
  // capture pump feeds it: 2048-sample frames, seq starting at 0.
  const train = clickTrain({ bpm: REF_BPM, seconds: 6, noise: 0.004 });
  const frames = chunksOf(train.samples, FRAME);
  let last = null;
  frames.forEach((samples, seq) => {
    last = w.send({ type: 'analyze', seq, sampleRate: SR, samples });
  });

  assert.strictEqual(last.type, 'analysis', `final reply was "${last.type}"`);
  assert.ok(last.bpm !== null, 'a 6-second 124 BPM click train produced no tempo at all');
  assert.ok(
    Math.abs(last.bpm - REF_BPM) <= 1,
    `expected ${REF_BPM} +/- 1 BPM, got ${last.bpm.toFixed(3)}`
  );

  // Not a lucky constant: other tempos resolve too.
  for (const bpm of [90, 140, 174]) {
    const other = clickTrain({ bpm, seconds: 6 });
    const tracker = w.sandbox.createBpmTracker(SR);
    let result = null;
    for (const chunk of chunksOf(other.samples, FRAME)) result = tracker.push(chunk);
    assert.ok(result.bpm !== null, `${bpm} BPM click train produced no estimate`);
    assert.ok(
      Math.abs(result.bpm - bpm) <= 1,
      `expected ${bpm} +/- 1 BPM, got ${result.bpm.toFixed(3)}`
    );
  }
});

s.test('BPM: fewer than 2 onsets yields no estimate rather than a fabricated tempo', () => {
  const w = loadWorkerSandbox(INDEX);

  const fresh = w.sandbox.createBpmTracker(SR);
  assert.strictEqual(fresh.bpm(), null, 'a tracker that has seen nothing reported a tempo');
  assert.strictEqual(fresh.onsetCount(), 0, 'a fresh tracker already holds onsets');

  // Exactly one transient: an interval needs two.
  const single = clickTrain({ bpm: REF_BPM, seconds: 1 }).samples.subarray(0, FRAME);
  const afterOne = fresh.push(single);
  assert.strictEqual(fresh.onsetCount(), 1, `expected 1 onset, got ${fresh.onsetCount()}`);
  assert.strictEqual(afterOne.bpm, null, `one onset produced a tempo of ${afterOne.bpm}`);

  // Silence forever: still nothing, and the window eventually ages the lone
  // onset out rather than keeping it alive to prop up an estimate.
  const quiet = w.sandbox.createBpmTracker(SR);
  let result = null;
  for (let i = 0; i < 120; i += 1) result = quiet.push(new Float32Array(FRAME));
  assert.strictEqual(result.bpm, null, `${result.bpm} BPM was reported for pure silence`);
  assert.strictEqual(quiet.onsetCount(), 0, 'silence accumulated onsets');

  // A tempo far outside any musical range is not a tempo: report nothing.
  assert.strictEqual(w.evaluate('BPM_MIN'), 40, 'BPM_MIN contract changed');
  assert.strictEqual(w.evaluate('BPM_MAX'), 240, 'BPM_MAX contract changed');
  const noisy = w.sandbox.createBpmTracker(SR);
  let noiseResult = null;
  for (let i = 0; i < 100; i += 1) noiseResult = noisy.push(whiteNoise(FRAME, 0.3, 1000 + i));
  assert.strictEqual(
    noiseResult.bpm,
    null,
    `loud white noise produced a tempo of ${noiseResult.bpm} BPM`
  );

  // reset() drops the history a new capture session must not inherit.
  const reused = w.sandbox.createBpmTracker(SR);
  for (const chunk of chunksOf(clickTrain({ bpm: REF_BPM, seconds: 6 }).samples, FRAME)) {
    reused.push(chunk);
  }
  assert.ok(reused.bpm() !== null, 'the tracker never locked on before reset()');
  reused.reset();
  assert.strictEqual(reused.bpm(), null, 'reset() left a tempo behind');
  assert.strictEqual(reused.onsetCount(), 0, 'reset() left onsets behind');
});

/* ------------------------------------------------------------------------ *
 * 'analyze' protocol + pitch mapping
 * ------------------------------------------------------------------------ */

s.test("worker exposes 'analyze' message type returning {type:'analysis', pitchHz, rms, bpm}", () => {
  const w = loadWorkerSandbox(INDEX);

  const reply = w.send({ type: 'analyze', seq: 12, sampleRate: SR, samples: sine(440) });
  assert.ok(reply, 'worker posted no reply to analyze');
  assert.strictEqual(reply.type, 'analysis', `expected "analysis", got "${reply.type}"`);
  assert.strictEqual(reply.seq, 12, 'analysis must echo the frame seq so it doubles as the ack');
  assert.strictEqual(reply.samples, FRAME, 'analysis must report the analysed frame length');
  assert.strictEqual(reply.sampleRate, SR, 'analysis must echo the sample rate it worked at');

  for (const field of ['rms', 'gated', 'pitchHz', 'midiNote', 'bpm']) {
    assert.ok(field in reply, `analysis reply is missing the "${field}" field`);
  }
  assert.strictEqual(typeof reply.rms, 'number', 'rms must always be a number');
  assert.strictEqual(typeof reply.gated, 'boolean', 'gated must always be a boolean');
  assert.strictEqual(reply.gated, false, 'a full-scale 440 Hz tone was gated');
  assert.ok(errorPct(reply.pitchHz, 440) <= 1, `440 Hz analysed as ${reply.pitchHz} Hz`);
  assert.strictEqual(reply.midiNote, 69, `440 Hz must map to MIDI 69, got ${reply.midiNote}`);
  assert.strictEqual(reply.bpm, null, 'a single frame cannot contain a tempo yet reported one');

  // Exactly one reply per message, like every other command.
  assert.strictEqual(w.replies.length, 1, `expected 1 reply, got ${w.replies.length}`);

  // handleMessage stays pure and callable without `self` or any tracker.
  const pure = w.sandbox.handleMessage({ type: 'analyze', seq: 0, sampleRate: SR, samples: sine(220) });
  assert.strictEqual(pure.type, 'analysis', 'handleMessage("analyze") is not callable standalone');
  assert.strictEqual(pure.bpm, null, 'without a tracker there is no history, so bpm must be null');

  // Malformed payloads: an error naming the command, never a throw and never a
  // half-filled analysis.
  const malformed = [
    { type: 'analyze', sampleRate: SR, samples: sine(440) },
    { type: 'analyze', seq: '0', sampleRate: SR, samples: sine(440) },
    { type: 'analyze', seq: NaN, sampleRate: SR, samples: sine(440) },
    { type: 'analyze', seq: 0, sampleRate: SR },
    { type: 'analyze', seq: 0, sampleRate: SR, samples: null },
    { type: 'analyze', seq: 0, sampleRate: SR, samples: 2048 },
    { type: 'analyze', seq: 0, sampleRate: SR, samples: 'not-audio' },
    { type: 'analyze', seq: 0, sampleRate: SR, samples: new Float32Array(0) },
    { type: 'analyze', seq: 0, sampleRate: 0, samples: sine(440) },
    { type: 'analyze', seq: 0, sampleRate: -44100, samples: sine(440) },
    { type: 'analyze', seq: 0, sampleRate: 'fast', samples: sine(440) },
  ];
  for (const msg of malformed) {
    const sandbox = loadWorkerSandbox(INDEX);
    let bad;
    assert.doesNotThrow(() => {
      bad = sandbox.send(msg);
    }, `worker threw on malformed analyze: ${JSON.stringify(msg)}`);
    assert.ok(bad, `no reply for malformed analyze: ${JSON.stringify(msg)}`);
    assert.strictEqual(
      bad.type,
      'error',
      `expected "error" for ${JSON.stringify(msg)}, got "${bad.type}"`
    );
    assert.ok(/analyze/.test(bad.error), `error should name analyze; got "${bad.error}"`);
  }

  // sampleRate may be omitted entirely — it falls back to the 44.1 kHz contract.
  const defaulted = w.sandbox.handleMessage({ type: 'analyze', seq: 3, samples: sine(440) });
  assert.strictEqual(defaulted.type, 'analysis', 'omitting sampleRate must not be an error');
  assert.strictEqual(defaulted.sampleRate, SR, 'the default sample rate must be 44100');

  // 'ping' and 'audio-chunk' are untouched by the extension.
  const w2 = loadWorkerSandbox(INDEX);
  assert.strictEqual(w2.send({ type: 'ping' }).type, 'pong', 'ping regressed');
  assert.strictEqual(
    w2.send({ type: 'audio-chunk', seq: 1, sampleRate: SR, samples: new Float32Array(8) }).type,
    'chunk-ack',
    'audio-chunk regressed'
  );
});

s.test('pitch mapping: midiNoteFromHz and 12-TET snapping follow the FDD formulas', () => {
  const w = loadWorkerSandbox(INDEX);

  // n = round(69 + 12 * log2(F0 / 440)) — A4 is the anchor.
  assert.strictEqual(w.sandbox.midiNoteFromHz(440), 69, 'A4 (440 Hz) must be MIDI 69');
  assert.strictEqual(w.sandbox.midiNoteFromHz(880), 81, 'an octave up must add 12');
  assert.strictEqual(w.sandbox.midiNoteFromHz(220), 57, 'an octave down must subtract 12');
  assert.strictEqual(w.sandbox.midiNoteFromHz(261.6256), 60, 'middle C must be MIDI 60');
  assert.strictEqual(w.sandbox.midiNoteFromHz(466.1638), 70, 'A#4 must be MIDI 70');

  // A microtonal hum rounds to its nearest neighbour, in both directions.
  assert.strictEqual(w.sandbox.midiNoteFromHz(445), 69, '445 Hz is still an A4');
  assert.strictEqual(w.sandbox.midiNoteFromHz(435), 69, '435 Hz is still an A4');
  assert.strictEqual(w.sandbox.midiNoteFromHz(455), 70, '455 Hz has crossed into A#4');

  // Nothing is a note number unless it is one.
  for (const bad of [0, -5, NaN, Infinity, 'x', null, undefined]) {
    assert.strictEqual(
      w.sandbox.midiNoteFromHz(bad),
      null,
      `midiNoteFromHz(${String(bad)}) must be null`
    );
  }

  // §1.4 sanitizer: snap to the exact 12-TET frequency, discarding the cents.
  assert.strictEqual(w.sandbox.snapHzToSemitone(445), 440, '445 Hz must snap to exactly 440');
  assert.strictEqual(w.sandbox.hzFromMidiNote(69), 440, 'MIDI 69 must be exactly 440 Hz');
  assert.ok(
    Math.abs(w.sandbox.hzFromMidiNote(60) - 261.6255653) < 1e-6,
    'MIDI 60 must be 261.6256 Hz'
  );
  assert.ok(
    Math.abs(w.sandbox.centsFromSemitone(445) - 19.56) < 0.01,
    `445 Hz should be ~19.56 cents sharp of A4, got ${w.sandbox.centsFromSemitone(445)}`
  );
  // Snapping is idempotent: a snapped frequency is already on the grid.
  const snapped = w.sandbox.snapHzToSemitone(523.1);
  assert.strictEqual(
    w.sandbox.snapHzToSemitone(snapped),
    snapped,
    'snapping a snapped frequency moved it'
  );

  // End to end: a detected pitch and its MIDI note agree with each other.
  const reply = w.sandbox.handleMessage({
    type: 'analyze',
    seq: 0,
    sampleRate: SR,
    samples: sine(523.25),
  });
  assert.strictEqual(reply.midiNote, 72, `523.25 Hz (C5) must map to MIDI 72, got ${reply.midiNote}`);
  assert.strictEqual(
    reply.midiNote,
    w.sandbox.midiNoteFromHz(reply.pitchHz),
    'analysis.midiNote disagrees with midiNoteFromHz(analysis.pitchHz)'
  );
});

/* ------------------------------------------------------------------------ *
 * Performance budget: docs/FEATURE-MECHANICS.md §1.2 caps one 2048-sample YIN
 * pass at 5 ms so the worker never becomes the bottleneck that pushes the UI
 * thread off 60 FPS.
 * ------------------------------------------------------------------------ */

s.test('perf: one 2048-sample YIN pass @44.1kHz stays under the 5ms budget', () => {
  const w = loadWorkerSandbox(INDEX);
  const buf = sine(440, { length: FRAME });

  // Warm up so the measurement reflects steady state, not first-call compilation.
  for (let i = 0; i < 5; i += 1) w.sandbox.yinPitch(buf, SR);

  const runs = 25;
  const timings = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    const detected = w.sandbox.yinPitch(buf, SR);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.ok(detected !== null, `run ${i} produced no pitch — timing a no-op proves nothing`);
  }
  timings.sort((a, b) => a - b);
  const median = timings[timings.length >> 1];
  const slowest = timings[timings.length - 1];

  console.log(
    `         measured YIN: median ${median.toFixed(3)}ms, worst ${slowest.toFixed(3)}ms ` +
      `over ${runs} runs (budget 5ms)`
  );

  assert.ok(
    median < 5,
    `median YIN pass took ${median.toFixed(3)}ms over ${runs} runs — the budget is 5ms`
  );
  // One frame arrives every ~46ms; even the worst pass must leave room for the
  // onset/BPM work that shares the same message.
  assert.ok(
    slowest < 20,
    `slowest YIN pass took ${slowest.toFixed(3)}ms, which would stall the chunk pump`
  );
});

module.exports = { SEMVER, lcg, sine, whiteNoise, clickTrain };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
