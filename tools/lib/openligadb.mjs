/**
 * OpenLigaDB (ODbL) Bundesliga goal events — used only for matches Wikipedia's
 * club-season boxes could not reconcile (see build-data.mjs). Kept in its own
 * output files (public/data/o/) so ODbL data never shares a file with CC BY-SA
 * Wikipedia data.
 */

/** matchMinute > 90 in the second half is stoppage time, shown as 90+n. There
 * is no reliable signal in this feed for first-half stoppage time (no
 * half-time boundary marker per goal beyond the goal's own matchMinute), so a
 * value <= 90 is kept as the plain minute and never rewritten to 45+n. */
export function displayMinute(matchMinute) {
  if (!Number.isFinite(matchMinute)) return null;
  if (matchMinute > 90) return `90+${matchMinute - 90}`;
  return String(matchMinute);
}

/** The scoring side comes from which side's running score increased, not the
 * scorer's own team (own goals score for the opponent). */
function scoringSide(goal, previous) {
  if (goal.scoreTeam1 > (previous?.scoreTeam1 ?? 0)) return 'team1';
  if (goal.scoreTeam2 > (previous?.scoreTeam2 ?? 0)) return 'team2';
  return null;
}

export function reconciledGoals(match, expectedHomeGoals, expectedAwayGoals) {
  const goals = [...(match.goals ?? [])].sort((a, b) => (a.matchMinute ?? 0) - (b.matchMinute ?? 0));
  let previous = null;
  const home = []; const away = [];
  for (const goal of goals) {
    const side = scoringSide(goal, previous);
    previous = goal;
    const event = {
      minute: displayMinute(goal.matchMinute),
      isPenalty: Boolean(goal.isPenalty),
      ownGoal: Boolean(goal.isOwnGoal),
      name: goal.goalGetterName ?? null,
    };
    if (side === 'team1') home.push(event); else if (side === 'team2') away.push(event);
  }
  if (home.length !== expectedHomeGoals || away.length !== expectedAwayGoals) return null;
  return { home, away };
}

/** "L. Sane" -> link a name to a Wikidata player id only when exactly one
 * player of this club-season's built scorers/top-scorers matches surname +
 * initial. */
export function linkPlayerName(name, candidates) {
  const trimmed = String(name ?? '').trim();
  const match = trimmed.match(/^([A-ZÀ-ÖØ-Þ])\.?\s+(.+)$/);
  if (!match) return null;
  const initial = match[1].toUpperCase();
  const surname = match[2].trim().toLowerCase();
  const found = candidates.filter((candidate) => {
    if (!candidate.name) return false;
    const parts = candidate.name.trim().split(/\s+/);
    const last = parts.at(-1)?.toLowerCase();
    const first = parts[0]?.[0]?.toUpperCase();
    return last === surname && first === initial;
  });
  return found.length === 1 ? found[0].id : null;
}
