import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeTitle } from './core-data.mjs';
import { articleJapaneseName, needsJapaneseReading, preferKatakanaOrLatin, rubyFromLead } from './japanese-names.mjs';
import { topFlightLeague, parseDomesticSeasons, parseEnglishCareerSeasons } from './japan-domestic.mjs';
import { safeName } from './source-api.mjs';
import { plainText } from './wikitext.mjs';

function cleanJaTitle(value) {
  return value?.replace(/[\s　]*[（(][^）)]*[）)]\s*$/, '').trim() ?? null;
}

function cleanEnglishTitle(value) {
  return value?.replace(/\s*\([^()]*\)\s*$/, '').trim() ?? null;
}

async function loadWikidata(cacheRoot, id, cache) {
  if (cache.has(id)) return cache.get(id);
  let entity = null;
  try { entity = JSON.parse(await readFile(join(cacheRoot, 'wikidata', `${id}.json`), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  cache.set(id, entity);
  return entity;
}

export function birthDateFromEntity(entity) {
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

function correctedBirth(id, entity, corrections) {
  const correction = corrections.find((item) => item.player === id);
  if (!correction) return birthDateFromEntity(entity);
  if (!correction.birthDate || !correction.source) throw new Error(`Birth-date correction ${id} needs birthDate and source`);
  const match = correction.birthDate.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) throw new Error(`Invalid curated birth date for ${id}: ${correction.birthDate}`);
  return { value: correction.birthDate, precision: match[3] ? 'day' : match[2] ? 'month' : 'year', year: Number(match[1]) };
}

function isFootballer(entity) {
  return (entity?.claims?.P106 ?? []).some((claim) => claim.mainsnak?.datavalue?.value?.id === 'Q937857');
}

export function scorerIdentityIssue({ entity, birth, seasonYear }) {
  if (!isFootballer(entity)) return 'not-footballer';
  if (birth?.year) {
    const age = seasonYear - birth.year;
    if (age < 15 || age > 45) return age < 15 ? 'age-under-15' : 'age-over-45';
  }
  return null;
}

/** Apply the wrong-person rule before player aggregation.  Invalid links are
 * removed from the scorer event while display text is retained. */
export async function sanitizeScorerIdentities({ seasons, cacheRoot, birthCorrections = [] }) {
  const cache = new Map();
  const nulled = [];
  for (const season of seasons) for (const match of season.matches) {
    if (!match.scorers) continue;
    for (const side of ['home', 'away']) for (const scorer of match.scorers[side]) {
      if (!scorer.player) continue;
      const id = scorer.player;
      const entity = await loadWikidata(cacheRoot, id, cache);
      const birth = correctedBirth(id, entity, birthCorrections);
      const cause = scorerIdentityIssue({ entity, birth, seasonYear: season.year });
      if (!cause) continue;
      nulled.push({ season: season.id, match: match.key, side, player: id, display: scorer.display, cause, birthDate: birth?.value ?? null });
      scorer.player = null;
    }
  }
  const remaining = [];
  for (const season of seasons) for (const match of season.matches) if (match.scorers) {
    for (const side of ['home', 'away']) for (const scorer of match.scorers[side]) if (scorer.player) {
      const entity = await loadWikidata(cacheRoot, scorer.player, cache);
      const birth = correctedBirth(scorer.player, entity, birthCorrections);
      const cause = scorerIdentityIssue({ entity, birth, seasonYear: season.year });
      if (cause) remaining.push({ season: season.id, match: match.key, player: scorer.player, cause });
    }
  }
  return { nulled, remaining };
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
export async function buildPlayers({ seasons, metadata, cacheRoot, japanesePlayers, japaneseListEntries = [], japaneseExceptions = [], japaneseClubAliases = {}, birthCorrections = [] }) {
  const cache = new Map();
  const players = new Map();
  const byJaTitle = reverseByJaTitle(metadata);
  const byWikibase = reverseByWikibase(metadata);
  const readingsMissing = [];
  const ageAnomalies = [];
  const japaneseMissingSeasons = [];
  const japaneseUnmappedClubs = [];

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
  for (const enTitle of japanesePlayers) {
    const meta = metadata.get(normalizeTitle(enTitle));
    if (!meta?.wikibaseItem || !meta.jaTitle) {
      japaneseMissingSeasons.push({ en: enTitle, reason: 'missing pinned Wikidata id or ja title' });
      continue;
    }
    const jaTitle = meta.jaTitle;
    const id = meta.wikibaseItem;
    const player = ensure(id, meta.title);
    if (!player.japan) player.japan = [];
    const file = `${safeName(jaTitle)}.json`;
    const content = JSON.parse(await readFile(join(cacheRoot, 'jawiki', file), 'utf8')).content;
    const domestic = parseDomesticSeasons(content);
    let qualifying = 0;
    for (const entry of domestic) {
      const league = topFlightLeague(entry.country, entry.league);
      if (!league) continue;
      const clubName = entry.clubTarget ?? plainText(entry.clubRaw).trim();
      const clubMeta = entry.clubTarget ? byJaTitle.get(normalizeTitle(entry.clubTarget)) : null;
      const clubId = clubMeta?.wikibaseItem ?? japaneseClubAliases[clubName] ?? null;
      if (!clubId) japaneseUnmappedClubs.push({ player: id, en: enTitle, season: entry.season, club: entry.clubTarget ?? entry.clubRaw, league });
      const seasonYear = Number(entry.season.slice(0, 4));
      const seasonId = `${league}-${seasonYear}`;
      let bucket = player.seasons.find((item) => item.league === league && item.season === seasonId && item.club === clubId);
      if (!bucket) { bucket = { league, season: seasonId, club: clubId, apps: entry.apps, goals: entry.goals, topScorerRank: null }; player.seasons.push(bucket); }
      else { bucket.apps = entry.apps; bucket.goals = Math.max(bucket.goals, entry.goals); }
      player.japan.push({ season: entry.season, league, club: clubId, apps: entry.apps, goals: entry.goals, source: 'ja' });
      qualifying += 1;
    }

    // The foreign-player list establishes that the player took part in the
    // top flight. Fill only list-confirmed, in-window gaps, preferring the
    // English career table's league columns and otherwise keeping null stats.
    const expected = japaneseListEntries.filter((entry) => entry.player === id);
    if (expected.length) {
      const enFile = `${safeName(enTitle)}.json`;
      const enContent = JSON.parse(await readFile(join(cacheRoot, 'enwiki', enFile), 'utf8')).content;
      const english = parseEnglishCareerSeasons(enContent);
      for (const listEntry of expected) {
        for (let year = 1992; year <= 2025; year += 1) {
          const listed = listEntry.years.some((range) => year >= range.start && (range.endExclusive == null || year < range.endExclusive));
          if (!listed || player.japan.some((item) => item.league === listEntry.league && Number(item.season.slice(0, 4)) === year)) continue;
          const label = `${year}\u2013${String((year + 1) % 100).padStart(2, '0')}`;
          const enRow = english.find((item) => item.league === listEntry.league && Number(item.season.slice(0, 4)) === year);
          // A list row can contain several clubs without pairing each one to
          // a season range. When enwiki has no row, only a single listed club
          // is unambiguous enough to publish.
          if (!enRow && listEntry.clubs.length !== 1) continue;
          const clubName = enRow?.clubTarget ?? (enRow ? plainText(enRow.clubRaw).trim() : null);
          const clubMeta = enRow?.clubTarget ? metadata.get(normalizeTitle(enRow.clubTarget)) : null;
          const clubId = clubMeta?.wikibaseItem ?? japaneseClubAliases[clubName] ?? (listEntry.clubs.length === 1 ? listEntry.clubs[0] : null);
          if (!clubId) japaneseUnmappedClubs.push({ player: id, en: enTitle, season: label, club: clubName, league: listEntry.league });
          const item = { season: label, league: listEntry.league, club: clubId, apps: enRow?.apps ?? null, goals: enRow?.goals ?? null, source: enRow ? 'en' : 'list' };
          player.japan.push(item);
          const seasonId = `${listEntry.league}-${year}`;
          let bucket = player.seasons.find((row) => row.league === listEntry.league && row.season === seasonId && row.club === clubId);
          if (!bucket) {
            bucket = { league: listEntry.league, season: seasonId, club: clubId, apps: item.apps, goals: item.goals, topScorerRank: null };
            player.seasons.push(bucket);
          } else {
            bucket.apps = item.apps;
            if (item.goals != null) bucket.goals = Math.max(bucket.goals ?? 0, item.goals);
          }
          qualifying += 1;
        }
      }
    }
    if (!qualifying) japaneseMissingSeasons.push({ player: id, en: enTitle, jaTitle, reason: 'no parsed top-flight season in the five leagues' });
  }

  for (const exception of japaneseExceptions) if (!exception.player || !exception.reason) throw new Error('Every Japanese-player exception needs player and reason');
  const unexceptedJapanese = japaneseMissingSeasons.filter((item) => !japaneseExceptions.some((exception) => exception.player === item.player || exception.en === item.en));
  if (unexceptedJapanese.length) throw new Error(`Japanese players without a five-league top-flight season:\n${unexceptedJapanese.map((item) => JSON.stringify(item)).join('\n')}`);
  if (japaneseUnmappedClubs.length) throw new Error(`Japanese top-flight seasons with unmapped clubs:\n${japaneseUnmappedClubs.map((item) => JSON.stringify(item)).join('\n')}`);

  // 3. Names, birth dates, sanity checks.
  for (const [id, player] of players) {
    if (!player.en) player.en = byWikibase.get(id)?.title ?? null;
    const latinName = cleanEnglishTitle(player.en);
    const entity = await loadWikidata(cacheRoot, id, cache);
    const birth = correctedBirth(id, entity, birthCorrections);
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
      if (kanjiTitle && !needsJapaneseReading(kanjiTitle)) player.ja = { mode: 'katakana', display: kanjiTitle };
      else if (kanjiTitle && ruby) player.ja = { mode: 'kanji', kanji: kanjiTitle, ruby };
      else if (kanjiTitle) { player.ja = { mode: 'kanji', kanji: kanjiTitle, ruby: null }; readingsMissing.push({ player: id, en: player.en, jaTitle: jaTitleRaw }); }
      else player.ja = { mode: 'latin', display: latinName };
    } else {
      const cleaned = cleanJaTitle(jaTitleRaw);
      const preferred = preferKatakanaOrLatin(cleaned, null, latinName);
      player.ja = { mode: preferred.source === 'latin' ? 'latin' : 'katakana', display: preferred.display };
    }
    player.en = latinName;
  }

  return { players, ageAnomalies, readingsMissing, japaneseMissingSeasons, japaneseUnmappedClubs };
}
