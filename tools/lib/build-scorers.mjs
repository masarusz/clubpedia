import { clubSeasonTitle } from './wikitext.mjs';
import { leagueFootballBoxes, parseGoalSide, resolveBoxClub } from './scorers.mjs';
import { normalizeTitle, resolveClub } from './core-data.mjs';

export function minuteValue(value) {
  const match = String(value ?? '').match(/^(\d+)(?:\+(\d+))?$/);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [Number.MAX_SAFE_INTEGER, 0];
}

export function compareGoalMinutes(a, b) {
  const left = minuteValue(a.minute); const right = minuteValue(b.minute);
  return left[0] - right[0] || left[1] - right[1];
}

function displayKey(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9]/gu, '');
}

function compatibleScorer(a, b) {
  if (a.isPenalty !== b.isPenalty || a.ownGoal !== b.ownGoal) return false;
  if (a.player && b.player) return a.player === b.player;
  return Boolean(displayKey(a.display)) && displayKey(a.display) === displayKey(b.display);
}

/**
 * Merge up to two independent readings (home club's article, away club's
 * article) of the same side's scorers. They agree structurally when they
 * name the same minutes with the same penalty/own-goal flags; one article
 * leaving a scorer unlinked while the other links it is not a disagreement
 * (the linked identity wins). A real conflict is either a different set of
 * minutes, or two different resolved player identities for the same minute.
 */
export function mergeReadings(list, scoringClub, opposingClub) {
  if (!list.length) return { ok: false };
  const groups = [...list[0].events].sort(compareGoalMinutes).map((event) => [{ source: list[0].source, event }]);
  for (const reading of list.slice(1)) {
    if (reading.events.length !== groups.length) return { ok: false };
    const remaining = [...reading.events].sort(compareGoalMinutes);
    for (const group of groups) {
      const index = remaining.findIndex((event) => compatibleScorer(group[0].event, event));
      if (index < 0) return { ok: false };
      group.push({ source: reading.source, event: remaining.splice(index, 1)[0] });
    }
  }
  const events = groups.map((group) => {
    const exemplar = group.find(({ event }) => event.player)?.event ?? group[0].event;
    const ownClub = exemplar.ownGoal ? opposingClub : scoringClub;
    const preferred = group.find(({ source }) => source === ownClub)?.event ?? group[0].event;
    return { ...preferred, player: exemplar.player ?? null, display: preferred.display ?? exemplar.display ?? null };
  }).sort(compareGoalMinutes);
  return { ok: true, events };
}

function parseScorePair(value) {
  const found = String(value ?? '').match(/(\d{1,2})\s*[–—−-]\s*(\d{1,2})/);
  return found ? [Number(found[1]), Number(found[2])] : null;
}

function targetScore(match) {
  // Awarded matches: reconcile scorers against the score actually played on
  // the pitch, not the ruling. "as in the grid" / "abandoned" pitchScore
  // values fall back to the results-grid score (still the pitch score).
  if (match.status === 'awarded') return parseScorePair(match.pitchScore) ?? parseScorePair(match.gridValue);
  if (match.status === 'double-defeat' || match.unreconciled) return parseScorePair(match.gridValue) ?? [match.homeGoals, match.awayGoals];
  return [match.homeGoals, match.awayGoals];
}

/** Resolve a scorer event's link target to a Wikidata id up front, so two
 * readings of the same goal (one saying "Mohamed Salah", the other "Mo
 * Salah") compare as the same player rather than a false conflict. */
function resolveEvent(event, metadata) {
  const meta = event.player ? metadata.get(normalizeTitle(event.player)) : null;
  return { minute: event.minute, isPenalty: event.isPenalty, ownGoal: event.ownGoal, display: event.display, player: meta?.wikibaseItem ?? null };
}

function eventToScorer(event, unresolvedCounter) {
  if (!event.player) unresolvedCounter.count += 1;
  return { player: event.player, display: event.display, minute: event.minute, ...(event.isPenalty ? { penalty: true } : {}), ...(event.ownGoal ? { ownGoal: true } : {}) };
}

/**
 * Read every club-season article for this season, find its league-section
 * football boxes, and reconcile goals1/goals2 against the built (corrected)
 * score. Attaches `scorers: {home, away}` to matching entries in
 * `season.matches` (mutates in place) wherever exactly one reconciled
 * reading exists (or both club articles reconcile and agree); records a
 * conflict when both reconcile but disagree.
 */
