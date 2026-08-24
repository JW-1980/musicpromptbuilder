'use strict';
/*
 * tests/lib/runner.js — dependency-free micro test framework.
 *
 * Design rules (docs/ENGINEERING-STANDARD.md, zero-dependency policy):
 *   - Node built-ins only.
 *   - PASS / FAIL / TODO are three distinct, visually distinct outcomes.
 *   - TODO exists so that coverage which is *declared but not yet implemented*
 *     is reported honestly instead of being faked as a pass. Todos never fail
 *     a run; they are counted and printed separately.
 *   - process.exitCode is set to 1 ONLY when at least one test FAILs.
 *
 * Usage:
 *   const { suite } = require('./lib/runner.js');
 *   const s = suite('my suite');
 *   s.test('does a thing', () => { ... assert ... });
 *   s.todo('future thing', 'activates when X ships');
 *   s.finish().then(...)   // or: await s.finish();
 */

const SYM = { pass: '  PASS', fail: '  FAIL', todo: '  TODO' };

function createSuite(name) {
  /** @type {Array<{kind:'test'|'todo', name:string, fn?:Function, note?:string}>} */
  const entries = [];

  const api = {
    name,

    /** Register a test. `fn` may be sync or return a promise. */
    test(testName, fn) {
      if (typeof fn !== 'function') {
        throw new TypeError(`test("${testName}") requires a function`);
      }
      entries.push({ kind: 'test', name: testName, fn });
      return api;
    },

    /** Register declared-but-unimplemented coverage. Never fails the run. */
    todo(todoName, note) {
      entries.push({ kind: 'todo', name: todoName, note: note || '' });
      return api;
    },

    /**
     * Run every registered test in order and print the report.
     * @returns {Promise<{suite:string, passed:number, failed:number, todo:number,
     *                    results:Array<object>, ok:boolean}>}
     */
    async finish() {
      const started = Date.now();
      console.log(`\n=== ${name} ===`);

      let passed = 0;
      let failed = 0;
      let todoCount = 0;
      const results = [];

      for (const entry of entries) {
        if (entry.kind === 'todo') {
          todoCount += 1;
          results.push({ kind: 'todo', name: entry.name, note: entry.note });
          console.log(`${SYM.todo} ~ ${entry.name}${entry.note ? `  -- ${entry.note}` : ''}`);
          continue;
        }
        try {
          await entry.fn();
          passed += 1;
          results.push({ kind: 'pass', name: entry.name });
          console.log(`${SYM.pass} ${entry.name}`);
        } catch (err) {
          failed += 1;
          const message = (err && err.message) || String(err);
          results.push({ kind: 'fail', name: entry.name, error: message });
          console.log(`${SYM.fail} ${entry.name}`);
          console.log(`         ${message.split('\n').join('\n         ')}`);
          if (err && err.stack) {
            const frame = String(err.stack).split('\n').find((l) => l.includes('tests'));
            if (frame) console.log(`         at${frame.split(' at')[1] || ''}`);
          }
        }
      }

      const ms = Date.now() - started;
      const total = passed + failed;
      console.log(
        `--- ${name}: ${passed}/${total} passed, ${failed} failed, ${todoCount} todo  (${ms}ms)`
      );
      if (todoCount > 0 && total === 0) {
        console.log(`    (0 implemented / ${todoCount} todo — nothing is being faked as a pass)`);
      }

      if (failed > 0) process.exitCode = 1;

      return { suite: name, passed, failed, todo: todoCount, results, ok: failed === 0, ms };
    },
  };

  return api;
}

module.exports = { suite: createSuite, createSuite };
