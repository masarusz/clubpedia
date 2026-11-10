import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeJapaneseName } from '../tools/lib/japanese-names.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'public/data');
const CACHE = join(ROOT, '.cache/sources');
const LEAGUES = ['en', 'es', 'de', 'it', 'fr'];
const load = async (path) => JSON.parse(await readFile(join(DATA, path), 'utf8'));

async function allPlayers() {
  const players = new Map();
  for (const file of (await readdir(join(DATA, 'p'))).filter((name) => name.endsWith('.json')).sort()) {
    const bucket = await load(`p/${file}`);
    for (const [id, player] of Object.entries(bucket)) players.set(id, player);
  }
  return players;
}

function isJapaneseDisplay(player) {
  return player?.ja?.mode === 'kanji' || player?.ja?.mode === 'katakana';
}

export function register(test, equal, deepEqual) {
  test('all five 2026-27 season files are pinned, partial, played-only snapshots', async () => {
    const index = await load('index.json');
    const lock = JSON.parse(await readFile(join(ROOT, 'tools/sources.lock.json'), 'utf8'));
    const current = index.seasons.filter((season) => season.inProgress === true);
    equal(current.length, 5, 'in-progress season count');
    deepEqual(current.map((season) => season.id).sort(), LEAGUES.map((league) => `${league}-2026`).sort());

    for (const summary of current) {
      const season = await load(`s/${summary.id}.json`);
      const pinnedDate = lock.seasons[summary.id].articleTimestamp.slice(0, 10);
      equal(season.inProgress, true, `${summary.id} inProgress`);
      equal(season.asOf, pinnedDate, `${summary.id} pinned asOf`);
      equal(summary.asOf, pinnedDate, `${summary.id} index asOf`);
      equal(season.champion, null, `${summary.id} champion`);
      equal(summary.champion, null, `${summary.id} index champion`);
      equal(season.matches.every((match) => Number.isInteger(match.homeGoals) && Number.isInteger(match.awayGoals)), true, `${summary.id} played scores`);

      const gridPlayed = new Map();
      for (const match of season.matches) {
        gridPlayed.set(match.home, (gridPlayed.get(match.home) ?? 0) + 1);
        gridPlayed.set(match.away, (gridPlayed.get(match.away) ?? 0) + 1);
      }
      equal(season.table.length, gridPlayed.size, `${summary.id} table/grid club count`);
      equal(season.matches.length < season.table.length * (season.table.length - 1), true, `${summary.id} is not complete`);
      for (const row of season.table) {
        const tablePlayed = row.w + row.d + row.l;
        equal(gridPlayed.has(row.club), true, `${summary.id} ${row.club} occurs in grid`);
        equal(tablePlayed <= gridPlayed.get(row.club), true, `${summary.id} ${row.club} table does not lead grid`);
      }
    }
  });

  test('index keeps latest champions on the five completed 2025-26 seasons', async () => {
    const index = await load('index.json');
    for (const league of index.leagues) {
      const current = index.seasons.find((season) => season.id === `${league.id}-2026`);
      const completed = index.seasons.find((season) => season.id === `${league.id}-2025`);
      equal(current?.inProgress, true, `${league.id} current marker`);
      equal(league.latest.season, '2025–26', `${league.id} latest champion season`);
      equal(league.latest.champion.id, completed.champion, `${league.id} latest champion id`);
    }
  });

  test('all-time histories, rankings, and club titles exclude in-progress seasons', async () => {
    const index = await load('index.json');
    const inProgressIds = new Set(index.seasons.filter((season) => season.inProgress === true).map((season) => season.id));
    const completed = await Promise.all(index.seasons.filter((season) => season.inProgress !== true).map((season) => load(`s/${season.id}.json`)));
    const players = await allPlayers();
    const clubs = new Map();
    for (const file of (await readdir(join(DATA, 'c'))).filter((name) => name.endsWith('.json')).sort()) {
      const club = await load(`c/${file}`); clubs.set(club.id, club);
      equal(club.championSeasons.every((title) => !title.season.startsWith('2026')), true, `${club.id} title seasons`);
      equal(club.titleCount, club.championSeasons.length, `${club.id} title count`);
    }
    for (const league of LEAGUES) {
      const history = await load(`h/${league}.json`);
      equal(history.champions.every((item) => !item.season.startsWith('2026')), true, `${league} champion history`);
      equal(history.topScorers.every((item) => !item.season.startsWith('2026')), true, `${league} scorer history`);
    }

    const rankings = await load('rankings.json');
    for (const row of rankings.clubs.seasonPoints) equal(inProgressIds.has(row.season), false, `${row.club} season-points season`);
    for (const row of rankings.clubs.wins) {
      const expected = completed.reduce((total, season) => total + (season.table.find((item) => item.club === row.club)?.w ?? 0), 0);
      equal(row.value, expected, `${row.club} completed wins`);
    }
    for (const row of rankings.clubs.titles) equal(row.value, clubs.get(row.club).titleCount, `${row.club} completed titles`);
    for (const row of rankings.players.goals) {
      const expected = players.get(row.player).seasons.filter((season) => !inProgressIds.has(season.season))
        .reduce((total, season) => total + season.recordedGoals, 0);
      equal(row.value, expected, `${row.player} completed recorded goals`);
    }
    for (const row of rankings.players.topScorers) {
      const expected = players.get(row.player).seasons.filter((season) => !inProgressIds.has(season.season) && season.topScorerRank === 1).length;
      equal(row.value, expected, `${row.player} completed top-scorer awards`);
    }
  });

  test('Wikidata-label displays exactly match cached katakana labels and respect one-word Latin names', async () => {
    const players = await allPlayers();
    // This is a floor because Wikidata gains labels over time.
    const WIKIDATA_LABEL_FLOOR = 719;
    let wikidataLabels = 0; let oneWordLatin = 0;
    for (const player of players.values()) {
      if (player.ja?.source === 'wikidata-label') {
        const entity = JSON.parse(await readFile(join(CACHE, 'wikidata', `${player.id}.json`), 'utf8'));
        const label = entity.labels?.ja?.value;
        equal(player.ja.display, normalizeJapaneseName(label), `${player.id} cached Wikidata label`);
        equal(/^[ァ-ヺー＝\s]+$/u.test(player.ja.display), true, `${player.id} katakana-only display`);
        equal(!(player.en.trim().split(/\s+/u).length === 1 && player.ja.display.split(/\s+/u).length > 1), true, `${player.id} one-word Latin rule`);
        wikidataLabels += 1;
      }
      if (player.ja?.source === 'latin-one-word') {
        equal(player.ja.display, player.en, `${player.id} preserves Latin display`);
        equal(player.en.trim().split(/\s+/u).length, 1, `${player.id} one-word Latin source`);
        oneWordLatin += 1;
      }
    }
    equal(wikidataLabels >= WIKIDATA_LABEL_FLOOR, true, `Wikidata-label count ${wikidataLabels} below floor`);
    equal(oneWordLatin > 0, true, 'one-word Latin cases exercised');
  });

  test('today birthdays contain only Japanese displays, cap at 12, and exhaust Japanese candidates first', async () => {
    const players = await allPlayers();
    const japaneseByDay = new Map();
    for (const player of players.values()) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(player.birthDate ?? '') || !isJapaneseDisplay(player)) continue;
      const day = player.birthDate.slice(5);
      if (!japaneseByDay.has(day)) japaneseByDay.set(day, new Set());
      japaneseByDay.get(day).add(player.id);
    }
    for (const file of (await readdir(join(DATA, 'days'))).filter((name) => name.endsWith('.json')).sort()) {
      const dayKey = file.slice(0, -5); const day = await load(`days/${file}`);
      const eligible = japaneseByDay.get(dayKey) ?? new Set();
      equal(day.birthdays.length, Math.min(12, eligible.size), `${dayKey} Japanese birthday count`);
      equal(day.birthdays.length <= 12, true, `${dayKey} birthday cap`);
      for (const birthday of day.birthdays) {
        equal(eligible.has(birthday.id), true, `${dayKey} ${birthday.id} Japanese display`);
        equal(/^[\p{Script=Latin}\p{Number}\s.'’\-]+$/u.test(birthday.name), false, `${dayKey} ${birthday.id} is not Latin-only`);
      }
    }
  });
}
