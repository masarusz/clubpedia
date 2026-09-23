#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { stableJson } from './lib/source-api.mjs';
import { LEAGUE_INFO, allHistoryTopScorers, applyReviewedCorrection, discrepancies, matchOutcome, metadataIndex, parseChampions, parseSeason, proposeCorrection, readCached, seasonTopScorers } from './lib/core-data.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CACHE = join(ROOT, '.cache/sources');
const OUTPUT = join(ROOT, 'public/data');
const REPORTS = join(ROOT, 'reports');
const allowProposed = process.argv.includes('--allow-proposed');
const allowMissingNames = process.argv.includes('--allow-missing-names') || allowProposed;

async function maybeJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function cleanJaTitle(value) { return value?.replace(/[\s　]*[\uff08(][^\uff09)]*[\uff09)]\s*$/, '').trim() ?? null; }

function crossName(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(?:afc|cf|fc|cfc|sc)\b/g, '').replace(/[^a-z0-9]/g, '');
}

function successorClub(start, curated) {
  let current = start;
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    const successor = (curated[current]?.lineage ?? []).find((entry) => entry.relation === 'successor')?.club;
    if (!successor) return current;
    current = successor;
  }
  throw new Error(`Club lineage cycle: ${[...seen, current].join(' -> ')}`);
}

function proposedLineages(entry) {
  if (!entry?.proposedLineage) return [];
  return Array.isArray(entry.proposedLineage) ? entry.proposedLineage : [entry.proposedLineage];
}

function groupCountMismatches(mismatches, exceptions, curated) {
  if (!Array.isArray(exceptions)) throw new Error('curated/champion-count-exceptions.json must be an array');
  for (const exception of exceptions) if (!exception.reason) throw new Error('Every champion-count exception needs a reason');
  const groups = { exception: [], 'proposed-lineage': [], unexplained: [] };
  for (const mismatch of mismatches) {
    const exception = exceptions.find((item) => item.league === mismatch.league
      && (item.club === mismatch.club || item.club === mismatch.canonicalClub)
      && (item.season == null || item.season === mismatch.season)
      && (item.printed == null || item.printed === mismatch.printed)
      && (item.computed == null || item.computed === mismatch.computed)
      && (item.offset == null || item.offset === mismatch.printed - mismatch.computed));
    if (exception) groups.exception.push({ ...mismatch, reason: exception.reason });
    else {
      const proposal = Object.entries(curated).find(([id, entry]) => proposedLineages(entry).length
        && (id === mismatch.club || proposedLineages(entry).some((link) => link.club === mismatch.club || link.club === mismatch.canonicalClub)));
      if (proposal) groups['proposed-lineage'].push({ ...mismatch, proposedBy: proposal[0] });
      else groups.unexplained.push(mismatch);
    }
  }
  return groups;
}

async function addOpenfootballCrossCheck(correction, season) {
  if (season.year < 2010 || season.year > 2023) return { ...correction, crossCheck: { source: 'openfootball', available: false, reason: 'outside pinned comparison window' } };
  const leagueFile = { en: 'en.1.json', es: 'es.1.json', de: 'de.1.json', it: 'it.1.json', fr: 'fr.1.json' }[season.league];
  const roots = (await readdir(join(CACHE, 'openfootball'))).sort();
  const label = `${season.year}-${String(season.year + 1).slice(-2)}`;
  const path = join(CACHE, 'openfootball', roots[0], label, leagueFile);
  let source;
  try { source = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { ...correction, crossCheck: { source: 'openfootball', available: false, reason: 'file absent from pinned cache' } };
    throw error;
  }
  const title = new Map(season.table.map((row) => [row.club, row.sourceTitle]));
  const matches = (correction.changes ?? []).map((change) => {
    const home = crossName(title.get(change.home)); const away = crossName(title.get(change.away));
    const found = source.matches.find((match) => crossName(match.team1) === home && crossName(match.team2) === away);
    return { match: change.match, score: found?.score?.ft ? `${found.score.ft[0]}–${found.score.ft[1]}` : null };
  });
  return { ...correction, crossCheck: { source: 'openfootball', available: true, matches } };
}

