import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareIndex, search } from '../public/js/search.js';

const ROOT = resolve(import.meta.dirname, '..');
const load = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

export function register(test, equal) {
  test('lazy-kid oracle: every kana query reaches its named page first (tests/golden/lazykid.json)', () => {
    const oracle = load('tests/golden/lazykid.json');
    const entries = load('public/data/search.json');
    const index = prepareIndex(entries);
    let passCount = 0;
    const failures = [];
    for (const testCase of oracle.cases) {
      const results = search(index, testCase.q, { limit: 5 });
      const first = results[0] ? `${results[0].type}:${results[0].id}` : '(no result)';
      const ok = first === testCase.first;
      if (ok) passCount += 1;
      else failures.push(`  "${testCase.q}" -> ${first}, expected ${testCase.first}${testCase.note ? ` (${testCase.note})` : ''}`);
      console.log(`lazy-kid: "${testCase.q}" -> ${first}${ok ? '' : ` (expected ${testCase.first})`}`);
    }
    console.log(`lazy-kid result: ${passCount}/${oracle.cases.length}`);
    equal(failures.length === 0, true, failures.length ? `lazy-kid misses:\n${failures.join('\n')}` : '');
  });
}
