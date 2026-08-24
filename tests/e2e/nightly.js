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
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const E2E_DIR = __dirname;
const TESTS_DIR = path.resolve(E2E_DIR, '..');
const ROOT = path.resolve(TESTS_DIR, '..');
const REPORTS_DIR = path.join(E2E_DIR, 'reports');
const PROFILES_PATH = path.join(E2E_DIR, 'profiles.json');

const SUITES = [
  { id: 'verify-single-file', script: path.join(TESTS_DIR, 'verify-single-file.js') },
  { id: 'dsp-worker', script: path.join(TESTS_DIR, 'dsp-worker.test.js') },
  { id: 'audio-capture', script: path.join(TESTS_DIR, 'audio-capture.test.js') },
  { id: 'ai-dissector', script: path.join(TESTS_DIR, 'ai-dissector.test.js') },
  { id: 'ui-layout', script: path.join(TESTS_DIR, 'ui-layout.test.js') },
  { id: 'visualizer', script: path.join(TESTS_DIR, 'visualizer.test.js') },
  { id: 'theming', script: path.join(TESTS_DIR, 'theming.test.js') },
  { id: 'vibe-translators', script: path.join(TESTS_DIR, 'vibe-translators.test.js') },
  { id: 'limiter-eval', script: path.join(TESTS_DIR, 'limiter-eval.js') },
];

const REQUIRED_PROFILES = ['Neon', 'Aetheris'];
const SLIDER_KEYS = ['energy', 'warmth', 'density'];
const MIN_TAGS = 4;
const MAX_TAGS = 6;

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
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

const PENDING_NOTES = [
  'Profile seeding into live app state (localStorage["suno_profiles"]) activates when Workspace Profiling ships (FDD.md #77, FEATURE-MECHANICS.md 6.2). Today nightly.js validates the seed file only.',
  'Headless DOM interaction (slider drags, tag toggles, View Transitions) requires a browser driver; deliberately NOT stubbed — it stays out of scope until a zero-dependency driver is agreed.',
  'Tri-Mode AI fallback-chain coverage now runs in the ai-dissector suite against injected fetch fakes. A LIVE end-to-end call to a real cloud provider or a real Ollama server stays out of scope: it needs a secret and a network, which the offline-first, zero-dependency test policy forbids.',
  'Mode 1 ships as the embedded MUSIC_KB taxonomy engine, not a downloaded WebGPU LLM (ASSUMPTIONS.md). The provider slot for a real in-browser model is open; token-probability logit extraction (FDD.md #59) activates with it.',
];

function main() {
  const startedAt = new Date();
  console.log('SunoPrompt Studio — overnight E2E run');
  console.log(`  started : ${startedAt.toISOString()}`);
  console.log(`  node    : ${process.version} (${process.platform} ${process.arch})`);
  console.log(`  root    : ${ROOT}`);

  console.log('\n[1/2] Workspace Profiling seed validation');
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

  console.log('\n[2/2] Test suites');
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
  const ok = failedSuites.length === 0 && profiles.ok;

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

module.exports = { validateProfiles, parseCounts, REQUIRED_PROFILES, SLIDER_KEYS };

if (require.main === module) main();
