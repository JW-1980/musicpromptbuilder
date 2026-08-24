'use strict';
/*
 * tests/midi-export.test.js — Direct MIDI Export (FDD #10, FEATURE-MECHANICS §1.1).
 *
 * Two halves, one contract:
 *
 *   WORKER   <script id="dsp-worker-src"> records the pitch contour —
 *            createContourRecorder() plus the 'contour' message. Exercised in a
 *            node:vm sandbox through the REAL message protocol.
 *   MAIN     <script id="app-main"> turns that contour into a Standard MIDI
 *            File: groupContourToNotes -> buildSmf0 -> bytesToBase64.
 *
 * WHY THIS SUITE CARRIES ITS OWN SMF PARSER
 * A byte-blob snapshot ("the file must equal these 87 bytes") proves only that
 * today's output equals today's output. It cannot tell a correct file from a
 * consistently wrong one, and it fails for every harmless change. So this file
 * implements a real Standard MIDI File reader — chunk headers, variable-length
 * quantities, running status, meta events, channel messages — and every
 * assertion below runs against DECODED STRUCTURE: "this note_on is answered by
 * a note_off 372 ticks later", not "byte 41 is 0x90". If the writer and the
 * reader ever disagree about the format, the reader throws.
 *
 * The parser is deliberately strict. It refuses a short chunk, a VLQ longer
 * than four bytes, a data byte with no running status, a note_off with no
 * matching note_on and a note_on never released — every one of which is a way
 * a hand-rolled MIDI writer typically goes wrong.
 *
 * SIGNAL SYNTHESIS LIVES HERE, NEVER IN index.html (ENGINEERING-STANDARD §1.2).
 * The end-to-end test hums a sine at the harness, not at the product, and
 * everything random is a seeded LCG so a failure is reproducible.
 *
 * Node built-ins only: fs, path, assert, vm.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const vm = require('node:vm');
const { suite } = require('./lib/runner.js');
const { extractScriptById, loadWorkerSandbox } = require('./lib/extract.js');

const INDEX = path.resolve(__dirname, '..', 'index.html');

/* Capture contract (docs/FEATURE-MECHANICS.md §1.2). */
const SR = 44100;
const FRAME = 2048;
/** One analysis frame in ms — the contour's natural time step. */
const FRAME_MS = (FRAME / SR) * 1000;

const s = suite('midi-export (Direct MIDI Export — FDD #10, MECHANICS §1.1)');

/* -------------------------------------------------------------------------- */
/* Cross-realm comparison                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a value that came out of a vm context into THIS realm.
 * `deepStrictEqual` compares prototypes, and an object or array built inside a
 * vm context carries that context's Object.prototype — so without this every
 * structural comparison fails with "same structure but not reference-equal",
 * which says nothing about the code under test.
 */
function realm(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** assert.deepStrictEqual with both sides normalised into this realm first. */
function deepEqual(actual, expected, message) {
  assert.deepStrictEqual(realm(actual), realm(expected), message);
}

/* -------------------------------------------------------------------------- */
/* Sandboxes                                                                  */
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
/* Deterministic test-signal synthesis (harness only)                          */
/* -------------------------------------------------------------------------- */

/** Seeded 32-bit LCG (Numerical Recipes constants) -> [0, 1). */
function lcg(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A sine of `freq` Hz, one analysis frame long. */
function sine(freq, amplitude) {
  const amp = amplitude === undefined ? 0.5 : amplitude;
  const buf = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) buf[i] = amp * Math.sin(2 * Math.PI * freq * (i / SR));
  return buf;
}

/** Digital silence — below the RMS gate by construction. */
function silence() {
  return new Float32Array(FRAME);
}

/** A contour frame list on a fixed grid: notes[i] at i * stepMs. */
function contourOf(notes, stepMs) {
  const step = stepMs === undefined ? 100 : stepMs;
  const out = [];
  for (let i = 0; i < notes.length; i += 1) out.push({ n: notes[i], t: i * step });
  return out;
}

/* -------------------------------------------------------------------------- */
/* A REAL Standard MIDI File parser (test-owned)                              */
/* -------------------------------------------------------------------------- */

/**
 * Read a complete SMF into structure. Throws — loudly and specifically — on
 * anything the format forbids.
 *
 * @param {Uint8Array|number[]} bytes
 * @returns {{format:number, ntrks:number, division:number, ppq:number|null,
 *            fileLength:number, tracks:Array<object>}}
 */
function parseSmf(bytes) {
  const b = bytes;
  let p = 0;

  function need(n, what) {
    if (p + n > b.length) {
      throw new Error(`${what}: needs ${n} byte(s) at offset ${p}, only ${b.length - p} remain`);
    }
  }
  function u8(what) {
    need(1, what);
    const v = b[p];
    p += 1;
    return v;
  }
  function u16(what) {
    need(2, what);
    const v = (b[p] << 8) | b[p + 1];
    p += 2;
    return v;
  }
  function u32(what) {
    need(4, what);
    // Multiply for the top byte: << 24 would produce a negative int32.
    const v = b[p] * 16777216 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
    p += 4;
    return v;
  }
  function ascii(n, what) {
    need(n, what);
    let out = '';
    for (let i = 0; i < n; i += 1) out += String.fromCharCode(b[p + i]);
    p += n;
    return out;
  }
  /** Variable-length quantity: 7 bits per byte, 0x80 = "another byte follows". */
  function vlq(what) {
    let value = 0;
    let used = 0;
    for (;;) {
      const byte = u8(what);
      used += 1;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
      if (used === 4) throw new Error(`${what}: VLQ longer than 4 bytes at offset ${p}`);
    }
    return { value: value, bytes: used };
  }

  const magic = ascii(4, 'MThd magic');
  if (magic !== 'MThd') throw new Error(`file does not open with "MThd" (got "${magic}")`);
  const headerLength = u32('MThd length');
  if (headerLength !== 6) throw new Error(`MThd length must be 6, got ${headerLength}`);
  const format = u16('format');
  const ntrks = u16('ntrks');
  const division = u16('division');

  const tracks = [];
  while (p < b.length) {
    const id = ascii(4, 'chunk id');
    const declaredLength = u32('chunk length');
    const start = p;
    if (start + declaredLength > b.length) {
      throw new Error(
        `chunk "${id}" declares ${declaredLength} bytes but only ${b.length - start} remain`
      );
    }
    if (id === 'MTrk') tracks.push(parseTrack(start, declaredLength));
    p = start + declaredLength;
  }

  function parseTrack(start, declaredLength) {
    const limit = start + declaredLength;
    const events = [];
    let tick = 0;
    let runningStatus = null;
    let sawEndOfTrack = false;
    p = start;

    while (p < limit) {
      if (sawEndOfTrack) throw new Error(`bytes follow the end-of-track meta event at ${p}`);
      const delta = vlq('delta time');
      tick += delta.value;

      let status = b[p];
      if (status === undefined) throw new Error(`event status ran off the end at ${p}`);
      if (status < 0x80) {
        if (runningStatus === null) {
          throw new Error(`data byte 0x${status.toString(16)} with no running status at ${p}`);
        }
        status = runningStatus;
      } else {
        p += 1;
        if (status < 0xf0) runningStatus = status;
        else runningStatus = null; // system messages cancel running status
      }

      if (status === 0xff) {
        const metaType = u8('meta type');
        const len = vlq('meta length');
        need(len.value, 'meta payload');
        const data = [];
        for (let i = 0; i < len.value; i += 1) data.push(b[p + i]);
        p += len.value;
        const ev = { kind: 'meta', metaType: metaType, tick: tick, delta: delta.value, data: data };
        if (metaType === 0x51) {
          if (data.length !== 3) throw new Error(`set-tempo payload must be 3 bytes, got ${data.length}`);
          ev.usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
          ev.bpm = 60000000 / ev.usPerQuarter;
        }
        if (metaType === 0x03 || metaType === 0x01) {
          ev.text = data.map((c) => String.fromCharCode(c)).join('');
        }
        if (metaType === 0x2f) {
          if (len.value !== 0) throw new Error(`end-of-track payload must be empty, got ${len.value}`);
          sawEndOfTrack = true;
        }
        events.push(ev);
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const len = vlq('sysex length');
        need(len.value, 'sysex payload');
        p += len.value;
        events.push({ kind: 'sysex', tick: tick, delta: delta.value });
        continue;
      }

      const high = status & 0xf0;
      const channel = status & 0x0f;
      const dataBytes = high === 0xc0 || high === 0xd0 ? 1 : 2;
      need(dataBytes, 'channel message data');
      const d1 = b[p];
      const d2 = dataBytes === 2 ? b[p + 1] : null;
      p += dataBytes;
      let kind = 'channel';
      if (high === 0x90) kind = d2 > 0 ? 'note_on' : 'note_off'; // note_on vel 0 == note_off
      else if (high === 0x80) kind = 'note_off';
      events.push({
        kind: kind,
        tick: tick,
        delta: delta.value,
        status: high,
        channel: channel,
        note: d1,
        velocity: d2,
      });
    }

    const consumed = p - start;
    if (consumed !== declaredLength) {
      throw new Error(
        `MTrk length field says ${declaredLength} bytes, the event stream consumed ${consumed}`
      );
    }
    if (!sawEndOfTrack) throw new Error('MTrk has no end-of-track meta event');
    return {
      declaredLength: declaredLength,
      consumedBytes: consumed,
      events: events,
      lastEvent: events[events.length - 1],
      endTick: tick,
    };
  }

  return {
    format: format,
    ntrks: ntrks,
    division: division,
    ppq: (division & 0x8000) === 0 ? division : null,
    fileLength: b.length,
    tracks: tracks,
  };
}

/**
 * Pair a parsed track's note_on / note_off events into notes. Throws on an
 * orphan on either side — a stuck note is the classic hand-rolled-writer bug.
 */
function notesFromTrack(track) {
  const open = new Map();
  const notes = [];
  for (const ev of track.events) {
    if (ev.kind !== 'note_on' && ev.kind !== 'note_off') continue;
    const key = ev.channel + ':' + ev.note;
    if (ev.kind === 'note_on') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(ev);
      continue;
    }
    const stack = open.get(key);
    if (!stack || stack.length === 0) {
      throw new Error(`note_off for note ${ev.note} at tick ${ev.tick} with no matching note_on`);
    }
    const on = stack.shift();
    notes.push({
      note: ev.note,
      channel: ev.channel,
      velocity: on.velocity,
      startTick: on.tick,
      endTick: ev.tick,
      durationTicks: ev.tick - on.tick,
    });
  }
  for (const [key, stack] of open) {
    if (stack.length > 0) throw new Error(`${stack.length} note_on for ${key} never released`);
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.note - b.note);
  return notes;
}