export async function attachScorers({ season, lock, metadata, readCached, cacheRoot, unresolvedScorers, overrides = [] }) {
  const matchByKey = new Map(season.matches.map((match) => [match.key, match]));
  // side -> array of { source, events } readings, gathered from up to two
  // club articles (the home club's and the away club's own season page).
  const readings = new Map();
  let ambiguousBoxes = 0;
  const unresolvedCounter = { count: 0 };

  for (const row of season.table) {
    const title = clubSeasonTitle(season.year, row.sourceTarget ?? row.sourceTitle);
    const lockEntry = lock.enwiki[title];
    if (!lockEntry || lockEntry.missing) continue;
    const article = await readCached(cacheRoot, 'enwiki', title);
    const boxes = leagueFootballBoxes(article.content, season.league);
    for (const box of boxes) {
      const home = resolveBoxClub(box.params.team1 ?? '', { metadata, season, resolveClub, normalizeTitle });
      const away = resolveBoxClub(box.params.team2 ?? '', { metadata, season, resolveClub, normalizeTitle });
      if (!home || !away || home === away) { ambiguousBoxes += 1; continue; }
      const match = matchByKey.get(`${season.id}-${home}-${away}`);
      if (!match) { ambiguousBoxes += 1; continue; }
      const target = targetScore(match);
      if (!target) { ambiguousBoxes += 1; continue; }
      const [targetHome, targetAway] = target;
      const homeEvents = parseGoalSide(box.params.goals1 ?? '').map((event) => resolveEvent(event, metadata));
      const awayEvents = parseGoalSide(box.params.goals2 ?? '').map((event) => resolveEvent(event, metadata));
      const entry = readings.get(match.key) ?? { home: [], away: [] };
      if (homeEvents.length === targetHome) entry.home.push({ source: row.club, events: homeEvents });
      if (awayEvents.length === targetAway) entry.away.push({ source: row.club, events: awayEvents });
      readings.set(match.key, entry);
    }
  }

  const coverage = { matches: season.matches.length, wikipedia: 0, confirmedByBoth: 0, ambiguousBoxes, conflicts: 0 };
  const conflictMatches = new Set();
  for (const [key, entry] of readings) {
    const match = matchByKey.get(key);
    if (!match) continue;
    const sides = {};
    let bothSidesConfirmed = true;
    for (const side of ['home', 'away']) {
      const list = entry[side];
      if (!list.length) { bothSidesConfirmed = false; continue; }
      if (list.length === 1) {
        sides[side] = list[0].events;
        bothSidesConfirmed = false;
      } else {
        const scoringClub = side === 'home' ? match.home : match.away;
        const opposingClub = side === 'home' ? match.away : match.home;
        const merged = mergeReadings(list, scoringClub, opposingClub);
        if (merged.ok) sides[side] = merged.events;
        else {
          bothSidesConfirmed = false;
          const override = overrides.find((item) => item.season === season.id && item.match === key && item.side === side);
          if (override) {
            sides[side] = override.scorers.map((scorer) => ({ minute: scorer.minute ?? null, isPenalty: Boolean(scorer.penalty), ownGoal: Boolean(scorer.ownGoal), player: scorer.player ?? null, display: scorer.display ?? null }));
          } else {
            coverage.conflicts += 1;
            conflictMatches.add(key);
            unresolvedScorers.conflicts.push({ season: season.id, match: key, side, readings: list.map((item) => ({ club: item.source, events: item.events })) });
          }
        }
      }
    }
    // Only attach scorers once BOTH sides have a resolved reading (single
    // source, agreeing sources, or a curated override) -- never a match with
    // one side confirmed and the other a live conflict, which would both
    // read as "no scorers" for that side and wrongly block the Bundesliga
    // OpenLigaDB fallback for a match Wikipedia did not fully reconcile.
    if (sides.home && sides.away) {
      match.scorers = {
        home: sides.home.map((event) => eventToScorer(event, unresolvedCounter)).sort(compareGoalMinutes),
        away: sides.away.map((event) => eventToScorer(event, unresolvedCounter)).sort(compareGoalMinutes),
      };
      coverage.wikipedia += 1;
      if (bothSidesConfirmed) coverage.confirmedByBoth += 1;
    }
  }
  coverage.conflictMatches = conflictMatches.size;
  coverage.noMatchingBox = season.matches.filter((match) => !match.scorers && !readings.has(match.key)).length;
  coverage.partialOrCountMismatch = season.matches.filter((match) => !match.scorers && readings.has(match.key) && !conflictMatches.has(match.key)).length;
  unresolvedScorers.unlinked += unresolvedCounter.count;
  return coverage;
}
