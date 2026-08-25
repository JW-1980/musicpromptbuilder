'use strict';
/*
 * tests/e2e/nightly.js — overnight end-to-end orchestrator.
 *
 * Runs every suite as an isolated child process (so a crash in one cannot take
 * the run down), validates the Workspace Profiling seed file, writes a
 * timestamped JSON report to tests/e2e/reports/ (gitignored) and prints a
 * human-readable summary. Exits non-zero IFF a suite failed. Todos are
 * reported and counted but never fail the run.
 *
 * Node built-ins only: fs, path, child_process, os.
 *
 * ---------------------------------------------------------------------------
 * PROFILE SCHEMA (tests/e2e/profiles.json) — single source of truth, mirrored
 * in that file's "$schema-note" field:
 *
 *   {
 *     "$schema-note": string,          // human description of this shape
 *     "schemaVersion": integer >= 1,
 *     "profiles": [
 *       {
 *         "name":        string, non-empty, unique across the file
 *         "description": string, non-empty
 *         "sliders":     { "energy": 0-100, "warmth": 0-100, "density": 0-100 }
 *                        // integers; UI slider positions
 *         "genreTags":   [ { "tag": string, "weight": number > 0 } ]
 *                        // 4-6 entries; RELATIVE token weights, not
 *                        // probabilities — they need not sum to 1
 *         "metatags":    [ string ]     // non-empty; Suno section metatags
 *       }
 *     ]
 *   }
 *
 * REQUIRED_PROFILES below are the two defaults promised by FDD.md #77
 * ("Neon" for Scandi house / techno, "Aetheris" for progressive / ambient).
 *
 * SEEDING IS NOW LIVE (it was a PENDING note until Workspace Profiling shipped
 * in APP_VERSION 0.12.0). index.html embeds the same two profiles in #app-main
 * as `var DEFAULT_PROFILES` and seeds them into localStorage['suno_profiles']
 * on first boot (FEATURE-MECHANICS.md §6.2). Step [2/3] below extracts that
 * array out of the real production source with node:vm and checks it against
 * this file for MUSICAL EQUIVALENCE — same names, same slider zones, at least
 * four weighted tags each, and tags drawn from the same genre families. It is
 * deliberately not a byte-for-byte diff: the app's profile shape is not the
 * seed file's shape, and a reworded tag should not fail the run while a
 * profile that quietly turned into polka should.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { extractScriptById } = require('../lib/extract.js');

const E2E_DIR = __dirname;
const TESTS_DIR = path.resolve(E2E_DIR, '..');
const ROOT = path.resolve(TESTS_DIR, '..');
const REPORTS_DIR = path.join(E2E_DIR, 'reports');
const PROFILES_PATH = path.join(E2E_DIR, 'profiles.json');
const INDEX_PATH = path.join(ROOT, 'index.html');

const SUITES = [
  { id: 'verify-single-file', script: path.join(TESTS_DIR, 'verify-single-file.js') },
  { id: 'dsp-worker', script: path.join(TESTS_DIR, 'dsp-worker.test.js') },
  { id: 'audio-capture', script: path.join(TESTS_DIR, 'audio-capture.test.js') },
  { id: 'ai-dissector', script: path.join(TESTS_DIR, 'ai-dissector.test.js') },
  { id: 'local-llm', script: path.join(TESTS_DIR, 'local-llm.test.js') },
  { id: 'key-vault', script: path.join(TESTS_DIR, 'key-vault.test.js') },
  { id: 'ui-layout', script: path.join(TESTS_DIR, 'ui-layout.test.js') },
  { id: 'visualizer', script: path.join(TESTS_DIR, 'visualizer.test.js') },
  { id: 'theming', script: path.join(TESTS_DIR, 'theming.test.js') },
  { id: 'vibe-translators', script: path.join(TESTS_DIR, 'vibe-translators.test.js') },
  { id: 'structure-builder', script: path.join(TESTS_DIR, 'structure-builder.test.js') },
  { id: 'compiler', script: path.join(TESTS_DIR, 'compiler.test.js') },
  { id: 'midi-export', script: path.join(TESTS_DIR, 'midi-export.test.js') },
  { id: 'persistence', script: path.join(TESTS_DIR, 'persistence.test.js') },
  { id: 'vocal-registry', script: path.join(TESTS_DIR, 'vocal-registry.test.js') },
  { id: 'era-registry', script: path.join(TESTS_DIR, 'era-registry.test.js') },
  { id: 'limiter-eval', script: path.join(TESTS_DIR, 'limiter-eval.js') },
];

const REQUIRED_PROFILES = ['Neon', 'Aetheris'];
const SLIDER_KEYS = ['energy', 'warmth', 'density'];
const MIN_TAGS = 4;
const MAX_TAGS = 6;

/* The §4 slider zones (FEATURE-MECHANICS.md): strictly below 30 is low,
 * strictly above 70 is high. A default profile may be retuned within its zone
 * without failing the run; a profile that crosses a zone boundary has changed
 * what it SOUNDS like, and that is a real drift worth failing on. */