/** Decode a VLQ with the parser above — used to round-trip encodeVlq. */
function decodeVlq(bytes) {
  const framed = new Uint8Array(bytes.length + 3);
  framed.set(bytes, 0);
  // A minimal trailing event so the walker has something legal to stop on.
  framed[bytes.length] = 0xff;
  framed[bytes.length + 1] = 0x2f;
  framed[bytes.length + 2] = 0x00;
  const file = buildFileAroundTrack(framed);
  const parsed = parseSmf(file);
  return parsed.tracks[0].events[0].tick;
}

/** Wrap raw track bytes in a valid MThd/MTrk envelope so parseSmf can read them. */
function buildFileAroundTrack(trackBytes) {
  const len = trackBytes.length;
  const out = new Uint8Array(22 + len);
  const head = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
  ];
  out.set(head, 0);
  out.set(trackBytes, head.length);
  return out;
}

/** ms -> ticks, the contract formula, recomputed independently of the source. */
function expectedTicks(ms, ppq, bpm) {
  return Math.round((ms * ppq * bpm) / 60000);
}

/* -------------------------------------------------------------------------- */
/* Reachability + documented constants                                        */
/* -------------------------------------------------------------------------- */

s.test('the MIDI layer is reachable as top-level function declarations', () => {
  const app = loadAppSandbox();
  for (const name of [
    'groupContourToNotes',
    'encodeVlq',
    'buildSmf0',
    'bytesToBase64',
    'midiFilename',
    'midiTextBytes',
    'medianOfNumbers',
  ]) {
    assert.strictEqual(
      typeof app.sandbox[name],
      'function',
      `${name} must be a top-level \`function\` declaration, before the boot IIFE`
    );
  }
});

s.test('the export constants are the documented ones', () => {
  const app = loadAppSandbox();
  assert.strictEqual(app.evaluate('MIDI_MIN_NOTE_MS'), 90, 'the sub-frame blip floor is 90ms');
  assert.strictEqual(app.evaluate('MIDI_DEFAULT_BPM'), 120);
  assert.strictEqual(app.evaluate('MIDI_DEFAULT_PPQ'), 480);
  assert.strictEqual(app.evaluate('MIDI_DEFAULT_VELOCITY'), 96);
  assert.strictEqual(app.evaluate('MIDI_TRACK_NAME'), 'SunoPrompt hum');
  assert.strictEqual(app.evaluate('MIDI_FILENAME_STEM'), 'sunoprompt-hum');
  // 2048 samples at 44.1kHz. The only length a single-frame contour can honestly
  // claim for its final note.
  const fallback = app.evaluate('MIDI_FALLBACK_FRAME_MS');
  assert.ok(
    Math.abs(fallback - FRAME_MS) < 1e-9,
    `MIDI_FALLBACK_FRAME_MS should be one 2048-sample frame (${FRAME_MS}ms), got ${fallback}`
  );
  assert.strictEqual(
    app.evaluate('BASE64_ALPHABET.length'),
    64,
    'the base64 alphabet must hold exactly 64 symbols'
  );
});

/* -------------------------------------------------------------------------- */
/* groupContourToNotes — MECHANICS §1.1 step 2                                */
/* -------------------------------------------------------------------------- */

s.test('consecutive identical note numbers merge into ONE note, not one per frame', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes(contourOf([69, 69, 69, 69, 69], 100));
  assert.strictEqual(notes.length, 1, `five frames of one pitch must be ONE note, got ${notes.length}`);
  assert.strictEqual(notes[0].note, 69);
  assert.strictEqual(notes[0].startMs, 0);
  // Last frame at 400ms, closed one median gap (100ms) later.
  assert.strictEqual(notes[0].durationMs, 500);
});

s.test('a null frame closes the open note and starts silence', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes(
    contourOf([69, 69, 69, null, null, 72, 72, 72], 100)
  );
  assert.strictEqual(notes.length, 2, `expected two notes around the rest, got ${notes.length}`);
  deepEqual(
    notes.map((n) => [n.note, n.startMs, n.durationMs]),
    [
      [69, 0, 300], // frames 0,1,2 — closed by the null at 300ms
      [72, 500, 300], // frames 5,6,7 — tail-closed at 700 + 100 median gap
    ]
  );
});

s.test('a change of note closes the previous one exactly where the next begins', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes(contourOf([60, 60, 62, 62, 64, 64], 100));
  assert.strictEqual(notes.length, 3);
  deepEqual(
    notes.map((n) => [n.note, n.startMs, n.durationMs]),
    [
      [60, 0, 200],
      [62, 200, 200],
      [64, 400, 200],
    ]
  );
  // No gaps and no overlaps: each note ends where the next starts.
  for (let i = 1; i < notes.length; i += 1) {
    assert.strictEqual(
      notes[i - 1].startMs + notes[i - 1].durationMs,
      notes[i].startMs,
      'a note change must not invent a gap or an overlap'
    );
  }
});

s.test('the min-duration floor is exact: 89ms is dropped, 90ms is kept', () => {
  const app = loadAppSandbox();
  const group = app.sandbox.groupContourToNotes;

  // One frame of 60, then a rest at t=89 -> a note exactly 89ms long.
  const short = group([{ n: 60, t: 0 }, { n: null, t: 89 }, { n: null, t: 200 }]);
  deepEqual(short, [], 'an 89ms note is tracker noise and must be dropped');

  const exact = group([{ n: 60, t: 0 }, { n: null, t: 90 }, { n: null, t: 200 }]);
  assert.strictEqual(exact.length, 1, 'a 90ms note is exactly at the floor and must be kept');
  assert.strictEqual(exact[0].durationMs, 90);

  // The floor is configurable, and 0 keeps everything that has any length.
  const kept = group([{ n: 60, t: 0 }, { n: null, t: 5 }, { n: null, t: 200 }], {
    minDurationMs: 0,
  });
  assert.strictEqual(kept.length, 1, 'minDurationMs: 0 must keep a 5ms note');
  assert.strictEqual(kept[0].durationMs, 5);

  // A blip between two long notes is dropped WITHOUT merging its neighbours:
  // they stay two separate notes, they just lose the blip between them.
  const withBlip = group([
    { n: 60, t: 0 },
    { n: 60, t: 100 },
    { n: 61, t: 200 }, // 50ms blip
    { n: 62, t: 250 },
    { n: 62, t: 350 },
    { n: null, t: 450 },
  ]);
  deepEqual(
    withBlip.map((n) => [n.note, n.durationMs]),
    [
      [60, 200],
      [62, 200],
    ],
    'the 50ms passing tone must vanish without disturbing its neighbours'
  );
});

