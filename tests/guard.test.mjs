import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareDatasets, directoryDataset, renderReport } from '../tools/refresh-guard.mjs';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/guard');

async function compare(rule, variant, accepted = []) {
  const root = join(FIXTURES, rule);
  return compareDatasets(await directoryDataset(join(root, 'base')), await directoryDataset(join(root, variant)), accepted, { baseLabel: 'fixture' });
}

function status(result, number) { return result.rules.find((rule) => rule.number === number)?.status; }

export function register(test, equal, deepEqual) {
  test('refresh guard rule 1 passes unchanged completed seasons and holds changed facts', async () => {
    equal(status(await compare('rule1', 'pass'), 1), 'PASS');
    equal(status(await compare('rule1', 'hold'), 1), 'HOLD');
  });

  test('refresh guard accepted changes suppress only the exact rule 1 change', async () => {
    const accepted = JSON.parse(await readFile(join(FIXTURES, 'rule1/accepted-changes.json'), 'utf8'));
    equal(status(await compare('rule1', 'hold', accepted), 1), 'PASS');
    const wrong = structuredClone(accepted); wrong[0].to = 'Q-wrong';
    equal(status(await compare('rule1', 'hold', wrong), 1), 'HOLD');
    equal(status(await compare('rule1', 'hold', accepted), 2), 'PASS');
  });

  for (const number of [2, 3, 4, 5, 6]) {
    test(`refresh guard rule ${number} fixture proves PASS and HOLD`, async () => {
      equal(status(await compare(`rule${number}`, 'pass'), number), 'PASS');
      equal(status(await compare(`rule${number}`, 'hold'), number), 'HOLD');
    });
  }

  test('refresh guard reports every rule, rises, and a synthetic HOLD', async () => {
    const base = await directoryDataset(join(FIXTURES, 'rule5/base'));
    const pass = await directoryDataset(join(FIXTURES, 'rule5/pass'));
    const result = compareDatasets(base, pass, [], { syntheticHold: true, baseLabel: 'fixture' });
    const report = renderReport(result, { base: 'fixture', generated: 'fixed' });
    for (const number of [1, 2, 3, 4, 5, 6]) equal(report.includes(`Rule ${number}:`), true, `rule ${number} printed`);
    equal(report.includes('[HOLD] Rule synthetic:'), true);
    equal(report.includes('played matches rose'), true);
    deepEqual(result.rises.length > 0, true);
  });
}