const SLIDER_LOW_BELOW = 30;
const SLIDER_HIGH_ABOVE = 70;

/* Words that carry no genre information, so they never count as a family
 * match between two tags. */
const TAG_STOPWORDS = ['the', 'a', 'an', 'of', 'and', 'with', 'in', 'to'];

/** How many tags of a profile must match the seed file EXACTLY. */
const MIN_EXACT_TAG_MATCHES = 3;

/* -------------------------------------------------------------------------- */
/* Suite execution                                                            */
/* -------------------------------------------------------------------------- */

/** Pull the runner's summary counts out of a suite's stdout. */
function parseCounts(stdout) {
  const m = /---\s.*?:\s(\d+)\/(\d+)\spassed,\s(\d+)\sfailed,\s(\d+)\stodo/.exec(stdout || '');
  if (!m) return { passed: null, total: null, failed: null, todo: null, parsed: false };
  return {
    passed: Number(m[1]),
    total: Number(m[2]),
    failed: Number(m[3]),
    todo: Number(m[4]),
    parsed: true,
  };
}

function runSuite(suite) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [suite.script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const exitCode = res.status === null ? -1 : res.status;
  return {
    id: suite.id,
    script: path.relative(ROOT, suite.script).split(path.sep).join('/'),
    exitCode,
    signal: res.signal || null,
    ok: exitCode === 0,
    durationMs: Date.now() - started,
    counts: parseCounts(stdout),
    stdout,
    stderr,
    spawnError: res.error ? String(res.error.message) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Profile validation                                                         */
/* -------------------------------------------------------------------------- */

function isInt(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

function validateProfiles(profilesPath) {
  /** @type {string[]} */
  const errors = [];
  const result = {
    path: path.relative(ROOT, profilesPath).split(path.sep).join('/'),
    ok: false,
    schemaVersion: null,
    profileNames: [],
    profileCount: 0,
    errors,
  };

  if (!fs.existsSync(profilesPath)) {
    errors.push(`profiles.json not found at ${profilesPath}`);
    return result;
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  } catch (err) {
    errors.push(`profiles.json is not valid JSON: ${err.message}`);
    return result;
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push('root must be an object');
    return result;
  }
  if (typeof doc['$schema-note'] !== 'string' || !doc['$schema-note'].trim()) {
    errors.push('missing "$schema-note" (the schema must document itself)');
  }
  if (!isInt(doc.schemaVersion) || doc.schemaVersion < 1) {
    errors.push(`schemaVersion must be an integer >= 1, got ${JSON.stringify(doc.schemaVersion)}`);
  } else {
    result.schemaVersion = doc.schemaVersion;
  }
  if (!Array.isArray(doc.profiles)) {
    errors.push('"profiles" must be an array');
    return result;
  }

  result.profileCount = doc.profiles.length;
  const seen = new Set();

  doc.profiles.forEach((p, i) => {
    const at = `profiles[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const label = typeof p.name === 'string' && p.name ? `"${p.name}"` : at;

    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push(`${at}.name must be a non-empty string`);
    } else {
      if (seen.has(p.name)) errors.push(`duplicate profile name ${label}`);
      seen.add(p.name);
      result.profileNames.push(p.name);
    }

    if (typeof p.description !== 'string' || !p.description.trim()) {
      errors.push(`${label}.description must be a non-empty string`);
    }

    if (!p.sliders || typeof p.sliders !== 'object' || Array.isArray(p.sliders)) {
      errors.push(`${label}.sliders must be an object`);
    } else {
      for (const key of SLIDER_KEYS) {
        const v = p.sliders[key];
        if (!isInt(v) || v < 0 || v > 100) {
          errors.push(`${label}.sliders.${key} must be an integer 0-100, got ${JSON.stringify(v)}`);
        }
      }
      for (const key of Object.keys(p.sliders)) {
        if (!SLIDER_KEYS.includes(key)) errors.push(`${label}.sliders has unknown key "${key}"`);
      }
    }

    if (!Array.isArray(p.genreTags)) {
      errors.push(`${label}.genreTags must be an array`);
    } else {
      if (p.genreTags.length < MIN_TAGS || p.genreTags.length > MAX_TAGS) {
        errors.push(
          `${label}.genreTags must hold ${MIN_TAGS}-${MAX_TAGS} entries, got ${p.genreTags.length}`
        );
      }
      const tags = new Set();
      p.genreTags.forEach((t, j) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push(`${label}.genreTags[${j}] must be an object`);
          return;
        }
        if (typeof t.tag !== 'string' || !t.tag.trim()) {
          errors.push(`${label}.genreTags[${j}].tag must be a non-empty string`);
        } else {
          if (tags.has(t.tag)) errors.push(`${label} repeats genre tag "${t.tag}"`);
          tags.add(t.tag);
        }
        if (typeof t.weight !== 'number' || !Number.isFinite(t.weight) || t.weight <= 0) {
          errors.push(
            `${label}.genreTags[${j}].weight must be a finite number > 0, got ${JSON.stringify(t.weight)}`
          );
        }
      });
    }

    if (!Array.isArray(p.metatags) || p.metatags.length === 0) {
      errors.push(`${label}.metatags must be a non-empty array`);
    } else {
      p.metatags.forEach((tag, j) => {
        if (typeof tag !== 'string' || !tag.trim()) {
          errors.push(`${label}.metatags[${j}] must be a non-empty string`);
        }
      });
    }
  });

  for (const required of REQUIRED_PROFILES) {
    if (!result.profileNames.includes(required)) {
      errors.push(`required default profile "${required}" is missing (FDD.md #77)`);
    }
  }

  result.ok = errors.length === 0;
  return result;
}

/* -------------------------------------------------------------------------- */
/* DEFAULT_PROFILES <-> profiles.json equivalence (ACTIVE since 0.12.0)        */
/* -------------------------------------------------------------------------- */

/**
 * Pull `DEFAULT_PROFILES` out of the real #app-main block by executing it in a
 * DOM-free node:vm sandbox. This is the production array the app seeds
 * localStorage['suno_profiles'] from on first boot — not a copy of it.
 *
 * @param {string} [indexPath]
 * @returns {{ok:boolean, profiles:Array<object>, error:string|null}}
 */
function extractDefaultProfiles(indexPath) {
  const target = indexPath || INDEX_PATH;
  try {
    const source = extractScriptById(target, 'app-main');
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
    // The boot IIFE returns immediately without a `document`, so nothing here
    // touches the DOM — only the top-level declarations are evaluated.
    vm.runInContext(source, sandbox, { filename: 'index.html#app-main' });
    const profiles = sandbox.DEFAULT_PROFILES;
    if (!Array.isArray(profiles)) {
      return { ok: false, profiles: [], error: '#app-main declares no DEFAULT_PROFILES array' };
    }
    return { ok: true, profiles, error: null };
  } catch (err) {
    return { ok: false, profiles: [], error: String((err && err.message) || err) };
  }
}

/** The §4 zone a slider position falls in. */
function sliderZoneName(value) {
  if (value < SLIDER_LOW_BELOW) return 'low';
  if (value > SLIDER_HIGH_ABOVE) return 'high';
  return 'mid';
}

/** Genre-bearing tokens of a tag, lower-cased, stopwords removed. */
function tagTokens(tag) {
  return String(tag)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !TAG_STOPWORDS.includes(t));
}

/** The weighted tags of an app-side profile, in {tag, weight} form. */
function appProfileTags(profile) {
  if (!profile || !Array.isArray(profile.genres)) return [];
  return profile.genres.map((g) =>
    typeof g === 'string' ? { tag: g, weight: 1 } : { tag: g && g.tag, weight: g && g.weight }
  );
}

/**
 * MUSICAL EQUIVALENCE between the app's embedded DEFAULT_PROFILES and the seed
 * file the overnight run has always validated.
 *
 * What is checked, and why each one is the honest question to ask:
 *   - both required names exist on both sides — FDD #77 promises them;
 *   - every app slider is an integer 0-100 (it is a UI slider position) and
 *     falls in the SAME §4 zone as the seed file's, so "Neon" cannot quietly
 *     stop being high-energy, cold and dense;
 *   - at least MIN_TAGS weighted tags, every weight finite and > 0;
 *   - at least MIN_EXACT_TAG_MATCHES tags match the seed file exactly, and
 *     every remaining app tag shares a genre-bearing token with some seed tag.
 *     Reword "afro house" to "afro house groove" and the run stays green;
 *     replace it with "polka" and it goes red.
 *
 * @param {Array<object>} defaults `DEFAULT_PROFILES` from #app-main
 * @param {object} seedDoc the parsed tests/e2e/profiles.json
 * @returns {{ok:boolean, errors:string[], names:string[], checked:number}}
 */
function validateSeededDefaults(defaults, seedDoc) {
  /** @type {string[]} */
  const errors = [];
  const names = [];

  if (!Array.isArray(defaults)) {
    return { ok: false, errors: ['DEFAULT_PROFILES is not an array'], names, checked: 0 };
  }
  if (!seedDoc || typeof seedDoc !== 'object' || !Array.isArray(seedDoc.profiles)) {
    return { ok: false, errors: ['the seed document has no profiles array'], names, checked: 0 };
  }

  const seedByName = new Map();
  for (const p of seedDoc.profiles) {
    if (p && typeof p.name === 'string') seedByName.set(p.name, p);
  }
  const appByName = new Map();
  for (const p of defaults) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push('DEFAULT_PROFILES holds a member that is not an object');
      continue;
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push('DEFAULT_PROFILES holds a profile with no name');
      continue;
    }
    if (appByName.has(p.name)) errors.push(`DEFAULT_PROFILES repeats the name "${p.name}"`);
    appByName.set(p.name, p);
    names.push(p.name);
  }

  let checked = 0;
  for (const required of REQUIRED_PROFILES) {
    const app = appByName.get(required);
    const seed = seedByName.get(required);
    if (!app) {
      errors.push(`DEFAULT_PROFILES is missing the required profile "${required}" (FDD.md #77)`);
      continue;
    }
    if (!seed) {
      errors.push(`profiles.json is missing the required profile "${required}" (FDD.md #77)`);
      continue;
    }
    checked += 1;

    /* --- sliders --- */
    if (!app.sliders || typeof app.sliders !== 'object' || Array.isArray(app.sliders)) {
      errors.push(`"${required}".sliders must be an object in DEFAULT_PROFILES`);
    } else {
      for (const key of SLIDER_KEYS) {
        const v = app.sliders[key];
        if (!isInt(v) || v < 0 || v > 100) {
          errors.push(
            `"${required}".sliders.${key} must be an integer 0-100 in DEFAULT_PROFILES, got ${JSON.stringify(v)}`
          );
          continue;
        }
        const seedValue = seed.sliders && seed.sliders[key];
        if (!isInt(seedValue)) continue; // the seed-file check above already failed it
        const appZone = sliderZoneName(v);
        const seedZone = sliderZoneName(seedValue);
        if (appZone !== seedZone) {
          errors.push(
            `"${required}".sliders.${key} drifted out of its zone: app ${v} (${appZone}) vs seed ${seedValue} (${seedZone})`
          );
        }
      }
    }

    /* --- weighted tags --- */
    const appTags = appProfileTags(app);
    if (appTags.length < MIN_TAGS) {
      errors.push(
        `"${required}" must carry at least ${MIN_TAGS} weighted genre tags in DEFAULT_PROFILES, got ${appTags.length}`
      );
    }
    for (let i = 0; i < appTags.length; i += 1) {
      const t = appTags[i];
      if (typeof t.tag !== 'string' || !t.tag.trim()) {
        errors.push(`"${required}".genres[${i}].tag must be a non-empty string`);
      }
      if (typeof t.weight !== 'number' || !Number.isFinite(t.weight) || t.weight <= 0) {
        errors.push(
          `"${required}".genres[${i}].weight must be a finite number > 0, got ${JSON.stringify(t.weight)}`
        );
      }
    }

    /* --- tag families --- */
    const seedTags = Array.isArray(seed.genreTags) ? seed.genreTags : [];
    const seedNames = seedTags
      .map((t) => (t && typeof t.tag === 'string' ? t.tag.toLowerCase().trim() : ''))
      .filter(Boolean);
    const seedVocabulary = new Set();
    for (const tag of seedNames) for (const token of tagTokens(tag)) seedVocabulary.add(token);

    let exactMatches = 0;
    for (const t of appTags) {
      if (typeof t.tag !== 'string' || !t.tag.trim()) continue;
      const lower = t.tag.toLowerCase().trim();
      if (seedNames.includes(lower)) {
        exactMatches += 1;
        continue;
      }
      const shared = tagTokens(lower).some((token) => seedVocabulary.has(token));
      if (!shared) {
        errors.push(
          `"${required}" genre tag "${t.tag}" belongs to no family in profiles.json (no shared term with ${seedNames.join(', ')})`
        );
      }
    }
    if (exactMatches < MIN_EXACT_TAG_MATCHES) {
      errors.push(
        `"${required}" shares only ${exactMatches} exact genre tag(s) with profiles.json; at least ${MIN_EXACT_TAG_MATCHES} required`
      );
    }
  }

  return { ok: errors.length === 0, errors, names, checked };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

const PENDING_NOTES = [
  'Headless DOM interaction (slider drags, tag toggles, View Transitions) requires a browser driver; deliberately NOT stubbed — it stays out of scope until a zero-dependency driver is agreed.',
  'Tri-Mode AI fallback-chain coverage now runs in the ai-dissector suite against injected fetch fakes. A LIVE end-to-end call to a real cloud provider or a real Ollama server stays out of scope: it needs a secret and a network, which the offline-first, zero-dependency test policy forbids.',
  'Mode 1b (the on-device LLM) ships as of 0.17.0 and is covered by the local-llm suite: the variant picker, the consent gate under an injected fetch recorder, and the worker protocol including the SHA-256 refusal of a tampered runtime. What stays out of scope is a REAL download, import and generation — ~500 MB of weights and third-party code executing, neither of which belongs in an offline test run. Token-probability logit extraction (FDD.md #59) is still unimplemented.',
  'The persistence suite drives createIdbStore() against a hand-written fake IndexedDB (real event model: onupgradeneeded/onsuccess/onerror, real transaction completion). A REAL browser IndexedDB, a real clipboard write and a real data: download are browser-only surfaces and stay out of scope for the same reason the DOM-interaction note above does.',
];

function main() {
  const startedAt = new Date();
  console.log('SunoPrompt Studio — overnight E2E run');
  console.log(`  started : ${startedAt.toISOString()}`);
  console.log(`  node    : ${process.version} (${process.platform} ${process.arch})`);
  console.log(`  root    : ${ROOT}`);

  console.log('\n[1/3] Workspace Profiling seed validation');
  const profiles = validateProfiles(PROFILES_PATH);
  if (profiles.ok) {
    console.log(
      `  PASS ${profiles.path} — schemaVersion ${profiles.schemaVersion}, ` +
        `${profiles.profileCount} profile(s): ${profiles.profileNames.join(', ')}`
    );
  } else {
    console.log(`  FAIL ${profiles.path} — ${profiles.errors.length} schema error(s):`);
    for (const e of profiles.errors) console.log(`       - ${e}`);
  }

  /* ACTIVE since APP_VERSION 0.12.0 — this was the long-standing PENDING note.
   * The app now seeds these profiles into localStorage['suno_profiles'] on
   * first boot, so the seed file and the shipped array must agree. */
  console.log('\n[2/3] Seeded DEFAULT_PROFILES vs the seed file (FDD.md #77, FEATURE-MECHANICS.md §6.2)');
  const extracted = extractDefaultProfiles(INDEX_PATH);
  let seededDefaults;
  if (!extracted.ok) {
    seededDefaults = {
      ok: false,
      errors: [`could not read DEFAULT_PROFILES from index.html#app-main: ${extracted.error}`],
      names: [],
      checked: 0,
    };
  } else {
    let seedDoc = null;
    try {
      seedDoc = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    } catch (err) {
      seedDoc = null;
    }
    seededDefaults = validateSeededDefaults(extracted.profiles, seedDoc);
  }
  if (seededDefaults.ok) {
    console.log(
      `  PASS index.html#app-main seeds ${seededDefaults.names.length} profile(s): ` +
        `${seededDefaults.names.join(', ')} — ${seededDefaults.checked} checked for musical ` +
        `equivalence against ${path.relative(ROOT, PROFILES_PATH).split(path.sep).join('/')}`
    );
  } else {
    console.log(`  FAIL DEFAULT_PROFILES — ${seededDefaults.errors.length} error(s):`);
    for (const e of seededDefaults.errors) console.log(`       - ${e}`);
  }

  console.log('\n[3/3] Test suites');
  const suiteResults = [];
  for (const suite of SUITES) {
    const r = runSuite(suite);
    suiteResults.push(r);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.spawnError) console.log(`  spawn error: ${r.spawnError}`);
  }

  const totals = suiteResults.reduce(
    (acc, r) => {
      acc.passed += r.counts.passed || 0;
      acc.failed += r.counts.failed || 0;
      acc.todo += r.counts.todo || 0;
      return acc;
    },
    { passed: 0, failed: 0, todo: 0 }
  );

  const failedSuites = suiteResults.filter((r) => !r.ok).map((r) => r.id);
  const ok = failedSuites.length === 0 && profiles.ok && seededDefaults.ok;

  const finishedAt = new Date();
  const report = {
    tool: 'sunoprompt-studio/nightly-e2e',
    reportVersion: 1,
    timestamp: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      os: `${os.type()} ${os.release()}`,
    },
    ok,
    profiles: {
      path: profiles.path,
      ok: profiles.ok,
      schemaVersion: profiles.schemaVersion,
      profileNames: profiles.profileNames,
      requiredProfiles: REQUIRED_PROFILES,
      errors: profiles.errors,
    },
    seededDefaults: {
      source: 'index.html#app-main DEFAULT_PROFILES',
      ok: seededDefaults.ok,
      extracted: extracted.ok,
      extractError: extracted.error,
      names: seededDefaults.names,
      checked: seededDefaults.checked,
      errors: seededDefaults.errors,
    },
    totals: { ...totals, suites: suiteResults.length, failedSuites },
    suites: suiteResults.map((r) => ({
      id: r.id,
      script: r.script,
      ok: r.ok,
      exitCode: r.exitCode,
      signal: r.signal,
      durationMs: r.durationMs,
      passed: r.counts.passed,
      failed: r.counts.failed,
      todo: r.counts.todo,
      countsParsed: r.counts.parsed,
      spawnError: r.spawnError,
      stdout: r.stdout,
      stderr: r.stderr,
    })),
    pendingNotes: PENDING_NOTES,
  };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORTS_DIR, `nightly-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n========================================');
  console.log('  OVERNIGHT E2E SUMMARY');
  console.log('========================================');
  console.log(`  profiles seed : ${profiles.ok ? 'OK' : 'FAILED'} (${profiles.profileNames.join(', ') || 'none'})`);
  console.log(
    `  seeded app    : ${seededDefaults.ok ? 'OK' : 'FAILED'} (${seededDefaults.names.join(', ') || 'none'})`
  );
  for (const r of suiteResults) {
    const status = r.ok ? 'PASS' : 'FAIL';
    const counts = r.counts.parsed
      ? `${r.counts.passed}/${r.counts.total} passed, ${r.counts.failed} failed, ${r.counts.todo} todo`
      : 'no summary line parsed';
    console.log(`  ${status}  ${r.id.padEnd(20)} exit ${r.exitCode}  ${counts}  (${r.durationMs}ms)`);
  }
  console.log('  ----------------------------------------');
  console.log(`  totals        : ${totals.passed} passed, ${totals.failed} failed, ${totals.todo} todo`);
  console.log(`  report        : ${reportPath}`);
  console.log(`  duration      : ${report.durationMs}ms`);

  console.log('\n  PENDING (reported, not failing):');
  for (const note of PENDING_NOTES) console.log(`    TODO ~ ${note}`);

  console.log(`\n  RESULT: ${ok ? 'GREEN' : 'RED'}`);
  if (!ok && failedSuites.length) console.log(`  failed suites: ${failedSuites.join(', ')}`);
  console.log('');

  process.exitCode = ok ? 0 : 1;
}

module.exports = {
  validateProfiles,
  validateSeededDefaults,
  extractDefaultProfiles,
  sliderZoneName,
  tagTokens,
  parseCounts,
  REQUIRED_PROFILES,
  SLIDER_KEYS,
  MIN_TAGS,
  MIN_EXACT_TAG_MATCHES,
  PROFILES_PATH,
  INDEX_PATH,
};

if (require.main === module) main();
