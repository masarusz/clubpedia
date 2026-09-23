#!/usr/bin/env node
import { seasonArticleTitle, discoverDataTemplates, extractJapanesePlayerLinks, extractTableClubs, extractPlayerLinks } from '../tools/lib/wikitext.mjs';
import { parseRevisionResponse, safeName, stableJson } from '../tools/lib/source-api.mjs';
import { sourceCompletenessFailures } from '../tools/fetch-sources.mjs';
import { discrepancies } from '../tools/lib/core-data.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

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
  ['official table re-sorted by points', () => {
    const season = JSON.parse(readFileSync(resolve(ROOT, 'public/data/s/it-2005.json')));
    const juventus = season.table.find((row) => row.club === 'Q1422');
    const mutantPosition = [...season.table].sort((a, b) => b.points - a.points).findIndex((row) => row.club === 'Q1422') + 1;
    return juventus.position === 20 && mutantPosition !== 20;
  }],
  ['stray JUV parameter treated as deduction', () => {
    const season = JSON.parse(readFileSync(resolve(ROOT, 'public/data/s/it-2005.json')));
    const juventus = season.table.find((row) => row.club === 'Q1422');
    return juventus.adjustment === 0 && juventus.points !== 0;
  }],
  ['results codes assumed equal to table codes', () => {
    const season = JSON.parse(readFileSync(resolve(ROOT, 'public/data/s/de-2014.json')));
    const augsburg = season.table.find((row) => row.sourceTitle === 'FC Augsburg');
    return Boolean(augsburg) && season.matches.some((match) => match.home === augsburg.club || match.away === augsburg.club);
  }],
  ['reviewed correct-cell dropped', () => {
    const season = JSON.parse(readFileSync(resolve(ROOT, 'public/data/s/es-1999.json')));
    const match = season.matches.find((item) => item.key === 'es-1999-Q223620-Q7156');
    [match.homeGoals, match.awayGoals] = match.correctedFrom.split('–').map(Number);
    return discrepancies(season).length > 0;
  }],
  ['reviewed awarded outcome ignored', () => {
    const season = JSON.parse(readFileSync(resolve(ROOT, 'public/data/s/fr-2000.json')));
    const match = season.matches.find((item) => item.key === 'fr-2000-Q19521-Q19518');
    match.status = 'played'; delete match.winner;
    return discrepancies(season).length > 0;
  }],
];

let killed = 0;
for (const [name, caught] of mutations) {
  if (!caught()) throw new Error(`mutation survived: ${name}`);
  console.log(`ok - mutation killed: ${name}`);
  killed += 1;
}
console.log(`mutations: ${killed}/${mutations.length} killed`);
