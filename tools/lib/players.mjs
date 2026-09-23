import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeTitle } from './core-data.mjs';
import { articleJapaneseName, preferKatakanaOrLatin, rubyFromLead } from './japanese-names.mjs';
import { topFlightLeague, parseDomesticSeasons } from './japan-domestic.mjs';
import { safeName } from './source-api.mjs';

function cleanJaTitle(value) {
  return value?.replace(/[\s　]*[（(][^）)]*[）)]\s*$/, '').trim() ?? null;
}

async function loadWikidata(cacheRoot, id, cache) {
  if (cache.has(id)) return cache.get(id);
  let entity = null;
  try { entity = JSON.parse(await readFile(join(cacheRoot, 'wikidata', `${id}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  cache.set(id, entity);
  return entity;
}

function birthDateFromEntity(entity) {
  const claim = entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value;
  if (!claim) return null;
  const match = claim.time?.match(/^([+-]\d{4,})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  // precision 9 = year only, 10 = month, 11 = day (Wikidata time precision)
  if (claim.precision <= 9) return { value: `${String(year).padStart(4, '0')}`, precision: 'year', year };
  if (claim.precision === 10) return { value: `${String(year).padStart(4, '0')}-${match[2]}`, precision: 'month', year };
  return { value: `${String(year).padStart(4, '0')}-${match[2]}-${match[3]}`, precision: 'day', year };
}

function isJapaneseNational(entity) {
  return (entity?.claims?.P27 ?? []).some((claim) => claim.mainsnak?.datavalue?.value?.id === 'Q17');
}

/** id -> {enTitle, wikibaseItem, jaTitle} reverse index built from the
 * (title/redirect keyed) enwiki metadata index. */
function reverseByJaTitle(metadata) {
  const seen = new Map();
  for (const entry of metadata.values()) {
    if (entry.jaTitle) seen.set(normalizeTitle(entry.jaTitle), entry);
  }
  return seen;
}

function reverseByWikibase(metadata) {
  const seen = new Map();
  for (const entry of metadata.values()) if (entry.wikibaseItem && !seen.has(entry.wikibaseItem)) seen.set(entry.wikibaseItem, entry);
  return seen;
}

/**
 * Build one record per Wikidata id for every player who scored a reconciled
 * league goal, appears in a top-scorer table, or is one of the 101 Japanese
 * players (jawiki 個人成績). Never keyed by name + birth date.
 */
export async function buildPlayers({ seasons, metadata, cacheRoot, japaneseFiles }) {
  const cache = new Map();
  const players = new Map();
  const byJaTitle = reverseByJaTitle(metadata);
  const byWikibase = reverseByWikibase(metadata);
  const readingsMissing = [];
  const ageAnomalies = [];

  function ensure(id, enTitle) {
    let player = players.get(id);
    if (!player) {
      player = { id, en: enTitle ?? null, seasons: [], japan: null, ja: null };
      players.set(id, player);
    } else if (!player.en && enTitle) player.en = enTitle;
    return player;
  }

  // 1. Reconciled scorer goals, grouped per player per league-season-club.
  for (const season of seasons) {
    for (const match of season.matches) {
      if (!match.scorers) continue;
      for (const side of ['home', 'away']) {
        const club = side === 'home' ? match.home : match.away;
        for (const scorer of match.scorers[side]) {
          if (!scorer.player || scorer.ownGoal) continue;
          const player = ensure(scorer.player, null);
          let bucket = player.seasons.find((item) => item.league === season.league && item.season === season.id && item.club === club);
          if (!bucket) { bucket = { league: season.league, season: season.id, club, goals: 0, topScorerRank: null }; player.seasons.push(bucket); }
          bucket.goals += 1;
        }
      }
    }
    for (const entry of season.topScorers) {
      if (!entry.playerId) continue;
      const player = ensure(entry.playerId, null);
      let bucket = player.seasons.find((item) => item.league === season.league && item.season === season.id && item.club === entry.club);
      if (!bucket) { bucket = { league: season.league, season: season.id, club: entry.club, goals: entry.goals, topScorerRank: entry.rank }; player.seasons.push(bucket); }
      else { bucket.topScorerRank = bucket.topScorerRank == null ? entry.rank : Math.min(bucket.topScorerRank, entry.rank); bucket.goals = Math.max(bucket.goals, entry.goals); }
    }
  }

  // 2. The 101 Japanese players (all eras): jawiki 個人成績 domestic tables.
  for (const file of japaneseFiles) {
    const jaTitle = decodeURIComponent(file.replace(/\.json$/, ''));
    const meta = byJaTitle.get(normalizeTitle(jaTitle));
    if (!meta?.wikibaseItem) continue;
    const id = meta.wikibaseItem;
    const player = ensure(id, meta.title);
    const content = JSON.parse(await readFile(join(cacheRoot, 'jawiki', file), 'utf8')).content;
    const domestic = parseDomesticSeasons(content);
    const clubByJaName = new Map();
    for (const entry of domestic) {
      const league = topFlightLeague(entry.country, entry.league);
      if (!league) continue;
      const clubMeta = entry.clubTarget ? byJaTitle.get(normalizeTitle(entry.clubTarget)) : null;
      const clubId = clubMeta?.wikibaseItem ?? null;
      if (clubId) clubByJaName.set(entry.clubTarget, clubId);
      const seasonYear = Number(entry.season.slice(0, 4));
      const seasonId = `${league}-${seasonYear}`;
      let bucket = player.seasons.find((item) => item.league === league && item.season === seasonId && item.club === clubId);
      if (!bucket) { bucket = { league, season: seasonId, club: clubId, goals: entry.goals, topScorerRank: null }; player.seasons.push(bucket); }
      if (!player.japan) player.japan = [];
      player.japan.push({ season: entry.season, league, club: clubId, apps: entry.apps, goals: entry.goals });
    }
  }

  // 3. Names, birth dates, sanity checks.
  for (const [id, player] of players) {
    if (!player.en) player.en = byWikibase.get(id)?.title ?? null;
    const entity = await loadWikidata(cacheRoot, id, cache);
    const birth = birthDateFromEntity(entity);
    player.birthDate = birth?.value ?? null;
    for (const season of player.seasons) {
      if (birth?.year && season.goals > 0) {
        const seasonYear = Number(season.season.split('-')[1]);
        const age = seasonYear - birth.year;
        if (age < 15 || age > 45) ageAnomalies.push({ player: id, en: player.en, season: season.season, age, birthYear: birth.year });
      }
    }
    const japanese = isJapaneseNational(entity);
    const jaMeta = metadata.get(normalizeTitle(player.en ?? ''));
    const jaTitleRaw = jaMeta?.jaTitle ?? null;
    if (japanese) {
      const jaFile = jaTitleRaw ? `${safeName(jaTitleRaw)}.json` : null;
      let content = null;
      if (jaFile) { try { content = JSON.parse(await readFile(join(cacheRoot, 'jawiki', jaFile), 'utf8')).content; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      const kanjiTitle = articleJapaneseName(jaTitleRaw, birth?.year).name;
      const ruby = content ? rubyFromLead(content, kanjiTitle ?? jaTitleRaw) : null;
      if (kanjiTitle && ruby) player.ja = { mode: 'kanji', kanji: kanjiTitle, ruby };
      else if (kanjiTitle) { player.ja = { mode: 'kanji', kanji: kanjiTitle, ruby: null }; readingsMissing.push({ player: id, en: player.en, jaTitle: jaTitleRaw }); }
      else player.ja = { mode: 'latin', display: player.en };
    } else {
      const cleaned = cleanJaTitle(jaTitleRaw);
      const preferred = preferKatakanaOrLatin(cleaned, null, player.en);
      player.ja = { mode: preferred.source === 'latin' ? 'latin' : 'katakana', display: preferred.display };
    }
  }

  return { players, ageAnomalies, readingsMissing };
}
