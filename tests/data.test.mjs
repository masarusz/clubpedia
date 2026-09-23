import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discrepancies, metadataIndex, normalizeTitle } from '../tools/lib/core-data.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'public/data');
const CACHE = join(ROOT, '.cache/sources');
const GOLDEN = JSON.parse(await readFile(join(ROOT, 'tests/golden/facts.json'), 'utf8'));
const GOLDEN2B = JSON.parse(await readFile(join(ROOT, 'tests/golden/phase2b.json'), 'utf8'));

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
  test('suite preflight produced a complete fresh build', async () => {
    index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
    equal(index.seasons.length, 170);
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
    for (const directory of ['', 's', 'c', 'h', 'o', 'p']) for (const name of await readdir(join(DATA, directory))) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(join(DATA, directory, name), 'utf8');
      equal(text.includes('/Users/'), false, name);
      equal(text.includes('\\Users\\'), false, name);
    }
  });

  // --- Phase 2b: scorers, players, Japanese names -------------------------
  function metaId(title) { return metadata.get(normalizeTitle(title))?.wikibaseItem; }
  function findMatch(season, homeTitle, awayTitle) {
    const home = metaId(homeTitle); const away = metaId(awayTitle);
    return season.matches.find((match) => match.key === `${season.id}-${home}-${away}`);
  }

  test('every golden phase2b match-box fact holds (league box, not cup; own goals credited correctly)', async () => {
    for (const fact of GOLDEN2B.matchScorers) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${fact.season}.json`), 'utf8'));
      const match = findMatch(season, fact.home, fact.away);
      equal(Boolean(match), true, `${fact.season} ${fact.home} v ${fact.away}`);
      equal(Boolean(match.scorers), true, `${fact.season} ${fact.home} v ${fact.away} has scorers`);
      for (const [side, expectedGoals] of [['home', fact.home_goals], ['away', fact.away_goals]]) {
        const actual = match.scorers[side];
        equal(actual.length, expectedGoals.length, `${fact.season} ${fact.home} v ${fact.away} ${side} count`);
        for (const expected of expectedGoals) {
          const expectedId = metaId(expected.player);
          const found = actual.find((scorer) => scorer.minute === expected.minute && scorer.player === expectedId);
          equal(Boolean(found), true, `${fact.season} ${fact.home} v ${fact.away} ${side} ${expected.player} ${expected.minute}`);
          if (expected.ownGoal) equal(found.ownGoal, true, `${fact.season} ${fact.home} v ${fact.away} ${side} ${expected.player} own goal flag`);
        }
      }
    }
  });

  test('the FA Community Shield box never attaches to the Arsenal-Man City league fixture', async () => {
    const season = JSON.parse(await readFile(join(DATA, 's/en-2023.json'), 'utf8'));
    const match = findMatch(season, 'Arsenal F.C.', 'Manchester City F.C.');
    equal(match.homeGoals, 1); equal(match.awayGoals, 0);
    equal(match.scorers.home.length, 1);
    equal(match.scorers.home[0].player, metaId('Gabriel Martinelli'));
    equal(match.scorers.away.length, 0);
  });

  test('minute-only disagreement uses the scorer club article and keeps Wikipedia scorers', async () => {
    const season = JSON.parse(await readFile(join(DATA, 's/de-2023.json'), 'utf8'));
    const match = findMatch(season, 'SV Werder Bremen', 'FC Bayern Munich');
    equal(Boolean(match.scorers), true);
    equal(match.scorers.away.find((event) => event.display === 'Kane').minute, '75', 'Bayern article minute wins for Bayern scorer');
    equal(match.scorers.away.at(-1).minute, '90+4');
    equal((await readdir(join(DATA, 'o'))).includes('de-2023.json'), false, 'no ODbL file is emitted when every match has Wikipedia scorers');
  });

  test('Wikipedia goals are sorted by football minute including stoppage time', async () => {
    const value = (minute) => { const [base, added = '0'] = String(minute ?? '9999').split('+'); return Number(base) * 100 + Number(added); };
    for (const summary of index.seasons) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${summary.id}.json`), 'utf8'));
      for (const match of season.matches) if (match.scorers) for (const side of ['home', 'away']) {
        const minutes = match.scorers[side].map((event) => value(event.minute));
        deepEqual(minutes, [...minutes].sort((a, b) => a - b), `${match.key} ${side}`);
      }
    }
  });

  test('every scorer resolves to a Wikidata id or is counted (no silent Latin-only fallback)', async () => {
    let total = 0; let unlinked = 0;
    for (const summary of index.seasons) {
      const season = JSON.parse(await readFile(join(DATA, 's', `${summary.id}.json`), 'utf8'));
      for (const match of season.matches) {
        if (!match.scorers) continue;
        for (const side of ['home', 'away']) for (const scorer of match.scorers[side]) { total += 1; if (!scorer.player) unlinked += 1; }
      }
    }
    equal(total > 0, true);
    equal(unlinked > 0, true); // some scorers are genuinely unlinked in the source
    equal(unlinked < total, true);
  });

  test('players: birth dates, Japanese names, and 300 KB player-file cap', async () => {
    for (const bucketFile of await readdir(join(DATA, 'p'))) {
      const bytes = (await readFile(join(DATA, 'p', bucketFile))).length;
      equal(bytes <= 300 * 1024, true, bucketFile);
    }
    const japan = JSON.parse(await readFile(join(DATA, 'japan.json'), 'utf8'));
    equal(japan.players.length, 101);
    const mitoma = japan.players.find((player) => player.en === 'Kaoru Mitoma');
    equal(mitoma.ja.mode, 'kanji');
    equal(mitoma.ja.ruby, '{三笘|みとま} {薫|かおる}');
    const brighton2223 = mitoma.seasons.find((item) => item.season === '2022–23' && item.league === 'en');
    equal(brighton2223.apps, 33); equal(brighton2223.goals, 7);
    const brighton2526 = mitoma.seasons.find((item) => item.season === '2025–26' && item.league === 'en');
    equal(brighton2526.apps, 25); equal(brighton2526.goals, 3);

    const okudera = japan.players.find((player) => player.en === 'Yasuhiko Okudera');
    equal(okudera.ja.ruby, '{奥寺|おくでら} {康彦|やすひこ}');
    const hertha2 = okudera.seasons.find((item) => item.season.includes('1980') && item.club != null && item.league === 'de' && item.apps === 25);
    equal(hertha2, undefined, '2. Bundesliga season at Hertha must be excluded');
    const koln8081 = okudera.seasons.find((item) => item.season === '1980–81' && item.league === 'de');
    equal(koln8081.apps, 1); equal(koln8081.goals, 0);

    const kamada = japan.players.find((player) => player.en === 'Daichi Kamada');
    const frankfurt = kamada.seasons.find((item) => item.season === '2022–23' && item.league === 'de');
    equal(frankfurt.apps, 32); equal(frankfurt.goals, 9, 'club-first literal table');

    const onaiwu = japan.players.find((player) => player.en === 'Ado Onaiwu');
    equal(onaiwu.ja.ruby, 'オナイウ {阿道|あど}');
    const chase = japan.players.find((player) => player.en === 'Anrie Chase');
    equal(chase.ja.mode, 'katakana'); equal(chase.ja.display, 'チェイス アンリ');
    const havenaar = japan.players.find((player) => player.en === 'Mike Havenaar');
    equal(havenaar.ja.mode, 'katakana'); equal(havenaar.ja.display, 'ハーフナー マイク');
    const fujita = japan.players.find((player) => player.en === 'Joel Chima Fujita');
    equal(fujita.ja.ruby, '{藤田|ふじた} {譲瑠|じょえる}チマ');

    const ao = japan.players.find((player) => player.id === 'Q27920148');
    deepEqual(ao.seasons.find((season) => season.season === '2025–26' && season.league === 'en'), {
      apps: 28, club: 'Q1128631', goals: 2, league: 'en', season: '2025–26', source: 'en',
    });
    const hara = japan.players.find((player) => player.id === 'Q39244620');
    deepEqual(hara.seasons.find((season) => season.season === '2025–26' && season.league === 'de'), {
      apps: 4, club: 'Q6463', goals: 0, league: 'de', season: '2025–26', source: 'en',
    });
    equal(japan.players.flatMap((player) => player.seasons).every((season) => ['ja', 'en', 'list'].includes(season.source)), true);
  });

  test('wrong-person scorer links are nulled and the curated Quaresma date is applied', async () => {
    const oldSeason = JSON.parse(await readFile(join(DATA, 's/de-2004.json'), 'utf8'));
    const quiroga = oldSeason.matches.flatMap((match) => match.scorers ? [...match.scorers.home, ...match.scorers.away] : []).find((scorer) => scorer.display === 'Quiroga');
    equal(Boolean(quiroga), true); equal(quiroga.player, null, '1788 painter link is removed');
    const futureBirth = JSON.parse(await readFile(join(DATA, 's/en-1997.json'), 'utf8'));
    const thomas = futureBirth.matches.flatMap((match) => match.scorers ? [...match.scorers.home, ...match.scorers.away] : []).find((scorer) => scorer.display === 'Thomas' && scorer.player == null);
    equal(Boolean(thomas), true, 'born-1992 same-name link is removed from 1997 scorer');
    const bucketId = String(Math.abs([...'Q188241'].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0)) % 40).padStart(2, '0');
    const bucket = JSON.parse(await readFile(join(DATA, 'p', `${bucketId}.json`), 'utf8'));
    equal(bucket.Q188241.birthDate, '1983-09-26');
  });
}
