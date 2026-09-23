#!/usr/bin/env node
import { seasonArticleTitle, discoverDataTemplates, extractJapanesePlayerLinks, extractTableClubs, extractPlayerLinks, findTemplates } from '../tools/lib/wikitext.mjs';
import { parseRevisionResponse, safeName, stableJson } from '../tools/lib/source-api.mjs';
import { sourceCompletenessFailures } from '../tools/fetch-sources.mjs';
import { discrepancies } from '../tools/lib/core-data.mjs';
import { leagueFootballBoxes, parseGoalSide } from '../tools/lib/scorers.mjs';
import { compareGoalMinutes, mergeReadings } from '../tools/lib/build-scorers.mjs';
import { parseDomesticSeasons, topFlightLeague } from '../tools/lib/japan-domestic.mjs';
import { reconciledGoals } from '../tools/lib/openligadb.mjs';
import { scorerIdentityIssue } from '../tools/lib/players.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CACHE = resolve(ROOT, '.cache/sources');

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
  // --- Phase 2b -------------------------------------------------------
  ['league-section box rule dropped (Community Shield check)', () => {
    const article = JSON.parse(readFileSync(resolve(CACHE, 'enwiki/2023%E2%80%9324%20Arsenal%20F.C.%20season.json')));
    const allBoxes = findTemplates(article.content).filter((t) => /^football\s*box(?:\s+collapsible)?$/i.test(t.name));
    const shieldBox = allBoxes.find((b) => /Manchester City/.test(b.params.team2 || '') && /1[–-]1/.test(b.params.score || ''));
    const leagueBoxes = leagueFootballBoxes(article.content, 'en');
    // Caught only if dropping the league-section rule (i.e. accepting every
    // box in the article) would let the Community Shield box through, while
    // our actual leagueFootballBoxes correctly excludes it.
    return Boolean(shieldBox) && !leagueBoxes.includes(shieldBox);
  }],
  ['o.g. flag ignored (Liverpool 4-1 Norwich)', () => {
    const article = JSON.parse(readFileSync(resolve(CACHE, 'enwiki/2019%E2%80%9320%20Liverpool%20F.C.%20season.json')));
    const box = leagueFootballBoxes(article.content, 'en').find((b) => /Norwich/.test(b.params.team2 || '') && /4[–-]1/.test(b.params.score || ''));
    const hanley = parseGoalSide(box.params.goals1).find((event) => /Hanley/.test(event.display || ''));
    return Boolean(hanley?.ownGoal);
  }],
  ['2. Bundesliga rows accepted as top flight (Okudera 1980-81 Hertha)', () => {
    const article = JSON.parse(readFileSync(resolve(CACHE, 'jawiki/%E5%A5%A5%E5%AF%BA%E5%BA%B7%E5%BD%A6.json')));
    const seasons = parseDomesticSeasons(article.content);
    const included = seasons.some((item) => item.clubTarget === 'ヘルタ・ベルリン' && topFlightLeague(item.country, item.league) === 'de');
    return !included;
  }],
  ['OpenLigaDB stoppage-time minute left unconverted (Tel 90+4)', () => {
    const source = JSON.parse(readFileSync(resolve(CACHE, 'openligadb/bl1-2023.json')));
    const match = source.find((item) => item.team1?.teamName === 'SV Werder Bremen' && item.team2?.teamName === 'FC Bayern München');
    const reconciled = reconciledGoals(match, 0, 4);
    const tel = reconciled.away.find((event) => event.name === 'M. Tel');
    return tel?.minute === '90+4';
  }],
  ['club-first Japanese career table omitted (Kamada 2022-23)', () => {
    const article = JSON.parse(readFileSync(resolve(CACHE, 'jawiki/%E9%8E%8C%E7%94%B0%E5%A4%A7%E5%9C%B0.json')));
    return parseDomesticSeasons(article.content).some((item) => item.season === '2022–23' && item.apps === 32 && item.goals === 9);
  }],
  ['minute-only scorer disagreement rejected instead of preferring scorer club', () => {
    const readings = [
      { source: 'home', events: [{ player: 'p', display: 'P', minute: '74', isPenalty: false, ownGoal: false }] },
      { source: 'away', events: [{ player: 'p', display: 'P', minute: '75', isPenalty: false, ownGoal: false }] },
    ];
    const merged = mergeReadings(readings, 'away', 'home');
    return merged.ok && merged.events[0].minute === '75';
  }],
  ['football-minute ordering changed to lexical ordering', () => {
    const events = [{ minute: '46' }, { minute: '45+2' }, { minute: '45' }, { minute: '90+11' }].sort(compareGoalMinutes);
    return events.map((event) => event.minute).join(',') === '45,45+2,46,90+11';
  }],
  ['wrong-person occupation and age gates removed', () => {
    const footballer = { claims: { P106: [{ mainsnak: { datavalue: { value: { id: 'Q937857' } } } }] } };
    return scorerIdentityIssue({ entity: { claims: {} }, birth: { year: 1990 }, seasonYear: 2020 }) === 'not-footballer'
      && scorerIdentityIssue({ entity: footballer, birth: { year: 1900 }, seasonYear: 2020 }) === 'age-over-45';
  }],
];

let killed = 0;
for (const [name, caught] of mutations) {
  if (!caught()) throw new Error(`mutation survived: ${name}`);
  console.log(`ok - mutation killed: ${name}`);
  killed += 1;
}
console.log(`mutations: ${killed}/${mutations.length} killed`);
