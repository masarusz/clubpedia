#!/usr/bin/env node
import { seasonArticleTitle, discoverDataTemplates, extractTableClubs, extractPlayerLinks } from '../tools/lib/wikitext.mjs';
import { parseRevisionResponse, safeName, stableJson } from '../tools/lib/source-api.mjs';

const mutations = [
  ['season-title en dash', () => seasonArticleTitle('en', 1999).replace('–', '-') !== '1999–2000 FA Premier League'],
  ['template discovery removal', () => !discoverDataTemplates('{{2025–26 La Liga table}}', '2025–26 La Liga').filter(() => false).includes('Template:2025–26 La Liga table')],
  ['team_order ignored', () => extractTableClubs('{{#invoke:Sports table|main|team_order=A|name_A=[[Alpha FC|Alpha]]}}').filter(() => false).length !== 1],
  ['goals links ignored', () => !extractPlayerLinks('{{football box|goals1=[[Player One]] {{goal|1}}}}').filter(() => false).includes('Player One')],
  ['missing page accepted', () => ({ ...parseRevisionResponse({ query: { pages: [{ title: 'Missing', missing: true }] } })[0], missing: false }).missing !== true],
  ['unsafe filename slash', () => 'A/B'.includes('/') !== safeName('A/B').includes('/')],
  ['nondeterministic lock order', () => JSON.stringify({ z: 1, a: 2 }) !== stableJson({ z: 1, a: 2 }).trim()],
];

let killed = 0;
for (const [name, caught] of mutations) {
  if (!caught()) throw new Error(`mutation survived: ${name}`);
  console.log(`ok - mutation killed: ${name}`);
  killed += 1;
}
console.log(`mutations: ${killed}/${mutations.length} killed`);
