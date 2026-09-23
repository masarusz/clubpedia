import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discrepancies, metadataIndex } from '../tools/lib/core-data.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'public/data');
const CACHE = join(ROOT, '.cache/sources');
const GOLDEN = JSON.parse(await readFile(join(ROOT, 'tests/golden/facts.json'), 'utf8'));

async function treeDigest(root) {
  const hash = createHash('sha256');
  async function walk(directory) {
    for (const name of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, name.name); hash.update(path.slice(root.length));
      if (name.isDirectory()) await walk(path); else hash.update(await readFile(path));
    }
  }
  await walk(root); return hash.digest('hex');
}

export function register(test, equal, deepEqual) {
  let index; let clubs; let metadata;
  test('offline core build completes in inspection mode', async () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'tools/build-data.mjs'), '--allow-proposed'], { cwd: ROOT, encoding: 'utf8' });
    equal(output.includes('Built 170 league-seasons'), true);
    index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
    clubs = JSON.parse(await readFile(join(ROOT, 'curated/clubs.json'), 'utf8'));
    metadata = await metadataIndex(CACHE);
  });
  test('all 170 golden season facts match official tables and source-score counts', async () => {
    equal(index.seasons.length, GOLDEN.seasonCount);
    for (const [id, fact] of Object.entries(GOLDEN.seasons)) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${id}.json`), 'utf8'));
      equal(season.table.length, fact.clubs, `${id} clubs`);
      equal(season.matches.filter((match) => match.status !== 'double-defeat').length, fact.matchesWithScore, `${id} source scores`);
      equal(season.table.reduce((sum, row) => sum + row.gf, 0), fact.goals, `${id} official goals`);
    }
  });
  test('golden champions resolve by Wikidata id', async () => {
    for (const [id, title] of Object.entries(GOLDEN.champions)) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${id}.json`), 'utf8'));
      const expected = title == null ? null : metadata.get(title)?.wikibaseItem;
      equal(season.champion, expected, id);
    }
  });
  test('golden deductions, table rows, and placements hold', async () => {
    for (const fact of GOLDEN.deductions) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${fact.season}.json`), 'utf8'));
      const id = metadata.get(fact.club)?.wikibaseItem;
      equal(season.table.find((row) => row.club === id)?.adjustment, fact.points, `${fact.season} ${fact.club}`);
    }
    for (const fact of GOLDEN.tableRows) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${fact.season}.json`), 'utf8'));
      const id = metadata.get(fact.club)?.wikibaseItem; const row = season.table.find((item) => item.club === id);
      for (const key of ['w', 'd', 'l', 'gf', 'ga']) equal(row?.[key], fact[key], `${fact.season} ${fact.club} ${key}`);
    }
    for (const fact of GOLDEN.specialPlacements) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${fact.season}.json`), 'utf8'));
      const id = metadata.get(fact.club)?.wikibaseItem; const row = season.table.find((item) => item.club === id);
      for (const key of ['position', 'points']) if (fact[key] != null) equal(row?.[key], fact[key], `${fact.season} ${fact.club} ${key}`);
      if (fact.deduction != null) equal(row?.adjustment, fact.deduction, `${fact.season} ${fact.club} deduction`);
    }
  });
  test('special match statuses and curtailed season hold', async () => {
    const french1992 = JSON.parse(await readFile(join(DATA, 's/fr-1992.json'), 'utf8'));
    equal(french1992.matches.filter((match) => match.status === 'double-defeat').length, 1);
    const french2019 = JSON.parse(await readFile(join(DATA, 's/fr-2019.json'), 'utf8'));
    equal(french2019.matches.length, 279);
  });
  test('all five reviewed action types are represented in generated data', async () => {
    const corrected = JSON.parse(await readFile(join(DATA, 's/es-1999.json'), 'utf8'));
    const correctedMatch = corrected.matches.find((match) => match.key === 'es-1999-Q223620-Q7156');
    equal(correctedMatch.correctedFrom, '2–3');
    equal(correctedMatch.homeGoals, 2); equal(correctedMatch.awayGoals, 1);
    equal(Boolean(correctedMatch.evidence), true);

    const awarded = JSON.parse(await readFile(join(DATA, 's/fr-2000.json'), 'utf8'));
    const awardedMatch = awarded.matches.find((match) => match.key === 'fr-2000-Q19521-Q19518');
    equal(awardedMatch.status, 'awarded'); equal(awardedMatch.winner, 'Q19518');
    equal(awardedMatch.homeGoals, 0); equal(awardedMatch.awayGoals, 0);
    equal(Boolean(awardedMatch.pitchScore && awardedMatch.decidedBy), true);

    const doubleDefeat = JSON.parse(await readFile(join(DATA, 's/fr-1992.json'), 'utf8'));
    equal(doubleDefeat.matches.find((match) => match.status === 'double-defeat').evidence.length > 0, true);

    const correctedTable = JSON.parse(await readFile(join(DATA, 's/es-2000.json'), 'utf8'));
    const row = correctedTable.table.find((item) => item.club === 'Q8780');
    equal(row.position, 9); equal(row.points, 50); equal(row.w, 14); equal(row.d, 8);
    equal(row.correctedFrom.w, 15);

    const unreconciled = JSON.parse(await readFile(join(DATA, 's/es-2012.json'), 'utf8'));
    const unreconciledMatch = unreconciled.matches.find((match) => match.key === 'es-2012-Q8682-Q8835');
    equal(unreconciledMatch.unreconciled, true);
    equal(unreconciled.table.find((item) => item.club === unreconciledMatch.home).unreconciled, true);
    equal(unreconciled.table.find((item) => item.club === unreconciledMatch.away).unreconciled, true);
  });
  test('reviewed corrections leave only explicitly marked unreconciled differences', async () => {
    for (const summary of index.seasons) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${summary.id}.json`), 'utf8'));
      const different = discrepancies(season).map((item) => item.club).sort();
      const marked = season.table.filter((row) => row.unreconciled).map((row) => row.club).sort();
      deepEqual(different, marked, summary.id);
    }
  });
  test('top-scorer clubs resolve wherever a single season club is stated', async () => {
    let total = 0; let missing = 0;
    for (const summary of index.seasons) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${summary.id}.json`), 'utf8'));
      total += season.topScorers.length;
      missing += season.topScorers.filter((entry) => entry.club == null).length;
    }
    equal(total, 1700);
    equal(missing, 0);
  });
  test('home index stays below 40 KB and history is split by league', async () => {
    equal((await readFile(join(DATA, 'index.json'))).length <= 40 * 1024, true);
    equal('champions' in index, false); equal('historicalTopScorers' in index, false);
    for (const league of ['en', 'es', 'de', 'it', 'fr']) {
      const history = JSON.parse(await readFile(join(DATA, 'h', `${league}.json`), 'utf8'));
      equal(history.league, league); equal(history.champions.length > 0, true); equal(history.topScorers.length > 0, true);
    }
  });
  test('every output club id is curated and all discrepancies are explicit', async () => {
    const corrections = JSON.parse(await readFile(join(ROOT, 'curated/results-corrections.json'), 'utf8'));
    equal(corrections.length, 14);
    for (const summary of index.seasons) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${summary.id}.json`), 'utf8'));
      for (const row of season.table) equal(Boolean(clubs[row.club]), true, `${summary.id} ${row.club}`);
    }
  });
  test('build is byte-identical and outputs contain no local paths', async () => {
    const before = await treeDigest(DATA);
    execFileSync(process.execPath, [join(ROOT, 'tools/build-data.mjs'), '--allow-proposed'], { cwd: ROOT, encoding: 'utf8' });
    equal(await treeDigest(DATA), before);
    for (const directory of ['', 's', 'c', 'h']) for (const name of await readdir(join(DATA, directory))) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(join(DATA, directory, name), 'utf8');
      equal(text.includes('/Users/'), false, name);
      equal(text.includes('\\Users\\'), false, name);
    }
  });
}