export async function build() {
  const started = performance.now();
  const lock = JSON.parse(await readFile(join(ROOT, 'tools/sources.lock.json'), 'utf8'));
  const metadata = await metadataIndex(CACHE);
  const previousClubs = await maybeJson(join(ROOT, 'curated/clubs.json'), {});
  const previousCorrections = await maybeJson(join(ROOT, 'curated/results-corrections.json'), []);
  const countExceptions = await maybeJson(join(ROOT, 'curated/champion-count-exceptions.json'), []);
  const correctionBySeason = new Map(previousCorrections.map((entry) => [entry.season, entry]));
  const seasons = [];
  const clubs = new Map();
  const unknownLines = [];
  const missingScorers = [];
  const unresolvedScorerClubs = [];
  const revisionParts = [];

  for (const id of Object.keys(lock.seasons).sort()) {
    const [league, yearText] = id.split('-'); const year = Number(yearText);
    const record = lock.seasons[id];
    const article = await readCached(CACHE, 'enwiki', record.articleTitle);
    const sources = [article];
    for (const title of record.templateTitles ?? []) sources.push(await readCached(CACHE, 'enwiki', title));
    const season = parseSeason({ league, year, sources, metadata });
    season.topScorers = seasonTopScorers(article.content, metadata, season, unresolvedScorerClubs);
    if (!season.topScorers.length) missingScorers.push(id);
    for (const source of sources) revisionParts.push(`${source.title}:${source.revid}`);
    for (const row of season.table) {
      const meta = metadata.get(row.sourceTitle);
      const existing = previousClubs[row.club] ?? {};
      const entry = clubs.get(row.club) ?? { ...existing, enTitle: meta?.title ?? row.sourceTitle, jaName: existing.jaName ?? cleanJaTitle(meta?.jaTitle), needsName: false, lineage: existing.lineage ?? [], sourceNames: [], seasons: [] };
      if (!entry.jaName) entry.needsName = true;
      if (!entry.sourceNames.includes(row.sourceName)) entry.sourceNames.push(row.sourceName);
      entry.seasons.push(id); clubs.set(row.club, entry);
    }
    for (const name of season.unknownTableParameters) unknownLines.push(`${id}: ${name}`);
    seasons.push(season);
  }

  const championsByLeague = {};
  const historicalTopScorers = {};
  const countMismatches = [];
  const unresolvedChampions = [];
  for (const league of Object.keys(LEAGUE_INFO)) {
    const info = LEAGUE_INFO[league];
    const page = await readCached(CACHE, 'enwiki', info.championList);
    revisionParts.push(`${page.title}:${page.revid}`);
    const champions = parseChampions(page.content, league, metadata);
    for (const entry of champions) if (entry.unresolvedTarget) unresolvedChampions.push({ league, season: entry.season, target: entry.unresolvedTarget });
    championsByLeague[league] = champions;
    const counts = new Map();
    for (const champion of champions) if (champion.champion) {
      const canonical = successorClub(champion.champion, previousClubs);
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
      if (champion.printedCount != null && champion.printedCount !== counts.get(canonical)) {
        countMismatches.push({ league, season: champion.season, club: champion.champion, canonicalClub: canonical, printed: champion.printedCount, computed: counts.get(canonical) });
      }
      if (!clubs.has(champion.champion)) {
        const meta = [...metadata.values()].find((item) => item.wikibaseItem === champion.champion);
        const existing = previousClubs[champion.champion] ?? {};
        clubs.set(champion.champion, { ...existing, enTitle: meta?.title ?? champion.sourceTitle, jaName: existing.jaName ?? cleanJaTitle(meta?.jaTitle), needsName: !(existing.jaName ?? meta?.jaTitle), lineage: existing.lineage ?? [], sourceNames: [champion.sourceTitle], seasons: [] });
      }
    }
    const scorerPage = await readCached(CACHE, 'enwiki', info.scorerList);
    revisionParts.push(`${scorerPage.title}:${scorerPage.revid}`);
    historicalTopScorers[league] = allHistoryTopScorers(scorerPage.content, league);
    if (!historicalTopScorers[league].length && league === 'de') historicalTopScorers[league] = allHistoryTopScorers(page.content, league);
  }

  for (const season of seasons) {
    const champion = championsByLeague[season.league].find((entry) => Number(entry.season.slice(0, 4)) === season.year);
    season.champion = champion?.champion ?? null;
  }

  const proposed = [];
  const invalidReviewed = [];
  const disagreementLines = [];
  for (const season of seasons) {
    const rawDifferences = discrepancies(season);
    const correction = correctionBySeason.get(season.id);
    if (correction?.status === 'reviewed') {
      const { differences, unexpected, overbroad } = applyReviewedCorrection(season, correction, { strictExact: !allowProposed });
      if (unexpected.length || overbroad.length) invalidReviewed.push({ season: season.id, unexpected, overbroad });
      const suffix = differences.length ? `unreconciled: ${differences.map((item) => `${item.sourceTitle} ${JSON.stringify(item.delta)}`).join('; ')}` : 'reconciled';
      disagreementLines.push(`${season.id}: reviewed ${correction.actions.map((action) => action.type).join(', ')}; ${suffix}`);
    } else if (rawDifferences.length) {
      let draft = correction ?? { season: season.id, differences: rawDifferences, ...proposeCorrection(season, rawDifferences) };
      draft = await addOpenfootballCrossCheck(draft, season);
      proposed.push(draft);
      const changes = draft.changes?.map((change) => `${change.match} ${change.grid}->${change.proposed}`).join(', ') || 'manual review';
      disagreementLines.push(`${season.id}: UNREVIEWED ${rawDifferences.map((item) => `${item.sourceTitle} ${JSON.stringify(item.delta)}`).join('; ')}; ${changes}`);
    }
  }

  const clubObject = Object.fromEntries([...clubs].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, { ...entry, sourceNames: [...new Set(entry.sourceNames)].sort(), seasons: [...new Set(entry.seasons)].sort() }]));
  await mkdir(join(ROOT, 'curated'), { recursive: true });
  await writeFile(join(ROOT, 'curated/clubs.json'), stableJson(clubObject));
  await mkdir(REPORTS, { recursive: true });
  await writeFile(join(REPORTS, 'tables.txt'), `${unknownLines.join('\n')}\n`);
  await writeFile(join(REPORTS, 'disagreements.txt'), `${disagreementLines.join('\n')}\n`);
  const mismatchGroups = groupCountMismatches(countMismatches, countExceptions, previousClubs);
  await writeFile(join(REPORTS, 'champions.txt'), `${Object.entries(championsByLeague).map(([league, entries]) => `${league}: ${entries.at(0)?.season ?? '-'}..${entries.at(-1)?.season ?? '-'} (${entries.length})`).join('\n')}\n\nunresolved champion identities\n${unresolvedChampions.map((item) => JSON.stringify(item)).join('\n')}\n\nrunning-count mismatches by cause\n${Object.entries(mismatchGroups).map(([cause, entries]) => `${cause} (${entries.length})\n${entries.map((item) => JSON.stringify(item)).join('\n')}`).join('\n')}\n`);
  await writeFile(join(REPORTS, 'top-scorers.txt'), `Missing per-season tables (${missingScorers.length}): ${missingScorers.join(', ')}\n${Object.entries(historicalTopScorers).map(([league, entries]) => `${league}: ${entries.length}`).join('\n')}\n\nUnresolved per-season club cells (${unresolvedScorerClubs.length})\n${unresolvedScorerClubs.map((item) => JSON.stringify(item)).join('\n')}\n`);

  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(join(OUTPUT, 's'), { recursive: true }); await mkdir(join(OUTPUT, 'c'), { recursive: true }); await mkdir(join(OUTPUT, 'h'), { recursive: true });
  const fingerprint = createHash('sha256').update(revisionParts.sort().join('\n')).digest('hex');
  const compactSeasons = [];
  for (const season of seasons) {
    const output = { id: season.id, league: season.league, year: season.year, champion: season.champion, table: season.table.map(({ code, sourceName, ...row }) => row), matches: season.matches.map(({ gridValue, ...match }) => match), topScorers: season.topScorers };
    await writeFile(join(OUTPUT, 's', `${season.id}.json`), stableJson(output));
    compactSeasons.push({ id: season.id, label: `${season.year}–${String(season.year + 1).slice(-2)}`, champion: season.champion, topScorers: season.topScorers.filter((entry) => entry.rank === 1).map((entry) => ({ player: entry.player, goals: entry.goals })) });
  }

  const clubData = new Map([...clubs].map(([id, names]) => [id, { id, names: { en: names.enTitle, ja: names.jaName }, championSeasons: [], positions: [], headToHead: {} }]));
  for (const [league, champions] of Object.entries(championsByLeague)) for (const item of champions) if (item.champion) {
    const canonical = successorClub(item.champion, previousClubs);
    if (clubData.has(canonical)) clubData.get(canonical).championSeasons.push({ league, season: item.season, ...(canonical !== item.champion ? { predecessor: item.champion } : {}) });
  }
  for (const season of seasons) {
    for (const row of season.table) clubData.get(row.club).positions.push({ season: season.id, position: row.position });
    for (const match of season.matches) for (const homeSide of [true, false]) {
      const club = homeSide ? match.home : match.away; const opponent = homeSide ? match.away : match.home;
      const gf = homeSide ? match.homeGoals : match.awayGoals; const ga = homeSide ? match.awayGoals : match.homeGoals;
      const h2h = clubData.get(club).headToHead[opponent] ?? { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, matches: [] };
      h2h.p += 1; h2h.gf += gf; h2h.ga += ga; h2h.matches.push(match.key);
      const result = matchOutcome(match)[homeSide ? 'home' : 'away'];
      h2h.w += result.w; h2h.d += result.d; h2h.l += result.l;
      clubData.get(club).headToHead[opponent] = h2h;
    }
  }
  for (const [id, data] of clubData) await writeFile(join(OUTPUT, 'c', `${id}.json`), stableJson(data));
  for (const league of Object.keys(LEAGUE_INFO)) {
    await writeFile(join(OUTPUT, 'h', `${league}.json`), stableJson({ league, fingerprint, champions: championsByLeague[league], topScorers: historicalTopScorers[league] }));
  }
  const index = { fingerprint, leagues: Object.entries(LEAGUE_INFO).map(([id, info]) => ({ id, name: info.name })), seasons: compactSeasons };
  const indexPath = join(OUTPUT, 'index.json');
  await writeFile(indexPath, stableJson(index));
  const indexBytes = (await stat(indexPath)).size;

  const missingNames = Object.entries(clubObject).filter(([, entry]) => !entry.jaName).map(([id, entry]) => `${id} ${entry.enTitle}`);
  const elapsed = performance.now() - started;
  console.log(`Built ${seasons.length} league-seasons, ${seasons.reduce((sum, season) => sum + season.matches.length, 0)} matches, ${clubs.size} clubs in ${(elapsed / 1000).toFixed(2)}s`);
  console.log(`Reviewed corrections: ${previousCorrections.length}; invalid reviewed scopes: ${invalidReviewed.length}; unreviewed disagreements: ${proposed.length}; unresolved scorer clubs: ${unresolvedScorerClubs.length}`);
  console.log(`Historical identities missing: ${unresolvedChampions.length}; running-count mismatches: ${countMismatches.length} (${mismatchGroups.unexplained.length} unexplained)`);
  console.log(`Missing Japanese names: ${missingNames.length}; unknown table parameters: ${unknownLines.length}; index.json: ${indexBytes} bytes`);
  if (missingNames.length && !allowMissingNames) throw new Error(`Missing Japanese club names:\n${missingNames.join('\n')}`);
  if (unresolvedChampions.length && !allowProposed) throw new Error(`${unresolvedChampions.length} historical champions lack pinned identity metadata`);
  if (proposed.length && !allowProposed) throw new Error(`${proposed.length} results corrections await review; rerun with --allow-proposed to inspect output`);
  if (mismatchGroups.unexplained.length && !allowProposed) throw new Error(`${mismatchGroups.unexplained.length} champion running-count mismatches lack a curated explanation`);
  if (indexBytes > 40 * 1024) throw new Error(`index.json is ${indexBytes} bytes; limit is 40960`);
  return { seasons, championsByLeague, clubs: clubObject, corrections: previousCorrections, invalidReviewed, countMismatches, mismatchGroups, unresolvedChampions, unresolvedScorerClubs, missingNames, unknownLines, indexBytes, elapsed };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) build().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
