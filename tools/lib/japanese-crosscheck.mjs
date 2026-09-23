import { extractLinks, plainText, sectionRanges } from './wikitext.mjs';
import { normalizeTitle, readCached } from './core-data.mjs';

function leagueForList(title) {
  if (title === 'List of foreign Premier League players') return 'en';
  if (title === 'List of foreign La Liga players') return 'es';
  if (title === 'List of foreign Bundesliga players') return 'de';
  if (title === 'List of foreign Serie A players') return 'it';
  if (/^List of foreign Ligue 1 players(?::|$)/.test(title)) return 'fr';
  return null;
}

function japaneseSections(content) {
  return sectionRanges(content).filter((section) => /^Japan(?:ese)?$/i.test(plainText(section.title).replace(/\s+/g, ' ').trim()));
}

function yearRanges(text) {
  text = text.replace(/&(?:ndash|mdash);/gi, '–');
  const output = [];
  for (const match of text.matchAll(/((?:19|20)\d{2})\s*[–-]\s*((?:19|20)?\d{2})?/g)) {
    const start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : null;
    if (end != null && end < 100) {
      end += Math.floor(start / 100) * 100;
      if (end <= start) end += 100;
    }
    // The printed end is the ending calendar year: 2023–24 means start-year
    // 2023 only, while an open range includes every later season.
    output.push({ start, endExclusive: end ?? null });
  }
  return output;
}

function rows(section) {
  const bullet = section.content.split('\n').filter((line) => /^\s*\*/.test(line));
  if (bullet.length) return bullet;
  return section.content.split(/\n\s*\|-/).filter((row) => /\[\[/.test(row));
}

export async function foreignListEntries({ lock, metadata, cacheRoot }) {
  const entries = [];
  for (const [title, record] of Object.entries(lock.enwiki).sort(([a], [b]) => a.localeCompare(b))) {
    const league = leagueForList(title);
    if (!league || record.missing) continue;
    const page = await readCached(cacheRoot, 'enwiki', title);
    for (const section of japaneseSections(page.content)) for (const row of rows(section)) {
      const links = extractLinks(row).filter((link) => !/^(?:File|Image):/i.test(link.target));
      if (!links.length) continue;
      const playerMeta = metadata.get(normalizeTitle(links[0].target));
      if (!playerMeta?.wikibaseItem) continue;
      const clubLinks = links.slice(1);
      const clubs = clubLinks.map((link) => metadata.get(normalizeTitle(link.target))?.wikibaseItem).filter(Boolean);
      const unmappedClubs = clubLinks.filter((link) => !metadata.get(normalizeTitle(link.target))?.wikibaseItem).map((link) => link.target);
      entries.push({ league, player: playerMeta.wikibaseItem, en: links[0].target, clubs: [...new Set(clubs)], unmappedClubs, years: yearRanges(plainText(row)), source: title });
    }
  }
  return entries;
}

function inRanges(year, ranges) {
  return ranges.some((range) => year >= range.start && (range.endExclusive == null || year < range.endExclusive));
}

export function crossCheckJapanesePlayers(players, entries) {
  const disagreements = [];
  for (const expected of entries) {
    const player = players.get(expected.player);
    const actual = (player?.japan ?? []).filter((item) => item.league === expected.league && item.apps > 0);
    if (!actual.length) {
      disagreements.push({ player: expected.player, en: expected.en, league: expected.league, cause: 'no-parsed-seasons', source: expected.source });
      continue;
    }
    for (const item of actual) {
      const year = Number(item.season.slice(0, 4));
      if (expected.years.length && !inRanges(year, expected.years)) disagreements.push({ player: expected.player, en: expected.en, league: expected.league, cause: 'season-not-in-list-range', season: item.season, source: expected.source });
      if (!expected.unmappedClubs.length && expected.clubs.length && item.club && !expected.clubs.includes(item.club)) disagreements.push({ player: expected.player, en: expected.en, league: expected.league, cause: 'club-not-in-list-entry', season: item.season, club: item.club, expectedClubs: expected.clubs, source: expected.source });
    }
  }
  return disagreements;
}
