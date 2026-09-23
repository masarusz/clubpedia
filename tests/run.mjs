#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import { register as fetchTests } from './fetch.test.mjs';
import { register as mutationTests } from './mutation.test.mjs';

const checks = [];
const test = (name, run) => checks.push({ name, run });
const describe = (value) => JSON.stringify(value);
const equal = (actual, expected, context = '') => {
  if (!Object.is(actual, expected)) throw new Error(`${context ? `${context}: ` : ''}expected ${describe(expected)}, got ${describe(actual)}`);
};
const deepEqual = (actual, expected, context = '') => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${context ? `${context}: ` : ''}expected ${describe(expected)}, got ${describe(actual)}`);
};

fetchTests(test, equal, deepEqual);
mutationTests(test, equal);

let passed = 0;
let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`ok - ${check.name}`);
    passed += 1;
  } catch (error) {
    console.log(`not ok - ${check.name} - ${error.stack ?? error.message}`);
    failed += 1;
  }
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
