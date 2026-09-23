import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

export function register(test, equal) {
  test('wikitext, API, filename, and lock mutations are killed', () => {
    const output = execFileSync(process.execPath, [resolve(ROOT, 'tests/mutate.mjs')], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(output);
    equal(output.includes('mutations: 15/15 killed'), true);
  });
}