s.test('the final note is closed one MEDIAN frame gap after the last frame', () => {
  const app = loadAppSandbox();
  const group = app.sandbox.groupContourToNotes;

  // Regular 50ms grid: median gap 50 -> the tail note runs 50ms past the last frame.
  const even = group(contourOf([64, 64, 64, 64], 50));
  assert.strictEqual(even[0].durationMs, 200, 'tail close should be 150 + median 50');

  // One abnormally long gap must NOT stretch the tail: the median ignores it.
  const skewed = group([
    { n: 64, t: 0 },
    { n: 64, t: 50 },
    { n: 64, t: 100 },
    { n: 64, t: 900 }, // a stalled poll
  ]);
  assert.strictEqual(
    skewed[0].durationMs,
    950,
    'the tail must extend by the MEDIAN gap (50), not the mean or the largest'
  );
});

s.test('empty, null and junk inputs produce no notes and never throw', () => {
  const app = loadAppSandbox();
  const group = app.sandbox.groupContourToNotes;
  for (const input of [[], null, undefined, 0, 'contour', {}, [null, undefined, 7, 'x']]) {
    let out;
    assert.doesNotThrow(() => {
      out = group(input);
    }, `groupContourToNotes(${JSON.stringify(input)}) threw`);
    deepEqual(out, [], `groupContourToNotes(${JSON.stringify(input)}) invented notes`);
  }
  // All-null frames are a real recording of silence — and silence is no notes.
  deepEqual(group(contourOf([null, null, null, null], 100)), []);
});

s.test('a single frame is below the floor by definition, and says so', () => {
  const app = loadAppSandbox();
  const group = app.sandbox.groupContourToNotes;

  // No second frame means no measurable frame rate: the fallback is one 2048
  // frame (~46ms), which is under the 90ms floor. One frame is not a note.
  deepEqual(group([{ n: 69, t: 0 }]), []);

  const kept = group([{ n: 69, t: 0 }], { minDurationMs: 0 });
  assert.strictEqual(kept.length, 1);
  assert.ok(
    Math.abs(kept[0].durationMs - FRAME_MS) < 1e-9,
    `a lone frame must last exactly one analysis frame, got ${kept[0].durationMs}`
  );
});

s.test('a note number MIDI cannot express is recorded as a rest, never rounded into range', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes([
    { n: 60, t: 0 },
    { n: 60, t: 100 },
    { n: 200, t: 200 }, // impossible: closes the note like a rest
    { n: 60, t: 300 },
    { n: 60, t: 400 },
    { n: null, t: 500 },
  ]);
  deepEqual(
    notes.map((n) => [n.note, n.startMs, n.durationMs]),
    [
      [60, 0, 200],
      [60, 300, 200],
    ],
    'an out-of-range frame must break the run, not be clamped to 127'
  );
  for (const n of notes) {
    assert.ok(n.note >= 0 && n.note <= 127, `grouped note ${n.note} is outside 0-127`);
  }
});

s.test('frames arriving out of order are sorted before grouping', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes([
    { n: 62, t: 300 },
    { n: 60, t: 0 },
    { n: 62, t: 400 },
    { n: 60, t: 100 },
    { n: 60, t: 200 },
  ]);
  deepEqual(
    notes.map((n) => [n.note, n.startMs, n.durationMs]),
    [
      [60, 0, 300],
      [62, 300, 200],
    ],
    'a shuffled contour must still group into ascending, non-overlapping notes'
  );
});

s.test('fractional MIDI numbers round to the nearest semitone before grouping', () => {
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes([
    { n: 68.6, t: 0 },
    { n: 69.4, t: 100 },
    { n: 69.0, t: 200 },
    { n: null, t: 300 },
  ]);
  assert.strictEqual(notes.length, 1, '68.6 / 69.4 / 69.0 all round to 69 — one note');
  assert.strictEqual(notes[0].note, 69);
  assert.strictEqual(notes[0].durationMs, 300);
});

/* -------------------------------------------------------------------------- */
/* encodeVlq — spec vectors                                                   */
/* -------------------------------------------------------------------------- */

