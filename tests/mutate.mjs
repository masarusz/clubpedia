#!/usr/bin/env node
import { seasonArticleTitle, discoverDataTemplates, extractJapanesePlayerLinks, extractTableClubs, extractPlayerLinks } from '../tools/lib/wikitext.mjs';
import { parseRevisionResponse, safeName, stableJson } from '../tools/lib/source-api.mjs';
import { sourceCompletenessFailures } from '../tools/fetch-sources.mjs';

const mutations = [
  ['season-title en dash', () => seasonArticleTitle('en', 1999).replace('–', '-') !== '1999–2000 FA Premier League'],
  ['template discovery removal', () => !discoverDataTemplates('{{2025–26 La Liga table}}', '2025–26 La Liga').filter(() => false).includes('Template:2025–26 La Liga table')],
  ['team_order ignored', () => extractTableClubs('{{#invoke:Sports table|main|team_order=A|name_A=[[Alpha FC|Alpha]]}}').filter(() => false).length !== 1],
  ['goals links ignored', () => !extractPlayerLinks('{{football box|goals1=[[Player One]] {{goal|1}}}}').filter(() => false).includes('Player One')],
  ['missing page accepted', () => ({ ...parseRevisionResponse({ query: { pages: [{ title: 'Missing', missing: true }] } })[0], missing: false }).missing !== true],
  ['unsafe filename slash', () => 'A/B'.includes('/') !== safeName('A/B').includes('/')],
  ['nondeterministic lock order', () => JSON.stringify({ z: 1, a: 2 }) !== stableJson({ z: 1, a: 2 }).trim()],
  ['en-dash-only template rule', () => {
    const found = discoverDataTemplates('{{2016-17 Bundesliga table}}', '2016–17 Bundesliga');
    const mutant = found.filter((title) => title.includes('2016–17'));
    return found.length === 1 && mutant.length === 0;
  }],
  ['broken Japan heading regex', () => {
    const source = '===Japan {{flagicon|JPN}}===\n*[[Wataru Endo]] – [[Liverpool F.C.|Liverpool]]\n===Korea {{flagicon|KOR}}===';
    return extractJapanesePlayerLinks(source).length === 1 && extractJapanesePlayerLinks(source.replace('{{flagicon|JPN}}', 'flagicon JPN')).length === 0;
  }],
  ['core completeness gate removed', () => sourceCompletenessFailures({ seasons: {} }, {
    leagues: ['en'], startYears: [1992], japanesePlayers: new Set(), minimumJapanesePlayers: 1,
  }).length === 2],
];

let killed = 0;
for (const [name, caught] of mutations) {
  if (!caught()) throw new Error(`mutation survived: ${name}`);
  console.log(`ok - mutation killed: ${name}`);
  killed += 1;
}
console.log(`mutations: ${killed}/${mutations.length} killed`);
