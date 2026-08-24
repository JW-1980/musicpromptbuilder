'use strict';
/*
 * tests/dsp-worker.test.js — behavioural tests for the inline DSP Web Worker.
 *
 * The worker source lives in <script id="dsp-worker-src" type="text/js-worker">
 * inside index.html. tests/lib/extract.js pulls it out and runs it in a
 * node:vm sandbox with a `self` stub, so we exercise the REAL message protocol
 * with no browser and no build step.
 *
 * Implemented today: the message protocol (ping/pong, unknown type, malformed
 * input). The DSP maths itself (YIN pitch detection, RMS noise gate, onset/BPM
 * estimation) is not written yet — those are registered as TODO entries with
 * their exact planned parameters so the harness reports honest coverage rather
 * than faking passes. Convert each todo() into a test() as the algorithm lands.
 *
 * Node built-ins only: path, assert.
 */

const path = require('node:path');
const assert = require('node:assert');
const { suite } = require('./lib/runner.js');
const { loadWorkerSandbox } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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
 * TODO: DSP maths. Activate each entry when the corresponding algorithm
 * lands in #dsp-worker-src. Parameters below are the agreed contract
 * (docs/FEATURE-MECHANICS.md / docs/FDD.md) — do not drift from them.
 * ------------------------------------------------------------------------ */

s.todo(
  'YIN: detects synthesized sine pitch across 65-1050 Hz within tolerance',
  'sweep A1(55)-C6 band, 2048-sample buffers @44.1kHz; activate when yinPitch() ships'
);
s.todo(
  'YIN: difference/CMND threshold of 0.1 selects the first qualifying dip',
  'absolute threshold 0.1 per the YIN paper; activate when yinPitch() ships'
);
s.todo(
  'YIN: parabolic interpolation refines the tau estimate sub-sample',
  'interpolated result must beat the raw integer-tau result on off-bin frequencies'
);
s.todo(
  'YIN: 2048-sample buffer @44.1kHz is the analysis window',
  'buffer length 2048, sampleRate 44100; assert the window contract explicitly'
);
s.todo(
  'YIN: returns null/-1 (not a fabricated Hz) for silence and pure noise',
  'anti-simulation rule — no Math.random() pitch fakers'
);
s.todo(
  'RMS noise gate: buffers below 0.015 RMS are gated out',
  'gate threshold 0.015; activate when rms()/noise gate ships'
);
s.todo(
  'RMS noise gate: buffers at or above 0.015 RMS pass through to pitch analysis',
  'boundary test at exactly 0.015'
);
s.todo(
  'RMS: computed as sqrt(mean(x^2)) over the whole buffer',
  'verify against a known-amplitude sine: RMS of amp A sine == A/sqrt(2)'
);
s.todo(
  'Onset detection: energy/spectral-flux peaks locate transients in a click train',
  'activate when detectOnsets() ships'
);
s.todo(
  'BPM: estimated as 60000 / median inter-onset-interval (ms)',
  'median IBI, not mean — resists dropped/spurious onsets'
);
s.todo(
  'BPM: a synthesized 124 BPM click train resolves to 124 +/- 1',
  '124 BPM is the studio reference tempo used across the FDD examples'
);
s.todo(
  'BPM: fewer than 2 onsets yields no estimate rather than a fabricated tempo',
  'anti-simulation rule'
);
s.todo(
  "worker exposes 'analyze' message type returning {type:'analysis', pitchHz, rms, bpm}",
  'protocol extension; add alongside the DSP implementation'
);

module.exports = { SEMVER };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