s.test('encodeVlq matches the Standard MIDI File specification vectors exactly', () => {
  const app = loadAppSandbox();
  const encodeVlq = app.sandbox.encodeVlq;
  /* The table printed in the SMF 1.0 specification, verbatim. */
  const vectors = [
    [0x00000000, [0x00]],
    [0x00000040, [0x40]],
    [0x0000007f, [0x7f]],
    [0x00000080, [0x81, 0x00]],
    [0x00002000, [0xc0, 0x00]],
    [0x00003fff, [0xff, 0x7f]],
    [0x00004000, [0x81, 0x80, 0x00]],
    [0x00100000, [0xc0, 0x80, 0x00]],
    [0x001fffff, [0xff, 0xff, 0x7f]],
    [0x00200000, [0x81, 0x80, 0x80, 0x00]],
    [0x08000000, [0xc0, 0x80, 0x80, 0x00]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [value, expected] of vectors) {
    deepEqual(
      encodeVlq(value),
      expected,
      `encodeVlq(0x${value.toString(16)}) must be [${expected.map((b) => '0x' + b.toString(16))}]`
    );
  }
});

s.test('every encodeVlq output round-trips through the test parser', () => {
  const app = loadAppSandbox();
  const encodeVlq = app.sandbox.encodeVlq;
  const values = [0, 1, 63, 127, 128, 129, 255, 8192, 16383, 16384, 100000, 0x0fffffff];
  for (const value of values) {
    const bytes = encodeVlq(value);
    assert.ok(bytes.length >= 1 && bytes.length <= 4, `VLQ for ${value} is ${bytes.length} bytes`);
    for (let i = 0; i < bytes.length - 1; i += 1) {
      assert.ok((bytes[i] & 0x80) !== 0, `non-final VLQ byte ${i} of ${value} lacks 0x80`);
    }
    assert.strictEqual(bytes[bytes.length - 1] & 0x80, 0, `final VLQ byte of ${value} sets 0x80`);
    assert.strictEqual(decodeVlq(bytes), value, `VLQ round-trip failed for ${value}`);
  }
});

s.test('encodeVlq clamps the unencodable rather than emitting a corrupt stream', () => {
  const app = loadAppSandbox();
  const encodeVlq = app.sandbox.encodeVlq;
  deepEqual(encodeVlq(-1), [0x00], 'a negative delta clamps to 0');
  // A non-finite input carries NO information, and 0 is the neutral delta:
  // clamping it to the maximum instead would shove the event 0x0FFFFFFF ticks
  // into the future and quietly destroy the rest of the track.
  deepEqual(encodeVlq(NaN), [0x00]);
  deepEqual(encodeVlq(Infinity), [0x00]);
  deepEqual(encodeVlq(-Infinity), [0x00]);
  deepEqual(encodeVlq('nope'), [0x00]);
  deepEqual(encodeVlq(undefined), [0x00]);
  deepEqual(
    encodeVlq(0x10000000),
    [0xff, 0xff, 0xff, 0x7f],
    'past the 4-byte ceiling the value clamps to 0x0FFFFFFF'
  );
  deepEqual(encodeVlq(127.9), [0x7f], 'a fractional delta floors');
});

/* -------------------------------------------------------------------------- */
/* buildSmf0 — decoded structure, never byte snapshots                        */
/* -------------------------------------------------------------------------- */

s.test('the header is a format 0 file with one track and the requested division', () => {
  const app = loadAppSandbox();
  const file = app.sandbox.buildSmf0([{ note: 60, startMs: 0, durationMs: 500 }]);
  assert.ok(file instanceof Uint8Array, 'buildSmf0 must return a Uint8Array');
  const parsed = parseSmf(file);
  assert.strictEqual(parsed.format, 0, 'MECHANICS §1.1 requires SMF format 0');
  assert.strictEqual(parsed.ntrks, 1, 'format 0 holds exactly one track');
  assert.strictEqual(parsed.division, 480, 'default division is 480 ticks per quarter note');
  assert.strictEqual(parsed.ppq, 480, 'the division must be metrical, not SMPTE');
  assert.strictEqual(parsed.tracks.length, 1);

  const custom = parseSmf(app.sandbox.buildSmf0([], { ppq: 96 }));
  assert.strictEqual(custom.ppq, 96, 'a caller-supplied ppq must reach the header');
  const rejected = parseSmf(app.sandbox.buildSmf0([], { ppq: 0 }));
  assert.strictEqual(rejected.ppq, 480, 'an impossible ppq falls back to the default');
});

s.test('the tempo meta event carries the exact microseconds-per-quarter for 120 and 124 BPM', () => {
  const app = loadAppSandbox();
  for (const bpm of [120, 124, 90, 174]) {
    const parsed = parseSmf(app.sandbox.buildSmf0([], { bpm: bpm }));
    const tempo = parsed.tracks[0].events.find((e) => e.kind === 'meta' && e.metaType === 0x51);
    assert.ok(tempo, `no set-tempo meta event at ${bpm} BPM`);
    assert.strictEqual(tempo.tick, 0, 'the tempo event must sit at tick 0');
    assert.strictEqual(
      tempo.usPerQuarter,
      Math.round(60000000 / bpm),
      `set-tempo at ${bpm} BPM must be round(60000000/${bpm})`
    );
    assert.ok(
      Math.abs(tempo.bpm - bpm) < 0.01,
      `the tempo event decodes to ${tempo.bpm} BPM, expected ${bpm}`
    );
  }
  // 120 BPM is exactly 500000 us per quarter — the canonical MIDI default.
  const at120 = parseSmf(app.sandbox.buildSmf0([], { bpm: 120 }));
  assert.strictEqual(
    at120.tracks[0].events.find((e) => e.metaType === 0x51).usPerQuarter,
    500000
  );
});

s.test('the track name meta event names the track, and null omits it entirely', () => {
  const app = loadAppSandbox();
  const named = parseSmf(app.sandbox.buildSmf0([]));
  const nameEv = named.tracks[0].events.find((e) => e.kind === 'meta' && e.metaType === 0x03);
  assert.ok(nameEv, 'no track-name meta event');
  assert.strictEqual(nameEv.text, 'SunoPrompt hum');
  assert.strictEqual(nameEv.tick, 0);

  const anonymous = parseSmf(app.sandbox.buildSmf0([], { trackName: null }));
  assert.strictEqual(
    anonymous.tracks[0].events.filter((e) => e.metaType === 0x03).length,
    0,
    'trackName: null must write no name event at all'
  );

  // Non-ASCII is dropped, not mangled into wrong bytes.
  const unicode = parseSmf(app.sandbox.buildSmf0([], { trackName: 'hum é中 ok' }));
  const uniEv = unicode.tracks[0].events.find((e) => e.metaType === 0x03);
  assert.strictEqual(uniEv.text, 'hum  ok', 'non-ASCII characters must be dropped, not truncated');
  for (const byte of uniEv.data) {
    assert.ok(byte >= 0x20 && byte <= 0x7e, `meta text byte 0x${byte.toString(16)} is not ASCII`);
  }
});

s.test('every note_on is answered by a note_off at the correct tick — at 120 BPM', () => {
  const app = loadAppSandbox();
  const notes = [
    { note: 60, startMs: 0, durationMs: 500 },
    { note: 64, startMs: 500, durationMs: 250 },
    { note: 67, startMs: 750, durationMs: 1000 },
  ];
  const parsed = parseSmf(app.sandbox.buildSmf0(notes, { bpm: 120 }));
  const decoded = notesFromTrack(parsed.tracks[0]);
  assert.strictEqual(decoded.length, notes.length);
  for (let i = 0; i < notes.length; i += 1) {
    const want = notes[i];
    const got = decoded[i];
    assert.strictEqual(got.note, want.note, `note ${i} pitch`);
    assert.strictEqual(
      got.startTick,
      expectedTicks(want.startMs, 480, 120),
      `note ${i} start tick (ms -> ticks)`
    );
    assert.strictEqual(
      got.endTick,
      expectedTicks(want.startMs + want.durationMs, 480, 120),
      `note ${i} end tick (ms -> ticks)`
    );
    assert.strictEqual(got.velocity, 96, 'default note-on velocity');
    assert.strictEqual(got.channel, 0, 'default channel');
  }
  // 500ms at 120 BPM is exactly one quarter note = 480 ticks. Spot-check the
  // formula against arithmetic done by hand.
  assert.strictEqual(decoded[0].durationTicks, 480);
  assert.strictEqual(decoded[1].durationTicks, 240);
  assert.strictEqual(decoded[2].durationTicks, 960);
});

s.test('the tick formula holds at an asymmetric tempo (124 BPM) too', () => {
  const app = loadAppSandbox();
  const notes = [
    { note: 57, startMs: 0, durationMs: 371 },
    { note: 60, startMs: 371, durationMs: 197 },
    { note: 64, startMs: 568, durationMs: 913 },
  ];
  const parsed = parseSmf(app.sandbox.buildSmf0(notes, { bpm: 124 }));
  const decoded = notesFromTrack(parsed.tracks[0]);
  for (let i = 0; i < notes.length; i += 1) {
    assert.strictEqual(
      decoded[i].startTick,
      expectedTicks(notes[i].startMs, 480, 124),
      `124 BPM start tick for note ${i}`
    );
    assert.strictEqual(
      decoded[i].endTick,
      expectedTicks(notes[i].startMs + notes[i].durationMs, 480, 124),
      `124 BPM end tick for note ${i}`
    );
  }
  // Deltas in the byte stream are DIFFERENCES; every one must be non-negative,
  // which is what keeps a DAW from reading the melody backwards.
  for (const ev of parsed.tracks[0].events) {
    assert.ok(ev.delta >= 0, `negative delta ${ev.delta} in the event stream`);
  }
});

s.test('the MTrk length field equals the byte count the events actually consume', () => {
  const app = loadAppSandbox();
  for (const count of [0, 1, 3, 40]) {
    const notes = [];
    for (let i = 0; i < count; i += 1) {
      notes.push({ note: 60 + (i % 12), startMs: i * 250, durationMs: 240 });
    }
    const file = app.sandbox.buildSmf0(notes, { bpm: 124 });
    // parseSmf itself throws if the field and the stream disagree; assert the
    // numbers explicitly too so a failure names the discrepancy.
    const parsed = parseSmf(file);
    const track = parsed.tracks[0];
    assert.strictEqual(
      track.consumedBytes,
      track.declaredLength,
      `MTrk length mismatch with ${count} note(s)`
    );
    assert.strictEqual(
      file.length,
      14 + 8 + track.declaredLength,
      `file length must be MThd(14) + MTrk header(8) + ${track.declaredLength}`
    );
  }
});

s.test('end-of-track is present, empty, and the LAST event in the track', () => {
  const app = loadAppSandbox();
  const parsed = parseSmf(
    app.sandbox.buildSmf0([
      { note: 60, startMs: 0, durationMs: 500 },
      { note: 62, startMs: 500, durationMs: 500 },
    ])
  );
  const events = parsed.tracks[0].events;
  const last = events[events.length - 1];
  assert.strictEqual(last.kind, 'meta');
  assert.strictEqual(last.metaType, 0x2f, 'the final event must be end-of-track (FF 2F 00)');
  assert.strictEqual(last.data.length, 0, 'end-of-track carries no payload');
  const eots = events.filter((e) => e.metaType === 0x2f);
  assert.strictEqual(eots.length, 1, 'exactly one end-of-track event');
});

s.test('a 3-note contour round-trips: frames -> notes -> file -> parser -> the same notes', () => {
  const app = loadAppSandbox();
  const bpm = 124;
  const ppq = 480;

  // A -> C -> E on a 100ms grid, each note four frames long, with a rest
  // between the second and third.
  const frames = [
    { n: 69, t: 0 },
    { n: 69, t: 100 },
    { n: 69, t: 200 },
    { n: 69, t: 300 },
    { n: 72, t: 400 },
    { n: 72, t: 500 },
    { n: 72, t: 600 },
    { n: null, t: 700 },
    { n: 76, t: 800 },
    { n: 76, t: 900 },
    { n: 76, t: 1000 },
    { n: null, t: 1100 },
  ];
  const grouped = app.sandbox.groupContourToNotes(frames);
  deepEqual(
    grouped.map((n) => [n.note, n.startMs, n.durationMs]),
    [
      [69, 0, 400],
      [72, 400, 300],
      [76, 800, 300],
    ],
    'grouping must produce exactly the three sung notes'
  );

  const parsed = parseSmf(app.sandbox.buildSmf0(grouped, { bpm: bpm, ppq: ppq }));
  const decoded = notesFromTrack(parsed.tracks[0]);
  assert.strictEqual(decoded.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.strictEqual(decoded[i].note, grouped[i].note, `round-trip pitch ${i}`);
    const wantStart = expectedTicks(grouped[i].startMs, ppq, bpm);
    const wantDur =
      expectedTicks(grouped[i].startMs + grouped[i].durationMs, ppq, bpm) - wantStart;
    assert.ok(
      Math.abs(decoded[i].startTick - wantStart) <= 1,
      `round-trip start ${decoded[i].startTick} != ${wantStart} (+/-1 tick)`
    );
    assert.ok(
      Math.abs(decoded[i].durationTicks - wantDur) <= 1,
      `round-trip duration ${decoded[i].durationTicks} != ${wantDur} (+/-1 tick)`
    );
  }
  // Nothing overlaps: each note is released before the next sounds.
  for (let i = 1; i < decoded.length; i += 1) {
    assert.ok(
      decoded[i].startTick >= decoded[i - 1].endTick,
      'grouped notes must never overlap in the written file'
    );
  }
});

s.test('notes outside 0-127 are REJECTED, never clamped into a pitch nobody hummed', () => {
  const app = loadAppSandbox();
  const parsed = parseSmf(
    app.sandbox.buildSmf0([
      { note: -1, startMs: 0, durationMs: 500 },
      { note: 60, startMs: 500, durationMs: 500 },
      { note: 128, startMs: 1000, durationMs: 500 },
      { note: 200, startMs: 1500, durationMs: 500 },
      { note: 127, startMs: 2000, durationMs: 500 },
      { note: 0, startMs: 2500, durationMs: 500 },
    ])
  );
  const decoded = notesFromTrack(parsed.tracks[0]);
  deepEqual(
    decoded.map((n) => n.note),
    [60, 127, 0],
    'only the three representable notes may survive; -1, 128 and 200 are dropped, ' +
      'not clamped to 0 or 127 (that would write a pitch the user never hummed)'
  );
});

s.test('malformed note entries are skipped and a valid file is still produced', () => {
  const app = loadAppSandbox();
  const file = app.sandbox.buildSmf0([
    null,
    'note',
    { note: 60 },
    { note: 60, startMs: 0 },
    { note: 60, startMs: 0, durationMs: 0 },
    { note: 60, startMs: -5, durationMs: 100 },
    { note: NaN, startMs: 0, durationMs: 100 },
    { note: 62, startMs: 0, durationMs: 500 },
  ]);
  const decoded = notesFromTrack(parseSmf(file).tracks[0]);
  deepEqual(decoded.map((n) => n.note), [62]);

  // Nothing at all is still a legal file: header, tempo, name, end-of-track.
  for (const input of [null, undefined, [], 'notes', 42]) {
    const empty = parseSmf(app.sandbox.buildSmf0(input));
    assert.strictEqual(notesFromTrack(empty.tracks[0]).length, 0);
    assert.strictEqual(empty.tracks[0].events[empty.tracks[0].events.length - 1].metaType, 0x2f);
  }
});

s.test('channel and velocity options reach every event, and impossible ones fall back', () => {
  const app = loadAppSandbox();
  const notes = [
    { note: 60, startMs: 0, durationMs: 400 },
    { note: 64, startMs: 400, durationMs: 400 },
  ];
  const parsed = parseSmf(app.sandbox.buildSmf0(notes, { channel: 9, velocity: 40 }));
  for (const ev of parsed.tracks[0].events) {
    if (ev.kind === 'note_on' || ev.kind === 'note_off') {
      assert.strictEqual(ev.channel, 9, 'channel option must reach every channel message');
    }
  }
  const decoded = notesFromTrack(parsed.tracks[0]);
  for (const n of decoded) assert.strictEqual(n.velocity, 40);

  const fallback = parseSmf(
    app.sandbox.buildSmf0(notes, { channel: 99, velocity: 0, bpm: -5 })
  );
  const back = notesFromTrack(fallback.tracks[0]);
  for (const n of back) {
    assert.strictEqual(n.channel, 0, 'an impossible channel falls back to 0');
    assert.strictEqual(n.velocity, 96, 'velocity 0 would BE a note-off; it falls back to 96');
  }
  assert.strictEqual(
    fallback.tracks[0].events.find((e) => e.metaType === 0x51).usPerQuarter,
    500000,
    'a non-positive bpm falls back to 120'
  );
});

s.test('a hand-built OVERLAPPING note list is still written as a parseable file', () => {
  const app = loadAppSandbox();
  // groupContourToNotes cannot produce this, but buildSmf0 must not corrupt the
  // stream if a future caller hands it one: note_off sorts before note_on at an
  // equal tick, and no delta may go negative.
  const parsed = parseSmf(
    app.sandbox.buildSmf0([
      { note: 60, startMs: 1000, durationMs: 1000 },
      { note: 64, startMs: 0, durationMs: 1500 },
    ])
  );
  const decoded = notesFromTrack(parsed.tracks[0]);
  assert.strictEqual(decoded.length, 2, 'both notes must survive');
  deepEqual(decoded.map((n) => n.note), [64, 60], 'events must be sorted by start');
  for (const ev of parsed.tracks[0].events) {
    assert.ok(ev.delta >= 0, `negative delta ${ev.delta} from overlapping input`);
  }
});

s.test('a zero-length note is written as one tick, never as a stuck note', () => {
  const app = loadAppSandbox();
  // 1ms at 120 BPM rounds to 1 tick... but 0.1ms rounds to 0, which would make
  // note_on and note_off share a tick. The floor keeps them one tick apart.
  const parsed = parseSmf(app.sandbox.buildSmf0([{ note: 60, startMs: 0, durationMs: 0.1 }]));
  const decoded = notesFromTrack(parsed.tracks[0]);
  assert.strictEqual(decoded.length, 1);
  assert.strictEqual(decoded[0].durationTicks, 1, 'a sub-tick note lasts exactly one tick');
});

/* -------------------------------------------------------------------------- */
/* bytesToBase64 — byte-identical to Node's own encoder                       */
/* -------------------------------------------------------------------------- */

s.test('bytesToBase64 matches Buffer for empty input and every remainder length', () => {
  const app = loadAppSandbox();
  const encode = app.sandbox.bytesToBase64;
  const cases = [
    [],
    [0x00],
    [0xff],
    [0x4d, 0x54],
    [0x4d, 0x54, 0x68],
    [0x4d, 0x54, 0x68, 0x64],
    [0x00, 0x00, 0x00, 0x00, 0x00],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    [0xfb, 0xff, 0xbf], // exercises the '+' and '/' symbols
  ];
  for (const bytes of cases) {
    const expected = Buffer.from(bytes).toString('base64');
    assert.strictEqual(
      encode(new Uint8Array(bytes)),
      expected,
      `base64 of [${bytes}] must be "${expected}"`
    );
    // A plain array must encode identically to a typed array.
    assert.strictEqual(encode(bytes), expected, `plain-array base64 of [${bytes}] drifted`);
  }
  assert.strictEqual(encode([]), '', 'empty input encodes to the empty string');
  assert.strictEqual(encode(null), '', 'junk input encodes to the empty string, not a throw');
  assert.strictEqual(encode(undefined), '');
});

s.test('bytesToBase64 matches Buffer over 1KB of seeded pseudo-random bytes', () => {
  const app = loadAppSandbox();
  const next = lcg(0x5eed1234);
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(next() * 256) & 0xff;

  const expected = Buffer.from(bytes).toString('base64');
  const actual = app.sandbox.bytesToBase64(bytes);
  assert.strictEqual(actual.length, expected.length, 'encoded length drifted');
  assert.strictEqual(actual, expected, 'a 1KB buffer did not encode identically to Buffer');

  // And every truncation of it, so no length class is left untested.
  for (let len = 0; len <= 64; len += 1) {
    const slice = bytes.subarray(0, len);
    assert.strictEqual(
      app.sandbox.bytesToBase64(slice),
      Buffer.from(slice).toString('base64'),
      `base64 drifted at length ${len}`
    );
  }
});

s.test('a built file survives the full base64 -> decode -> parse trip', () => {
  const app = loadAppSandbox();
  const file = app.sandbox.buildSmf0(
    [
      { note: 69, startMs: 0, durationMs: 400 },
      { note: 72, startMs: 400, durationMs: 300 },
    ],
    { bpm: 124 }
  );
  const encoded = app.sandbox.bytesToBase64(file);
  const url = 'data:audio/midi;base64,' + encoded;
  assert.ok(/^data:audio\/midi;base64,[A-Za-z0-9+/]+={0,2}$/.test(url), 'malformed data URL');

  const decodedBytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  assert.strictEqual(decodedBytes.length, file.length, 'base64 round-trip changed the length');
  for (let i = 0; i < file.length; i += 1) {
    assert.strictEqual(decodedBytes[i], file[i], `byte ${i} changed across the base64 round-trip`);
  }
  const notes = notesFromTrack(parseSmf(decodedBytes).tracks[0]);
  deepEqual(notes.map((n) => n.note), [69, 72]);
});

/* -------------------------------------------------------------------------- */
/* midiFilename — FDD #78, DAW-ready naming                                   */
/* -------------------------------------------------------------------------- */

s.test('the filename carries only what was actually measured', () => {
  const app = loadAppSandbox();
  const midiFilename = app.sandbox.midiFilename;

  assert.strictEqual(
    midiFilename({ bpm: 124, key: { rootName: 'A', mode: 'minor' } }),
    'sunoprompt-hum-124bpm-Amin.mid',
    'tempo and key both measured'
  );
  assert.strictEqual(
    midiFilename({ bpm: 124, key: null }),
    'sunoprompt-hum-124bpm.mid',
    'tempo only'
  );
  assert.strictEqual(
    midiFilename({ bpm: null, key: { rootName: 'F', mode: 'major' } }),
    'sunoprompt-hum-Fmaj.mid',
    'key only'
  );
  assert.strictEqual(midiFilename({}), 'sunoprompt-hum.mid', 'nothing measured');
  assert.strictEqual(midiFilename(), 'sunoprompt-hum.mid', 'no options at all');
  assert.strictEqual(midiFilename(null), 'sunoprompt-hum.mid');
});

s.test('the filename never invents a key, a tempo or an unsafe character', () => {
  const app = loadAppSandbox();
  const midiFilename = app.sandbox.midiFilename;

  // A root with no third is not a key: FEATURE-MECHANICS' classifier reports
  // mode: null for it, and half a key must not appear in a filename.
  assert.strictEqual(
    midiFilename({ bpm: 100, key: { rootName: 'D', mode: null } }),
    'sunoprompt-hum-100bpm.mid'
  );
  assert.strictEqual(midiFilename({ bpm: 0 }), 'sunoprompt-hum.mid', '0 BPM is not a tempo');
  assert.strictEqual(midiFilename({ bpm: NaN }), 'sunoprompt-hum.mid');
  assert.strictEqual(midiFilename({ bpm: Infinity }), 'sunoprompt-hum.mid');
  assert.strictEqual(midiFilename({ bpm: 1000 }), 'sunoprompt-hum.mid', '1000 BPM is out of band');
  assert.strictEqual(
    midiFilename({ bpm: 123.6 }),
    'sunoprompt-hum-124bpm.mid',
    'a fractional tempo rounds'
  );
  assert.strictEqual(
    midiFilename({ key: { rootName: 'H', mode: 'minor' } }),
    'sunoprompt-hum.mid',
    '"H" is not a pitch class this app names'
  );
  assert.strictEqual(
    midiFilename({ key: { rootName: 'C#', mode: 'minor' } }),
    'sunoprompt-hum-Csmin.mid',
    'a sharp becomes "s" — "#" opens a URL fragment'
  );

  for (const name of [
    midiFilename({ bpm: 124, key: { rootName: 'F#', mode: 'major' } }),
    midiFilename({}),
  ]) {
    assert.ok(/^[A-Za-z0-9._-]+\.mid$/.test(name), `unsafe filename characters in "${name}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* Worker: createContourRecorder + the 'contour' message                      */
/* -------------------------------------------------------------------------- */

s.test('createContourRecorder is a top-level factory with the documented API', () => {
  const w = loadWorkerSandbox(INDEX);
  assert.strictEqual(
    typeof w.sandbox.createContourRecorder,
    'function',
    'createContourRecorder must be a top-level `function` declaration'
  );
  const r = w.sandbox.createContourRecorder();
  for (const method of ['push', 'frames', 'count', 'dropped', 'nowMs', 'reset']) {
    assert.strictEqual(typeof r[method], 'function', `recorder is missing ${method}()`);
  }
  assert.strictEqual(r.limit, 13000, 'the default cap is ~10 minutes of frames');
  deepEqual(r.frames(), [], 'a fresh recorder has recorded nothing');
  assert.strictEqual(r.dropped(), 0);
  assert.strictEqual(r.nowMs(), 0);

  // Two recorders share no state, or one session would poison the next.
  const a = w.sandbox.createContourRecorder();
  const b = w.sandbox.createContourRecorder();
  a.push(60, 100);
  assert.strictEqual(b.count(), 0, 'a second recorder saw the first recorder\'s frames');
});

s.test('frames accumulate on the capture clock, each stamped with its own start', () => {
  const w = loadWorkerSandbox(INDEX);
  const r = w.sandbox.createContourRecorder();
  r.push(60, 100);
  r.push(60, 100);
  r.push(62, 50);
  deepEqual(r.frames(), [
    { n: 60, t: 0 },
    { n: 60, t: 100 },
    { n: 62, t: 200 },
  ]);
  assert.strictEqual(r.nowMs(), 250, 'the clock advances by each frame\'s own duration');
  assert.strictEqual(r.count(), 3);

  // frames() hands back a copy: editing it must not reach the recorder.
  const copy = r.frames();
  copy[0].n = 99;
  copy.push({ n: 1, t: 1 });
  assert.strictEqual(r.frames()[0].n, 60, 'frames() leaked its internal array');
  assert.strictEqual(r.count(), 3);

  r.reset();
  deepEqual(r.frames(), []);
  assert.strictEqual(r.nowMs(), 0);
  assert.strictEqual(r.dropped(), 0);
});

s.test('a frame with no pitch is recorded AS a rest, never skipped', () => {
  const w = loadWorkerSandbox(INDEX);
  const r = w.sandbox.createContourRecorder();
  r.push(60, 100);
  r.push(null, 100); // gated
  r.push(undefined, 100); // unvoiced
  r.push(NaN, 100);
  r.push(200, 100); // outside the MIDI range
  r.push(-3, 100);
  r.push(60, 100);
  deepEqual(
    r.frames().map((f) => f.n),
    [60, null, null, null, null, null, 60],
    'every unusable pitch must be recorded as null — skipping would glue two notes into one'
  );
  // And the rests keep the two 60s apart when grouped.
  const app = loadAppSandbox();
  const notes = app.sandbox.groupContourToNotes(r.frames(), { minDurationMs: 0 });
  assert.strictEqual(notes.length, 2, 'the recorded rest must separate the two notes');
});

s.test('the recorder caps at its limit, drops the OLDEST frame and counts every drop', () => {
  const w = loadWorkerSandbox(INDEX);
  const r = w.sandbox.createContourRecorder({ limit: 10 });
  assert.strictEqual(r.limit, 10);
  for (let i = 0; i < 25; i += 1) r.push(60 + (i % 12), 10);

  assert.strictEqual(r.count(), 10, 'the recorder must retain exactly its limit');
  assert.strictEqual(r.dropped(), 15, 'every dropped frame must be counted');
  const frames = r.frames();
  assert.strictEqual(frames.length, 10);
  // The survivors are the NEWEST ten: frames 15..24, stamped 150..240.
  assert.strictEqual(frames[0].t, 150, 'the oldest retained frame must be #15');
  assert.strictEqual(frames[9].t, 240, 'the newest retained frame must be #24');
  assert.strictEqual(frames[0].n, 60 + (15 % 12));
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(frames[i].t > frames[i - 1].t, 'retained frames must stay in capture order');
  }
  assert.strictEqual(r.nowMs(), 250, 'dropping frames must not rewind the clock');

  r.reset();
  assert.strictEqual(r.dropped(), 0, 'reset clears the drop count with everything else');
});

s.test('the default cap really is about ten minutes, and holds past a full window', () => {
  const w = loadWorkerSandbox(INDEX);
  const r = w.sandbox.createContourRecorder();
  const total = 13000 + 2500; // past the cap AND past one compaction cycle
  for (let i = 0; i < total; i += 1) r.push(i % 2 === 0 ? 60 : null, FRAME_MS);
  assert.strictEqual(r.count(), 13000);
  assert.strictEqual(r.dropped(), total - 13000);
  const frames = r.frames();
  assert.strictEqual(frames.length, 13000);
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(
      frames[i].t > frames[i - 1].t,
      `compaction broke capture order at index ${i} (${frames[i - 1].t} -> ${frames[i].t})`
    );
  }
  const minutes = (13000 * FRAME_MS) / 60000;
  assert.ok(minutes > 9.5 && minutes < 10.5, `the cap is ${minutes.toFixed(2)} minutes, expected ~10`);
});

s.test("the 'contour' reply has the documented shape and echoes an explicit seq", () => {
  const w = loadWorkerSandbox(INDEX);
  // Drive it through the REAL protocol: analyse frames first, then ask.
  w.send({ type: 'analyze', seq: 0, sampleRate: SR, samples: sine(440) });
  w.send({ type: 'analyze', seq: 1, sampleRate: SR, samples: sine(440) });
  w.send({ type: 'analyze', seq: 2, sampleRate: SR, samples: silence() });

  const reply = w.send({ type: 'contour' });
  assert.strictEqual(reply.type, 'contour');
  assert.ok(Array.isArray(reply.frames), 'contour.frames must be an array');
  assert.strictEqual(reply.frames.length, 3, 'one entry per analysed frame');
  assert.strictEqual(reply.dropped, 0);
  assert.strictEqual(reply.seq, undefined, 'no seq was asked for, so none is echoed');
  for (const f of reply.frames) {
    assert.ok(
      typeof f.t === 'number' && isFinite(f.t),
      `contour frame timestamp must be a finite number, got ${f.t}`
    );
    assert.ok(f.n === null || (typeof f.n === 'number' && f.n >= 0 && f.n <= 127), `bad note ${f.n}`);
  }
  assert.strictEqual(reply.frames[0].n, 69, '440 Hz is MIDI 69');
  assert.strictEqual(reply.frames[1].n, 69);
  assert.strictEqual(reply.frames[2].n, null, 'a gated frame must be recorded as a rest');
  assert.ok(
    Math.abs(reply.frames[1].t - FRAME_MS) < 1e-6,
    `the second frame should start one frame in (${FRAME_MS}ms), got ${reply.frames[1].t}`
  );

  const echoed = w.send({ type: 'contour', seq: 42 });
  assert.strictEqual(echoed.seq, 42, 'an explicit seq must be echoed back');
  assert.strictEqual(echoed.frames.length, 3, 'asking twice must not consume the contour');
});

s.test("a 'contour' request before any analysis answers empty, not with an error", () => {
  const w = loadWorkerSandbox(INDEX);
  const reply = w.send({ type: 'contour' });
  deepEqual(
    reply,
    { type: 'contour', frames: [], dropped: 0 },
    'nothing recorded is an empty contour, not a failure'
  );
  // Same when handleMessage is called with no recorder at all.
  const direct = w.sandbox.handleMessage({ type: 'contour' });
  deepEqual(direct, { type: 'contour', frames: [], dropped: 0 });
});

s.test('seq 0 starts a new session: the previous melody does not leak into it', () => {
  const w = loadWorkerSandbox(INDEX);
  for (let i = 0; i < 4; i += 1) {
    w.send({ type: 'analyze', seq: i, sampleRate: SR, samples: sine(440) });
  }
  assert.strictEqual(w.send({ type: 'contour' }).frames.length, 4);

  // A new capture session restarts seq at 0 (see #app-main).
  w.send({ type: 'analyze', seq: 0, sampleRate: SR, samples: sine(523.2511) });
  const after = w.send({ type: 'contour' });
  assert.strictEqual(after.frames.length, 1, 'seq 0 must reset the contour');
  assert.strictEqual(after.frames[0].t, 0, 'the capture clock must restart at 0');
  assert.strictEqual(after.frames[0].n, 72, 'C5 is MIDI 72');

  // A sample-rate change rebuilds the recorder for the same reason.
  w.send({ type: 'analyze', seq: 7, sampleRate: 48000, samples: sine(440) });
  const rebuilt = w.send({ type: 'contour' });
  assert.strictEqual(rebuilt.frames.length, 1, 'a sample-rate change must rebuild the recorder');
  assert.strictEqual(rebuilt.frames[0].t, 0);
});

s.test("malformed 'contour' requests are refused, and never answered with a fake contour", () => {
  const w = loadWorkerSandbox(INDEX);
  w.send({ type: 'analyze', seq: 0, sampleRate: SR, samples: sine(440) });

  const bad = [
    { type: 'contour', seq: 'one' },
    { type: 'contour', seq: NaN },
    { type: 'contour', seq: Infinity },
    { type: 'contour', seq: null },
    { type: 'contour', seq: {} },
  ];
  for (const msg of bad) {
    const reply = w.send(msg);
    assert.strictEqual(
      reply.type,
      'error',
      `${JSON.stringify(msg)} should be refused, got ${JSON.stringify(reply)}`
    );
    assert.ok(/contour/.test(reply.error), `error must name the message type: "${reply.error}"`);
    assert.strictEqual(reply.frames, undefined, 'an error reply must carry no frames');
  }

  // Wrong-cased and near-miss types fall through to the unknown-type branch.
  for (const msg of [{ type: 'Contour' }, { type: 'contours' }, { type: 'contour ' }]) {
    const reply = w.send(msg);
    assert.strictEqual(reply.type, 'error');
    assert.ok(/unknown message type/.test(reply.error), `got "${reply.error}"`);
  }
  for (const msg of [null, undefined, {}, 'contour', 42]) {
    const reply = w.send(msg);
    assert.strictEqual(reply.type, 'error', `${JSON.stringify(msg)} should be refused`);
  }

  // The real contour is untouched by every refusal above.
  assert.strictEqual(w.send({ type: 'contour' }).frames.length, 1);
});

s.test('the existing protocol is untouched by the contour addition', () => {
  const w = loadWorkerSandbox(INDEX);
  const pong = w.send({ type: 'ping' });
  deepEqual(pong, { type: 'pong', engine: 'dsp', version: '0.5.0' });

  const ack = w.send({ type: 'audio-chunk', seq: 3, sampleRate: SR, samples: sine(440) });
  deepEqual(ack, { type: 'chunk-ack', seq: 3, samples: FRAME });

  const analysis = w.send({ type: 'analyze', seq: 0, sampleRate: SR, samples: sine(440) });
  assert.strictEqual(analysis.type, 'analysis');
  assert.strictEqual(analysis.midiNote, 69);
  assert.strictEqual(analysis.gated, false);

  // 'audio-chunk' is transport only — it must NOT feed the contour.
  w.send({ type: 'audio-chunk', seq: 4, sampleRate: SR, samples: sine(440) });
  assert.strictEqual(
    w.send({ type: 'contour' }).frames.length,
    1,
    "'audio-chunk' must not record a contour frame; only 'analyze' analyses"
  );
});

/* -------------------------------------------------------------------------- */
/* End to end: real audio -> worker contour -> grouped notes -> parsed file    */
/* -------------------------------------------------------------------------- */

s.test('a hummed A4 -> rest -> C5 becomes a two-note MIDI file a parser can read', () => {
  const w = loadWorkerSandbox(INDEX);
  const app = loadAppSandbox();

  let seq = 0;
  function feed(buffer, count) {
    for (let i = 0; i < count; i += 1) {
      w.send({ type: 'analyze', seq: seq, sampleRate: SR, samples: buffer });
      seq += 1;
    }
  }
  feed(sine(440), 8); // A4, ~371ms
  feed(silence(), 4); // a real rest
  feed(sine(523.2511), 8); // C5, ~371ms

  const contour = w.send({ type: 'contour' });
  assert.strictEqual(contour.frames.length, 20, 'one contour frame per analysed frame');
  assert.strictEqual(contour.dropped, 0);

  const notes = app.sandbox.groupContourToNotes(contour.frames);
  assert.strictEqual(notes.length, 2, `expected two notes, got ${JSON.stringify(notes)}`);
  assert.strictEqual(notes[0].note, 69, 'the 440 Hz run must be A4 (MIDI 69)');
  assert.strictEqual(notes[1].note, 72, 'the 523.25 Hz run must be C5 (MIDI 72)');
  assert.strictEqual(notes[0].startMs, 0);
  assert.ok(
    Math.abs(notes[0].durationMs - 8 * FRAME_MS) < 1e-6,
    `the first note should last eight frames, got ${notes[0].durationMs}ms`
  );
  assert.ok(
    Math.abs(notes[1].startMs - 12 * FRAME_MS) < 1e-6,
    'the second note must start after the rest, not during it'
  );

  const bpm = 124;
  const file = app.sandbox.buildSmf0(notes, { bpm: bpm });
  const parsed = parseSmf(file);
  assert.strictEqual(parsed.format, 0);
  const decoded = notesFromTrack(parsed.tracks[0]);
  deepEqual(decoded.map((n) => n.note), [69, 72]);
  for (let i = 0; i < 2; i += 1) {
    assert.strictEqual(decoded[i].startTick, expectedTicks(notes[i].startMs, 480, bpm));
    assert.strictEqual(
      decoded[i].endTick,
      expectedTicks(notes[i].startMs + notes[i].durationMs, 480, bpm)
    );
  }
  // There is a real gap between them — the rest survived into the file.
  assert.ok(
    decoded[1].startTick > decoded[0].endTick,
    'the rest between the two notes must survive into the MIDI file'
  );

  // And the whole thing survives the transport it is actually delivered over.
  const encoded = app.sandbox.bytesToBase64(file);
  const round = notesFromTrack(
    parseSmf(new Uint8Array(Buffer.from(encoded, 'base64'))).tracks[0]
  );
  deepEqual(round.map((n) => n.note), [69, 72]);
});

/* -------------------------------------------------------------------------- */
/* Static wiring contracts                                                    */
/* -------------------------------------------------------------------------- */

s.test('index.html ships the export control, disabled, with an accessible name', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  for (const id of ['btn-midi', 'btn-midi-label', 'midi-readout']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `index.html is missing id="${id}"`);
  }
  const button = /<button[^>]*id="btn-midi"[\s\S]{0,300}?<\/button>/.exec(html);
  assert.ok(button, '#btn-midi is not a <button>');
  assert.ok(/\bdisabled\b/.test(button[0]), '#btn-midi must start disabled — nothing is captured yet');
  assert.ok(/aria-label="[^"]+"/.test(button[0]), '#btn-midi has no aria-label');
  assert.ok(/type="button"/.test(button[0]), '#btn-midi must be type="button", not a submit');

  const readout = /<span[^>]*id="midi-readout"[\s\S]{0,240}?<\/span>/.exec(html);
  assert.ok(readout, '#midi-readout is missing');
  assert.ok(
    /class="[^"]*capture-readout/.test(readout[0]),
    'the export readout must use the existing capture readout style'
  );
  assert.ok(
    /no melody captured yet/.test(readout[0]),
    'the initial readout must say honestly that nothing is captured'
  );
  assert.ok(
    /role="status"/.test(readout[0]) && /aria-live="polite"/.test(readout[0]),
    'the export readout must announce itself politely'
  );
  // The control lives in the capture panel, next to Record.
  const panel = html.indexOf('id="capture-heading"');
  const helpPanel = html.indexOf('id="mic-help"');
  const button_at = html.indexOf('id="btn-midi"');
  assert.ok(
    panel !== -1 && button_at > panel && button_at < helpPanel,
    'the export control belongs in the capture panel, after the record controls'
  );
});

s.test('the export button styling is token-driven and never fades a disabled control', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rule = /\.btn-record\[disabled\]\s*\{([^}]*)\}/.exec(style);
  assert.ok(rule, 'no .btn-record[disabled] rule — a disabled export would look enabled');
  assert.ok(
    !/opacity\s*:/.test(rule[1]),
    'a disabled control must not be faded: Code Mode exists for legibility'
  );
  assert.ok(/var\(--text-dim\)/.test(rule[1]), 'the disabled colour must come from a token');
  assert.ok(/cursor:\s*not-allowed/.test(rule[1]), 'a disabled control should say so on hover');
  assert.ok(/\.btn-midi\s+\.midi-glyph/.test(style), 'the export glyph has no themed rule');
  // Every colour in the new rules is a token, so both themes and Code Mode reach it.
  const midiRules = style.match(/\.(btn-midi|midi-row)[^{]*\{[^}]*\}/g) || [];
  for (const block of midiRules) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}|\brgba?\(/.test(block),
      `a raw colour literal in a MIDI rule cannot be re-themed:\n${block}`
    );
  }
});

s.test('the boot code asks the worker for the contour when a session STOPS', () => {
  const app = loadAppSandbox();
  const src = app.source;
  assert.ok(
    /postMessage\(\{\s*type:\s*'contour'\s*\}\)/.test(src),
    "the app must request the contour with { type: 'contour' }"
  );
  const stopBlock = /state === 'stopped' && dspWorker[\s\S]{0,900}?\n          \}/.exec(src);
  assert.ok(stopBlock, "no `state === 'stopped'` branch requesting the contour");
  assert.ok(
    /postMessage\(\{ type: 'contour' \}\)/.test(stopBlock[0]),
    'the contour request must live in the stopped branch'
  );
  assert.ok(
    /data\.type === 'contour'/.test(src),
    "the app must handle the worker's 'contour' reply"
  );
  assert.ok(
    /groupContourToNotes\(data\.frames\)/.test(src),
    'the contour reply must be grouped into notes before anything is enabled'
  );
  // A new session must clear the previous export.
  assert.ok(
    /state === 'requesting'[\s\S]{0,700}resetMidi\(\)/.test(src),
    'a new capture session must reset the MIDI export state'
  );
});

s.test('the download path is the documented data: URL on a throwaway anchor', () => {
  const app = loadAppSandbox();
  const src = app.source;
  const start = src.indexOf("midiBtn.addEventListener");
  assert.ok(start !== -1, 'no click handler is wired to #btn-midi');
  const handler = src.slice(start, start + 1400);

  assert.ok(
    /'data:audio\/midi;base64,' \+ bytesToBase64\(/.test(handler),
    "MECHANICS §1.1 step 3: the file must be delivered as 'data:audio/midi;base64,...'"
  );
  assert.ok(/buildSmf0\(midiNotes/.test(handler), 'the click must build the file from the notes');
  assert.ok(/createElement\('a'\)/.test(handler), 'the download needs an anchor');
  assert.ok(/\.download = midiFilename\(/.test(handler), 'the anchor must carry the export filename');
  assert.ok(/appendChild\(anchor\)/.test(handler), 'the anchor must be in the document to click');
  assert.ok(/anchor\.click\(\)/.test(handler), 'the anchor must be clicked');
  assert.ok(/anchor\.remove\(\)/.test(handler), 'the anchor must be removed again');
  assert.ok(
    /if \(midiNotes\.length === 0\) return;/.test(handler),
    'an empty contour must export nothing at all'
  );
  // No library, no blob, no network anywhere in the export path.
  assert.ok(!/createObjectURL/.test(handler), 'the export must not need a blob URL');
  assert.ok(!/\bfetch\(|XMLHttpRequest/.test(handler), 'the export must not touch the network');
  assert.ok(!/\bbtoa\(/.test(src), 'base64 is encoded in-file, never via btoa (MECHANICS §1.1)');
});

s.test('the readout reports the note count and NAMES the fallback tempo', () => {
  const app = loadAppSandbox();
  const src = app.source;
  const start = src.indexOf('function renderMidi()');
  assert.ok(start !== -1, 'renderMidi() is missing from the boot code');
  const fn = src.slice(start, start + 1200);
  assert.ok(/no melody captured yet/.test(fn), 'the empty state must be stated honestly');
  assert.ok(/midiBtn\.disabled = true/.test(fn), 'an empty contour must leave the button disabled');
  assert.ok(/midiBtn\.disabled = false/.test(fn), 'a real contour must enable the button');
  assert.ok(
    /count === 1 \? ' note' : ' notes'/.test(fn),
    'the readout should say "1 note", not "1 notes"'
  );
  assert.ok(
    /no tempo measured/.test(fn) && /MIDI_DEFAULT_BPM/.test(fn),
    'when no tempo was measured the readout must say so and name the fallback'
  );
  assert.ok(/frames dropped/.test(fn), 'a truncated contour must be reported, not hidden');
});

s.test('the worker declares the contour message in its own protocol documentation', () => {
  const workerSrc = extractScriptById(INDEX, 'dsp-worker-src');
  assert.ok(/case 'contour':/.test(workerSrc), "the worker has no 'contour' case");
  assert.ok(
    /\{ type: 'contour', frames: \[\{n, t\}\], dropped, seq\? \}/.test(workerSrc),
    'the worker protocol comment must document the contour reply shape'
  );
  assert.ok(
    /createContourRecorder\(\)/.test(workerSrc),
    'the onmessage closure must own a contour recorder'
  );
  assert.ok(
    /sessionContour\.reset\(\)/.test(workerSrc),
    'the recorder must be reset when a new session starts at seq 0'
  );
});

module.exports = { parseSmf, notesFromTrack, loadAppSandbox, lcg };

if (require.main === module) {
  s.finish().then((r) => {
    if (!r.ok) process.exitCode = 1;
  });
}
