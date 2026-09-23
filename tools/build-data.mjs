#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { stableJson } from './lib/source-api.mjs';
import { LEAGUE_INFO, allHistoryTopScorers, applyReviewedCorrection, discrepancies, matchOutcome, metadataIndex, normalizeTitle, parseChampions, parseSeason, proposeCorrection, readCached, seasonTopScorers } from './lib/core-data.mjs';
import { attachScorers } from './lib/build-scorers.mjs';
import { linkPlayerName, reconciledGoals } from './lib/openligadb.mjs';
import { buildPlayers, sanitizeScorerIdentities } from './lib/players.mjs';
import { crossCheckJapanesePlayers, foreignListEntries } from './lib/japanese-crosscheck.mjs';

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
  const birthCorrections = await maybeJson(join(ROOT, 'curated/birth-date-corrections.json'), []);
  const japaneseExceptions = await maybeJson(join(ROOT, 'curated/japanese-player-exceptions.json'), []);
  const japaneseClubAliases = await maybeJson(join(ROOT, 'curated/japanese-club-aliases.json'), {});
  const correctionBySeason = new Map(previousCorrections.map((entry) => [entry.season, entry]));
  const seasons = [];
  const clubs = new Map();
  const unknownLines = [];
  const missingScorers = [];
  const unresolvedScorerClubs = [];
  const revisionParts = [];
  const scorerOverrides = await maybeJson(join(ROOT, 'curated/scorer-overrides.json'), []);
  const unresolvedScorers = { conflicts: [], unlinked: 0 };
  const scorerCoverage = [];

  for (const id of Object.keys(lock.seasons).sort()) {
    const [league, yearText] = id.split('-'); const year = Number(yearText);
    const record = lock.seasons[id];
    const article = await readCached(CACHE, 'enwiki', record.articleTitle);
    const sources = [article];
    for (const title of record.templateTitles ?? []) sources.push(await readCached(CACHE, 'enwiki', title));
    const season = parseSeason({ league, year, sources, metadata });
    season.topScorers = seasonTopScorers(article.content, metadata, season, unresolvedScorerClubs);
    for (const entry of season.topScorers) {
      const meta = metadata.get(normalizeTitle(entry.player));
      entry.playerId = meta?.wikibaseItem ?? null;
    }
    if (!season.topScorers.length) missingScorers.push(id);
    const coverage = await attachScorers({ season, lock, metadata, readCached, cacheRoot: CACHE, unresolvedScorers, overrides: scorerOverrides });
    scorerCoverage.push({ id, ...coverage });
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

  // Apply the match-box wrong-person rule before scorer events feed player
  // totals. The second pass in the sanitizer is the strict age/occupation
  // gate: an invalid id may be reported only after it has been nulled.
  const scorerIdentity = await sanitizeScorerIdentities({ seasons, cacheRoot: CACHE, birthCorrections });
  if (scorerIdentity.remaining.length) throw new Error(`Scorer identity gate failed:\n${scorerIdentity.remaining.map((item) => JSON.stringify(item)).join('\n')}`);

  // Phase 2b: players (scorers, top-scorer table entries, exactly the 101
  // Japanese players pinned from the foreign-player lists).
  const japanesePlayers = Object.entries(lock.enwiki).filter(([, record]) => record.kind === 'japanese-player' && !record.missing).map(([title]) => title).sort();
  const playersResult = await buildPlayers({ seasons, metadata, cacheRoot: CACHE, japanesePlayers, japaneseExceptions, japaneseClubAliases, birthCorrections });
  const listEntries = await foreignListEntries({ lock, metadata, cacheRoot: CACHE });
  const japaneseCrossCheck = crossCheckJapanesePlayers(playersResult.players, listEntries);
  const candidatesBySeasonClub = new Map();
  for (const player of playersResult.players.values()) for (const bucket of player.seasons) {
    const key = `${bucket.season}|${bucket.club}`;
    if (!candidatesBySeasonClub.has(key)) candidatesBySeasonClub.set(key, []);
    candidatesBySeasonClub.get(key).push({ id: player.id, name: player.en });
  }

  // OpenLigaDB (ODbL) Bundesliga goals, only for matches Wikipedia's boxes
  // left without reconciled scorers, kept in their own files (never merged
  // with CC BY-SA Wikipedia data).
  const openLigaOutputs = new Map();
  const openLigaStats = { years: 0, matches: 0, linked: 0, unlinked: 0, bySeason: new Map() };
  for (const season of seasons.filter((item) => item.league === 'de')) {
    let source;
    try { source = JSON.parse(await readFile(join(CACHE, 'openligadb', `bl1-${season.year}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // OpenLigaDB spells a few club names differently from the cached
    // en.wikipedia titles (München vs the enwiki "Munich"); translate the
    // known cases before folding rather than guessing by edit distance.
    const fold = (value) => String(value ?? '').toLowerCase().replace(/münchen/g, 'munich').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').replace(/^tsghoffenheim$/, 'tsg1899hoffenheim');
    const resolveLigaClub = (teamName) => {
      const meta = metadata.get(normalizeTitle(teamName));
      if (meta?.wikibaseItem && season.table.some((row) => row.club === meta.wikibaseItem)) return meta.wikibaseItem;
      // OpenLigaDB team names are sometimes the German spelling (e.g. "FC
      // Bayern München") with no cached en.wikipedia redirect; fold and
      // match against this season's own club names instead of guessing.
      const wanted = fold(teamName);
      const candidates = season.table.filter((row) => fold(row.sourceTitle) === wanted || fold(row.sourceName) === wanted);
      return candidates.length === 1 ? candidates[0].club : null;
    };
    const outputMatches = {};
    let yearHasOutput = false;
    for (const match of season.matches) {
      if (match.scorers) continue;
      const ligaMatch = source.find((item) => resolveLigaClub(item.team1?.teamName) === match.home && resolveLigaClub(item.team2?.teamName) === match.away);
      if (!ligaMatch) continue;
      const reconciled = reconciledGoals(ligaMatch, match.homeGoals, match.awayGoals);
      if (!reconciled) continue;
      const candidatesFor = (clubId) => candidatesBySeasonClub.get(`${season.id}|${clubId}`) ?? [];
      const homeCandidates = candidatesFor(match.home);
      const awayCandidates = candidatesFor(match.away);
      const link = (events, ownCandidates, opposingCandidates) => events.map((event) => {
        const id = linkPlayerName(event.name, event.ownGoal ? opposingCandidates : ownCandidates);
        openLigaStats[id ? 'linked' : 'unlinked'] += 1;
        return { minute: event.minute, ...(event.isPenalty ? { penalty: true } : {}), ...(event.ownGoal ? { ownGoal: true } : {}), name: event.name, player: id };
      });
      outputMatches[match.key] = { home: link(reconciled.home, homeCandidates, awayCandidates), away: link(reconciled.away, awayCandidates, homeCandidates) };
      openLigaStats.matches += 1;
      openLigaStats.bySeason.set(season.id, (openLigaStats.bySeason.get(season.id) ?? 0) + 1);
      yearHasOutput = true;
    }
    if (yearHasOutput) { openLigaOutputs.set(season.year, outputMatches); openLigaStats.years += 1; }
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
  await writeFile(join(REPORTS, 'scorer-coverage.txt'), `${scorerCoverage.map((row) => {
    const openLiga = openLigaStats.bySeason.get(row.id) ?? 0;
    const total = row.wikipedia + openLiga;
    return `${row.id}: wikipedia ${row.wikipedia}, OpenLigaDB ${openLiga}, none ${row.matches - total}, total ${total}/${row.matches} (${(100 * total / row.matches).toFixed(1)}%), confirmed-by-both ${row.confirmedByBoth}; Wikipedia gaps: no matching box ${row.noMatchingBox}, partial/count mismatch ${row.partialOrCountMismatch}, different-scorer conflict matches ${row.conflictMatches} (${row.conflicts} side(s)); ambiguous boxes ${row.ambiguousBoxes}`;
  }).join('\n')}\n\nUnlinked Wikipedia scorers: ${unresolvedScorers.unlinked}\nNulled wrong-person scorer links: ${scorerIdentity.nulled.length}\n${scorerIdentity.nulled.map((item) => JSON.stringify(item)).join('\n')}\nOpenLigaDB: ${openLigaStats.years} season(s), ${openLigaStats.matches} matches, ${openLigaStats.linked} players linked, ${openLigaStats.unlinked} unlinked\n`);
  await writeFile(join(REPORTS, 'scorer-conflicts.txt'), `${unresolvedScorers.conflicts.map((item) => JSON.stringify(item)).join('\n')}\n`);
  await writeFile(join(REPORTS, 'japanese-crosscheck.txt'), `Pinned Japanese players: ${japanesePlayers.length}\nForeign-list entries: ${listEntries.length}\nDisagreements: ${japaneseCrossCheck.length}\n${japaneseCrossCheck.map((item) => JSON.stringify(item)).join('\n')}\n`);

  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(join(OUTPUT, 's'), { recursive: true }); await mkdir(join(OUTPUT, 'c'), { recursive: true }); await mkdir(join(OUTPUT, 'h'), { recursive: true });
  await mkdir(join(OUTPUT, 'o'), { recursive: true }); await mkdir(join(OUTPUT, 'p'), { recursive: true });
  const fingerprint = createHash('sha256').update(revisionParts.sort().join('\n')).digest('hex');

  // 名鑑 v1: per league-season, per club, the Japanese players plus every
  // player with a reconciled league goal or a top-scorer entry that season
  // (ids + goals only; names load from the player files).
  const seasonClubPlayers = new Map();
  for (const [id, player] of playersResult.players) {
    for (const bucket of player.seasons) {
      if (!bucket.club) continue;
      if (!seasonClubPlayers.has(bucket.season)) seasonClubPlayers.set(bucket.season, new Map());
      const clubMap = seasonClubPlayers.get(bucket.season);
      if (!clubMap.has(bucket.club)) clubMap.set(bucket.club, []);
      clubMap.get(bucket.club).push({ id, goals: bucket.goals, ...(bucket.topScorerRank ? { topScorerRank: bucket.topScorerRank } : {}), ...(player.japan ? { japan: true } : {}) });
    }
  }

  const compactSeasons = [];
  for (const season of seasons) {
    const clubMap = seasonClubPlayers.get(season.id);
    const players = clubMap ? Object.fromEntries([...clubMap].sort(([a], [b]) => a.localeCompare(b))) : {};
    const output = { id: season.id, league: season.league, year: season.year, champion: season.champion, table: season.table.map(({ code, sourceName, sourceTarget, ...row }) => row), matches: season.matches.map(({ gridValue, ...match }) => match), topScorers: season.topScorers, players };
    await writeFile(join(OUTPUT, 's', `${season.id}.json`), stableJson(output));
    compactSeasons.push({ id: season.id, label: `${season.year}–${String(season.year + 1).slice(-2)}`, champion: season.champion, topScorers: season.topScorers.filter((entry) => entry.rank === 1).map((entry) => ({ player: entry.player, goals: entry.goals })) });
  }

  // OpenLigaDB (ODbL) goal events, one file per Bundesliga season, never
  // merged with CC BY-SA Wikipedia data.
  for (const [year, matches] of openLigaOutputs) {
    await writeFile(join(OUTPUT, 'o', `de-${year}.json`), stableJson({ league: 'de', year, licence: 'ODbL-1.0', source: 'OpenLigaDB', matches }));
  }

  // Players, bucketed so one player page loads one file <= 300 KB.
  const playerEntries = [...playersResult.players.entries()].sort(([a], [b]) => a.localeCompare(b));
  const BUCKET_COUNT = 40;
  const buckets = new Map();
  for (const [id, player] of playerEntries) {
    const bucketId = String(Math.abs([...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0)) % BUCKET_COUNT).padStart(2, '0');
    if (!buckets.has(bucketId)) buckets.set(bucketId, {});
    buckets.get(bucketId)[id] = { id, en: player.en, ja: player.ja, birthDate: player.birthDate, seasons: player.seasons.sort((a, b) => a.season.localeCompare(b.season)) };
  }
  const playerFileSizes = [];
  for (const [bucketId, entries] of buckets) {
    const path = join(OUTPUT, 'p', `${bucketId}.json`);
    await writeFile(path, stableJson(entries));
    playerFileSizes.push({ bucket: bucketId, bytes: (await stat(path)).size, count: Object.keys(entries).length });
  }

  // 日本人選手 (all eras): every Japanese player, by season -> club.
  const japanPlayers = [...playersResult.players.values()].filter((player) => player.japan).map((player) => ({
    id: player.id, en: player.en, ja: player.ja, birthDate: player.birthDate, seasons: player.japan.sort((a, b) => a.season.localeCompare(b.season)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(OUTPUT, 'japan.json'), stableJson({ players: japanPlayers }));

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
  await writeFile(join(REPORTS, 'players.txt'), `Players: ${playersResult.players.size}\nBirth dates missing: ${[...playersResult.players.values()].filter((player) => !player.birthDate).length}\nJapanese players: ${japanPlayers.length}/${japanesePlayers.length}\nJapanese players without a required lead reading: ${playersResult.readingsMissing.length}\n${playersResult.readingsMissing.map((item) => JSON.stringify(item)).join('\n')}\n\nAge sanity anomalies remaining after scorer sanitization: ${playersResult.ageAnomalies.length}\n${playersResult.ageAnomalies.map((item) => JSON.stringify(item)).join('\n')}\n\nPlayer file sizes (bucket: bytes, players)\n${playerFileSizes.map((item) => `${item.bucket}: ${item.bytes} bytes, ${item.count} players`).join('\n')}\n`);
  const oversizedPlayerFiles = playerFileSizes.filter((item) => item.bytes > 300 * 1024);
  const elapsed = performance.now() - started;
  console.log(`Built ${seasons.length} league-seasons, ${seasons.reduce((sum, season) => sum + season.matches.length, 0)} matches, ${clubs.size} clubs in ${(elapsed / 1000).toFixed(2)}s`);
  console.log(`Reviewed corrections: ${previousCorrections.length}; invalid reviewed scopes: ${invalidReviewed.length}; unreviewed disagreements: ${proposed.length}; unresolved scorer clubs: ${unresolvedScorerClubs.length}`);
  console.log(`Historical identities missing: ${unresolvedChampions.length}; running-count mismatches: ${countMismatches.length} (${mismatchGroups.unexplained.length} unexplained)`);
  console.log(`Missing Japanese names: ${missingNames.length}; unknown table parameters: ${unknownLines.length}; index.json: ${indexBytes} bytes`);
  console.log(`Players: ${playersResult.players.size} in ${playerFileSizes.length} bucket file(s); scorer conflicts: ${unresolvedScorers.conflicts.length}; unlinked scorers: ${unresolvedScorers.unlinked}; nulled wrong-person links: ${scorerIdentity.nulled.length}; age anomalies: ${playersResult.ageAnomalies.length}; readings missing: ${playersResult.readingsMissing.length}`);
  console.log(`Japanese players: ${japanPlayers.length}/${japanesePlayers.length}; foreign-list cross-check disagreements: ${japaneseCrossCheck.length}`);
  console.log(`OpenLigaDB: ${openLigaStats.years} season(s), ${openLigaStats.matches} matches, ${openLigaStats.linked} players linked / ${openLigaStats.unlinked} unlinked`);
  if (missingNames.length && !allowMissingNames) throw new Error(`Missing Japanese club names:\n${missingNames.join('\n')}`);
  if (unresolvedChampions.length && !allowProposed) throw new Error(`${unresolvedChampions.length} historical champions lack pinned identity metadata`);
  if (proposed.length && !allowProposed) throw new Error(`${proposed.length} results corrections await review; rerun with --allow-proposed to inspect output`);
  if (mismatchGroups.unexplained.length && !allowProposed) throw new Error(`${mismatchGroups.unexplained.length} champion running-count mismatches lack a curated explanation`);
  if (indexBytes > 40 * 1024) throw new Error(`index.json is ${indexBytes} bytes; limit is 40960`);
  if (oversizedPlayerFiles.length) throw new Error(`Player file(s) over 300 KB: ${oversizedPlayerFiles.map((item) => `${item.bucket} (${item.bytes} bytes)`).join(', ')}`);
  if (playersResult.ageAnomalies.length) throw new Error(`${playersResult.ageAnomalies.length} player age anomalies remain after scorer sanitization`);
  return { seasons, championsByLeague, clubs: clubObject, corrections: previousCorrections, invalidReviewed, countMismatches, mismatchGroups, unresolvedChampions, unresolvedScorerClubs, missingNames, unknownLines, indexBytes, elapsed, playersResult, scorerCoverage, unresolvedScorers, scorerIdentity, japaneseCrossCheck, openLigaStats, playerFileSizes };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) build().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
