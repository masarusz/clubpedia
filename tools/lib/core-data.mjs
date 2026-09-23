import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractLinks, findTemplates, parseWikitables, plainText, sectionRanges } from './wikitext.mjs';
import { safeName } from './source-api.mjs';

export const LEAGUE_INFO = Object.freeze({
  en: { name: 'プレミアリーグ', championList: 'List of English football champions', championColumn: 2, first: 1888, scorerList: 'List of English football first tier top scorers' },
  es: { name: 'ラ・リーガ', championList: 'List of Spanish football champions', championColumn: 1, first: 1929, scorerList: 'Pichichi Trophy' },
  de: { name: 'ブンデスリーガ', championList: 'List of German football champions', championColumn: 1, first: 1903, scorerList: 'List of Bundesliga top scorers' },
  it: { name: 'セリエA', championList: 'List of Italian football champions', championColumn: 1, first: 1898, scorerList: 'Capocannoniere' },
  fr: { name: 'リーグ・アン', championList: 'List of French football champions', championColumn: 2, first: 1932, scorerList: 'List of Ligue 1 top scorers' },
});

/** First-choice kit colour from a football-club infobox. */
export function clubKitColour(articleText) {
  const infobox = findTemplates(articleText).find((template) => /^infobox football club$/i.test(template.name.trim()));
  if (!infobox) return null;
  for (const key of ['body1', 'shorts1']) {
    const raw = Object.entries(infobox.params).find(([name]) => name.trim().toLowerCase() === key)?.[1];
    const value = plainText(raw ?? '').trim().replace(/^#/, '');
    if (/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return `#${value.toLowerCase()}`;
  }
  return null;
}

export async function readCached(cacheRoot, wiki, title) {
  return JSON.parse(await readFile(join(cacheRoot, wiki, `${safeName(title)}.json`), 'utf8'));
}

export async function metadataIndex(cacheRoot) {
  const directory = join(cacheRoot, 'metadata/enwiki');
  const index = new Map();
  for (const filename of (await readdir(directory)).sort()) {
    const item = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    if (item.missing) continue;
    for (const key of [item.requestedTitle, item.title, item.redirectedFrom]) if (key) index.set(normalizeTitle(key), item);
  }
  return index;
}

export function normalizeTitle(value) {
  return String(value ?? '').replace(/_/g, ' ').replace(/^:/, '').replace(/\s+/g, ' ').trim();
}

export function resolveClub(metadata, target, context) {
  const item = metadata.get(normalizeTitle(target));
  if (!item?.wikibaseItem) throw new Error(`${context}: no Wikidata club identity for ${target}`);
  return item;
}

function sportsTemplate(text, type) {
  const pattern = new RegExp(`^#invoke\\s*:\\s*sports\\s+${type}$`, 'i');
  return findTemplates(text).find((template) => pattern.test(template.name));
}

function integer(value, context, { optional = false } = {}) {
  if ((value == null || String(value).trim() === '') && optional) return null;
  const cleaned = plainText(value).replace(/,/g, '').match(/-?\d+/)?.[0];
  if (cleaned == null) throw new Error(`${context}: expected integer in ${JSON.stringify(value)}`);
  return Number(cleaned);
}

function clubCodes(params) {
  const key = Object.keys(params).find((name) => name.toLowerCase() === 'team_order');
  if (key) return params[key].split(',').map((code) => code.trim()).filter(Boolean);
  return Object.entries(params).filter(([name]) => /^team\d+$/i.test(name))
    .sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4))).map(([, code]) => code.trim()).filter(Boolean);
}

function param(params, wanted) {
  const key = Object.keys(params).find((name) => name.trim().toLowerCase() === wanted.toLowerCase());
  return key == null ? undefined : params[key];
}

function resultLabel(params, row, code) {
  const result = param(params, `result${row}`) ?? param(params, `result_${code}`) ?? null;
  if (!result) return null;
  return plainText(param(params, `text_${result}`) ?? result);
}

function tableNote(params, code) {
  let value = param(params, `note_${code}`) ?? param(params, `hth_${code}`) ?? param(params, `head_to_head_${code}`) ?? '';
  // Tables sometimes share one note by putting another team code in note_X.
  if (/^[A-Z0-9]+$/.test(value) && value !== code) value = param(params, `note_${value}`) ?? value;
  return plainText(value);
}

const KNOWN_TABLE_EXACT = new Set([
  '1', '2', '3', 'main', 'style', 'source', 'update', 'team_order', 'win_points', 'draw_points', 'loss_points',
  'winpoints', 'drawpoints', 'losspoints', 'ranking_style',
  'res_col_header', 'show_limit', 'only_pld_pts', 'show_matches', 'start_date', 'class_rules', 'status_text',
]);
const KNOWN_TABLE_PREFIX = /^(?:team\d+|name_.+|win_.+|draw_.+|loss_.+|gf_.+|ga_.+|adjust_points_.+|pts_.+|pos_.+|status_.+|result_?.+|note_.+|col_.+|text_.+|hth_.+|head_to_head_.+|showteam_.+|show_limit_.+|source_.+)$/i;

export function parseSeason({ league, year, sources, metadata }) {
  const table = sources.map((source) => sportsTemplate(source.content, 'table')).find(Boolean);
  const results = sources.map((source) => sportsTemplate(source.content, 'results')).find(Boolean);
  const seasonId = `${league}-${year}`;
  if (!table) throw new Error(`${seasonId}: sports table not found`);
  if (!results) throw new Error(`${seasonId}: sports results not found`);
  const codes = clubCodes(table.params);
  if (!codes.length) throw new Error(`${seasonId}: table has no team order`);
  const seenIds = new Set();
  const rows = codes.map((code, index) => {
    const rawName = param(table.params, `name_${code}`);
    const link = extractLinks(rawName ?? '')[0];
    if (!link) throw new Error(`${seasonId}: table code ${code} has no linked name`);
    const meta = resolveClub(metadata, link.target, `${seasonId} table ${code}`);
    if (seenIds.has(meta.wikibaseItem)) throw new Error(`${seasonId}: duplicate club id ${meta.wikibaseItem}`);
    seenIds.add(meta.wikibaseItem);
    const adjustment = integer(param(table.params, `adjust_points_${code}`), `${seasonId} ${code} adjustment`, { optional: true }) ?? 0;
    const w = integer(param(table.params, `win_${code}`), `${seasonId} ${code} wins`);
    const d = integer(param(table.params, `draw_${code}`), `${seasonId} ${code} draws`);
    const l = integer(param(table.params, `loss_${code}`), `${seasonId} ${code} losses`);
    const winPoints = integer(param(table.params, 'win_points') ?? param(table.params, 'winpoints'), `${seasonId} win_points`, { optional: true }) ?? 3;
    const drawPoints = integer(param(table.params, 'draw_points') ?? param(table.params, 'drawpoints'), `${seasonId} draw_points`, { optional: true }) ?? 1;
    const lossPoints = integer(param(table.params, 'loss_points') ?? param(table.params, 'losspoints'), `${seasonId} loss_points`, { optional: true }) ?? 0;
    const override = integer(param(table.params, `pts_${code}`), `${seasonId} ${code} points`, { optional: true });
    const reason = adjustment ? tableNote(table.params, code) : '';
    if (adjustment && !reason) throw new Error(`${seasonId} ${code}: adjustment ${adjustment} has no note`);
    return {
      position: index + 1, club: meta.wikibaseItem, sourceTitle: meta.title, sourceTarget: link.target, sourceName: link.label || plainText(rawName),
      w, d, l, gf: integer(param(table.params, `gf_${code}`), `${seasonId} ${code} GF`),
      ga: integer(param(table.params, `ga_${code}`), `${seasonId} ${code} GA`),
      points: override ?? winPoints * w + drawPoints * d + lossPoints * l + adjustment,
      adjustment, adjustmentReason: reason || null, status: param(table.params, `status_${code}`) ?? null,
      result: resultLabel(table.params, index + 1, code), code,
    };
  });
  const tableById = new Map(rows.map((row) => [row.club, row]));
  const resultCodes = clubCodes(results.params);
  const gridToId = new Map();
  for (const code of resultCodes) {
    const rawName = param(results.params, `name_${code}`);
    const linkedName = extractLinks(rawName ?? '')[0];
    const link = linkedName ?? { target: plainText(rawName), label: plainText(rawName) };
    if (!link.target) throw new Error(`${seasonId}: results code ${code} has no name`);
    let clubId;
    try { if (linkedName) clubId = resolveClub(metadata, link.target, `${seasonId} results ${code}`).wikibaseItem; } catch { /* fall through to label mapping */ }
    if (!clubId) {
      clubId = rows.find((row) => row.code === code)?.club;
    }
    if (!clubId) {
      const folded = (value) => normalizeTitle(value).toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = new Set([folded(link.target), folded(link.label)]);
      const candidates = rows.filter((row) => {
        const names = [folded(row.sourceTitle), folded(row.sourceName)];
        return names.some((name) => [...wanted].some((value) => value && (name === value || (value.length >= 4 && (name.startsWith(value) || value.startsWith(name))))));
      });
      if (candidates.length === 1) clubId = candidates[0].club;
    }
    if (!clubId || !tableById.has(clubId)) throw new Error(`${seasonId}: results code ${code} (${link.target}) is absent from table`);
    gridToId.set(code, clubId);
  }
  const matches = [];
  const scorePattern = /(?:^|[^\d])(\d{1,2})\s*[\u2013\u2014\u2212-]\s*(\d{1,2})(?:[^\d]|$)/;
  for (const [key, rawValue] of Object.entries(results.params)) {
    const found = key.match(/^match_([^_]+)_([^_]+)$/i);
    if (!found) continue;
    const [, homeCode, awayCode] = found;
    const display = plainText(rawValue);
    const score = display.match(scorePattern) ?? extractLinks(rawValue).map((link) => link.label.match(scorePattern)).find(Boolean);
    const note = plainText(param(results.params, `${key}_note`) ?? '');
    const home = gridToId.get(homeCode);
    const away = gridToId.get(awayCode);
    if (!score) {
      if (home && away && seasonId === 'fr-1992' && home === resolveClub(metadata, 'Valenciennes FC', seasonId).wikibaseItem && away === resolveClub(metadata, 'Olympique de Marseille', seasonId).wikibaseItem) {
        matches.push({ key: `${seasonId}-${home}-${away}`, home, away, homeGoals: 0, awayGoals: 0, status: 'double-defeat', note: note || null, gridValue: null });
      } else if (String(rawValue).trim() && !/^(?:null|[\d]{1,2}\s+\w+)$/i.test(plainText(rawValue))) {
        throw new Error(`${seasonId}: non-score result ${key}=${JSON.stringify(rawValue)}`);
      }
      continue;
    }
    if (!home || !away) throw new Error(`${seasonId}: unmapped results code in scored cell ${key}`);
    matches.push({ key: `${seasonId}-${home}-${away}`, home, away, homeGoals: Number(score[1]), awayGoals: Number(score[2]), status: 'played', note: note || null, gridValue: `${score[1]}–${score[2]}` });
  }
  matches.sort((a, b) => a.key.localeCompare(b.key));
  const unknown = Object.keys(table.params).filter((key) => !KNOWN_TABLE_EXACT.has(key.toLowerCase()) && !KNOWN_TABLE_PREFIX.test(key)).sort();
  return {
    id: seasonId, league, year, table: rows, matches, unknownTableParameters: unknown,
    pointSystem: {
      win: integer(param(table.params, 'win_points') ?? param(table.params, 'winpoints'), `${seasonId} win_points`, { optional: true }) ?? 3,
      draw: integer(param(table.params, 'draw_points') ?? param(table.params, 'drawpoints'), `${seasonId} draw_points`, { optional: true }) ?? 1,
      loss: integer(param(table.params, 'loss_points') ?? param(table.params, 'losspoints'), `${seasonId} loss_points`, { optional: true }) ?? 0,
    },
  };
}

export function matchOutcome(match) {
  if (match.status === 'awarded') {
    if (match.winner === match.home) return { home: { w: 1, d: 0, l: 0 }, away: { w: 0, d: 0, l: 1 } };
    if (match.winner === match.away) return { home: { w: 0, d: 0, l: 1 }, away: { w: 1, d: 0, l: 0 } };
    throw new Error(`${match.key}: awarded match has invalid winner ${match.winner}`);
  }
  // The official Ligue 1 table records Valenciennes–Marseille in the draw
  // column and deducts one point from each club. Its display status remains a
  // double defeat, but reconciliation therefore treats the 0–0 as a draw.
  if (match.status === 'double-defeat') return { home: { w: 0, d: 1, l: 0 }, away: { w: 0, d: 1, l: 0 } };
  return outcome(match.homeGoals, match.awayGoals);
}

export function matchStats(season) {
  const stats = new Map(season.table.map((row) => [row.club, { w: 0, d: 0, l: 0, gf: 0, ga: 0 }]));
  for (const match of season.matches) {
    const home = stats.get(match.home); const away = stats.get(match.away);
    home.gf += match.homeGoals; home.ga += match.awayGoals; away.gf += match.awayGoals; away.ga += match.homeGoals;
    const result = matchOutcome(match);
    for (const key of ['w', 'd', 'l']) { home[key] += result.home[key]; away[key] += result.away[key]; }
  }
  return stats;
}

const STAT_KEYS = ['w', 'd', 'l', 'gf', 'ga'];
export function discrepancies(season) {
  const computed = matchStats(season);
  return season.table.flatMap((row) => {
    const actual = computed.get(row.club);
    const delta = Object.fromEntries(STAT_KEYS.map((key) => [key, row[key] - actual[key]]));
    return STAT_KEYS.some((key) => delta[key]) ? [{ club: row.club, sourceTitle: row.sourceTitle, table: Object.fromEntries(STAT_KEYS.map((key) => [key, row[key]])), results: actual, delta }] : [];
  });
}

function outcome(homeGoals, awayGoals, special = false) {
  if (special) return { home: { w: 0, d: 0, l: 1 }, away: { w: 0, d: 0, l: 1 } };
  if (homeGoals > awayGoals) return { home: { w: 1, d: 0, l: 0 }, away: { w: 0, d: 0, l: 1 } };
  if (homeGoals < awayGoals) return { home: { w: 0, d: 0, l: 1 }, away: { w: 1, d: 0, l: 0 } };
  return { home: { w: 0, d: 1, l: 0 }, away: { w: 0, d: 1, l: 0 } };
}

function parseScore(value, context) {
  const found = String(value ?? '').match(/^(\d{1,2})\s*[–—−-]\s*(\d{1,2})$/);
  if (!found) throw new Error(`${context}: invalid score ${JSON.stringify(value)}`);
  return [Number(found[1]), Number(found[2])];
}

function correctionMatch(season, action, { checkGrid = true } = {}) {
  const match = season.matches.find((item) => item.key === action.match);
  if (!match) throw new Error(`${season.id}: reviewed ${action.type} names missing match ${action.match}`);
  if (checkGrid && action.grid != null && match.gridValue !== action.grid) {
    throw new Error(`${action.match}: source grid changed (reviewed ${action.grid}, now ${match.gridValue})`);
  }
  return match;
}

function assertCorrectedPosition(season, row) {
  const previous = season.table[row.position - 2];
  const next = season.table[row.position];
  if ((previous && previous.points < row.points) || (next && next.points > row.points)) {
    throw new Error(`${season.id} ${row.club}: corrected points ${row.points} contradict position ${row.position}`);
  }
}

/** Apply only human-reviewed decisions, then prove that their exception scope is exact. */
export function applyReviewedCorrection(season, correction, { strictExact = true } = {}) {
  if (!correction || correction.status !== 'reviewed') return { differences: discrepancies(season), allowedUnreconciled: [] };
  if (!Array.isArray(correction.actions) || !correction.actions.length) throw new Error(`${season.id}: reviewed correction has no actions`);
  const allowed = new Set();
  const correctedRows = [];
  for (const action of correction.actions) {
    if (action.type === 'correct-cell') {
      const match = correctionMatch(season, action);
      const [homeGoals, awayGoals] = parseScore(action.to, `${action.match} correct-cell`);
      match.homeGoals = homeGoals; match.awayGoals = awayGoals;
      match.correctedFrom = action.grid; match.evidence = action.evidence;
    } else if (action.type === 'awarded') {
      const match = correctionMatch(season, action);
      if (action.winner !== match.home && action.winner !== match.away) throw new Error(`${action.match}: awarded winner ${action.winner} is not a participant`);
      if (action.officialScore != null) [match.homeGoals, match.awayGoals] = parseScore(action.officialScore, `${action.match} officialScore`);
      match.status = 'awarded'; match.winner = action.winner;
      match.pitchScore = action.pitchScore; match.decidedBy = action.decidedBy; match.evidence = action.evidence;
    } else if (action.type === 'double-defeat') {
      const match = correctionMatch(season, action, { checkGrid: false });
      match.homeGoals = 0; match.awayGoals = 0; match.status = 'double-defeat'; match.evidence = action.evidence;
    } else if (action.type === 'correct-table-row') {
      const row = season.table.find((item) => item.club === action.club);
      if (!row) throw new Error(`${season.id}: reviewed correct-table-row names missing club ${action.club}`);
      const correctedFrom = Object.fromEntries(STAT_KEYS.map((key) => [key, row[key]]));
      for (const key of STAT_KEYS) {
        if (!Number.isInteger(action.to?.[key])) throw new Error(`${season.id} ${action.club}: correct-table-row lacks integer ${key}`);
        row[key] = action.to[key];
      }
      row.points = season.pointSystem.win * row.w + season.pointSystem.draw * row.d + season.pointSystem.loss * row.l + row.adjustment;
      row.correctedFrom = correctedFrom; row.evidence = action.evidence;
      correctedRows.push(row);
    } else if (action.type === 'unreconciled') {
      let clubs = action.clubs;
      if (action.match) {
        const match = correctionMatch(season, action);
        match.unreconciled = true; match.evidence = action.evidence;
        clubs = [match.home, match.away];
      }
      if (!Array.isArray(clubs) || !clubs.length) throw new Error(`${season.id}: unreconciled action names no clubs or match`);
      for (const club of clubs) {
        const row = season.table.find((item) => item.club === club);
        if (!row) throw new Error(`${season.id}: unreconciled action names missing club ${club}`);
        row.unreconciled = true; allowed.add(club);
      }
    } else throw new Error(`${season.id}: unknown reviewed action type ${action.type}`);
  }
  for (const row of correctedRows) assertCorrectedPosition(season, row);
  const differences = discrepancies(season);
  const actual = new Set(differences.map((item) => item.club));
  const unexpected = [...actual].filter((club) => !allowed.has(club));
  const overbroad = [...allowed].filter((club) => !actual.has(club));
  if (strictExact && (unexpected.length || overbroad.length)) {
    throw new Error(`${season.id}: reviewed actions do not exactly explain remaining differences (unexpected: ${unexpected.join(', ') || 'none'}; no longer different: ${overbroad.join(', ') || 'none'})`);
  }
  return { differences, allowedUnreconciled: [...allowed].sort(), unexpected, overbroad };
}

export function proposeCorrection(season, differences) {
  if (season.id === 'fr-1992') return { changes: [], reason: 'The source models Valenciennes–Marseille as a 0–0 double defeat while its table W/D/L columns treat the score as a draw; keep the explicit match status and official table.', status: 'proposed' };
  const target = new Map();
  for (const item of differences) for (const key of STAT_KEYS) if (item.delta[key]) target.set(`${item.club}:${key}`, item.delta[key]);
  const candidates = [];
  const bad = new Set(differences.map((item) => item.club));
  for (const match of season.matches.filter((item) => bad.has(item.home) && bad.has(item.away))) {
    const oldOutcome = outcome(match.homeGoals, match.awayGoals, match.status === 'double-defeat');
    for (let hg = 0; hg <= 10; hg += 1) for (let ag = 0; ag <= 10; ag += 1) {
      if (hg === match.homeGoals && ag === match.awayGoals) continue;
      const next = outcome(hg, ag);
      const vector = new Map([
        [`${match.home}:w`, next.home.w - oldOutcome.home.w], [`${match.home}:d`, next.home.d - oldOutcome.home.d], [`${match.home}:l`, next.home.l - oldOutcome.home.l],
        [`${match.home}:gf`, hg - match.homeGoals], [`${match.home}:ga`, ag - match.awayGoals],
        [`${match.away}:w`, next.away.w - oldOutcome.away.w], [`${match.away}:d`, next.away.d - oldOutcome.away.d], [`${match.away}:l`, next.away.l - oldOutcome.away.l],
        [`${match.away}:gf`, ag - match.awayGoals], [`${match.away}:ga`, hg - match.homeGoals],
      ].filter(([, value]) => value));
      if (![...vector].every(([key, value]) => target.has(key) && Math.sign(value) === Math.sign(target.get(key)) && Math.abs(value) <= Math.abs(target.get(key)))) continue;
      candidates.push({ match, hg, ag, vector });
    }
  }
  const keys = [...target.keys()];
  const search = (remaining, chosen, used, limit) => {
    if ([...remaining.values()].every((value) => value === 0)) return chosen;
    if (chosen.length >= limit) return null;
    const key = keys.filter((item) => remaining.get(item)).sort((a, b) => candidates.filter((c) => !used.has(c.match.key) && c.vector.has(a)).length - candidates.filter((c) => !used.has(c.match.key) && c.vector.has(b)).length)[0];
    for (const candidate of candidates) {
      if (used.has(candidate.match.key) || !candidate.vector.has(key)) continue;
      let valid = true; const next = new Map(remaining);
      for (const [vectorKey, value] of candidate.vector) {
        const before = next.get(vectorKey) ?? 0; const after = before - value;
        if (before === 0 || (after && Math.sign(after) !== Math.sign(before))) { valid = false; break; }
        next.set(vectorKey, after);
      }
      if (!valid) continue;
      const found = search(next, [...chosen, candidate], new Set([...used, candidate.match.key]), limit);
      if (found) return found;
    }
    return null;
  };
  let solution = null;
  for (let limit = 1; limit <= 8 && !solution; limit += 1) solution = search(new Map(target), [], new Set(), limit);
  if (!solution) return { changes: [], reason: 'No set of up to eight results-grid cell changes reconciles the official table; manual review required.', status: 'proposed' };
  return { changes: solution.map(({ match, hg, ag }) => ({ match: match.key, home: match.home, away: match.away, grid: `${match.homeGoals}–${match.awayGoals}`, proposed: `${hg}–${ag}`, gridNote: match.note })), reason: 'Proposed minimal set of grid-cell changes that reconciles the official table.', status: 'proposed' };
}

function foldedClubName(value) {
  return normalizeTitle(plainText(value)).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function sortNameTarget(cell) {
  for (const template of findTemplates(cell)) if (/^(?:sortkeyname|sortname|sort name)$/i.test(template.name)) {
    const explicit = template.params['3'];
    const target = explicit || [template.params['1'], template.params['2']].filter(Boolean).join(' ');
    if (target) return normalizeTitle(target);
  }
  return null;
}

export function seasonTopScorers(articleText, metadata, season, unresolved = []) {
  const sections = sectionRanges(articleText).filter((section) => /top\s*(?:goal)?scorers?|goalscorers?/i.test(section.title));
  const output = [];
  const seasonClubIds = new Set(season.table.map((row) => row.club));
  const clubByName = new Map();
  for (const row of season.table) for (const name of [row.sourceTitle, row.sourceName]) if (foldedClubName(name)) clubByName.set(foldedClubName(name), row.club);
  for (const section of sections) for (const table of parseWikitables(section.content)) {
    const headerIndex = table.findIndex((row) => row.some((cell) => /player/i.test(plainText(cell))) && row.some((cell) => /goals?/i.test(plainText(cell))));
    if (headerIndex < 0) continue;
    const headers = table[headerIndex].map((cell) => plainText(cell).toLowerCase());
    let lastRank = null; let lastGoals = null; let lastClub = null;
    for (const row of table.slice(headerIndex + 1)) {
      // Rowspans omit rank/goals cells. Identify the club against this
      // season's table first; its preceding cell is then the player cell.
      let club = null; let clubIndex = -1;
      for (let index = 0; index < row.length && !club; index += 1) {
        for (const link of extractLinks(row[index])) {
          try {
            const candidate = resolveClub(metadata, link.target, `${season.id} top scorer`).wikibaseItem;
            if (seasonClubIds.has(candidate)) { club = candidate; clubIndex = index; break; }
          } catch { /* display-name fallback below */ }
        }
        if (!club) {
          const fragments = row[index].split(/<br\s*\/?\s*>|\s*\/\s*/i);
          const wanted = new Set([foldedClubName(row[index]), ...fragments.map(foldedClubName), ...extractLinks(row[index]).flatMap((link) => [foldedClubName(link.target), foldedClubName(link.label)])]);
          for (const name of wanted) if (clubByName.has(name)) { club = clubByName.get(name); clubIndex = index; break; }
        }
      }
      let playerIndex = clubIndex > 0 ? clubIndex - 1 : row.findIndex((cell) => sortNameTarget(cell) || extractLinks(cell).length);
      if (playerIndex < 0) continue;
      const playerCell = row[playerIndex];
      const playerLink = extractLinks(playerCell).find((link) => !/^(?:Flag|File):/i.test(link.target));
      const player = playerLink?.target ?? sortNameTarget(playerCell);
      if (!player) continue;
      if (clubIndex < 0 && row.length < headers.length && lastClub) club = lastClub;
      if (clubIndex < 0 && playerIndex + 1 < row.length && !/^\s*-?\d+\s*$/.test(plainText(row[playerIndex + 1]))) clubIndex = playerIndex + 1;
      const numberIn = (cell) => { const found = plainText(cell).replace(/,/g, '').match(/^-?\d+$/); return found ? Number(found[0]) : null; };
      const before = row.slice(0, playerIndex).map(numberIn).filter((value) => value != null);
      const afterIndex = clubIndex >= 0 ? clubIndex : playerIndex;
      const after = row.slice(afterIndex + 1).map(numberIn).filter((value) => value != null);
      const rank = before.at(-1) ?? lastRank;
      const goals = after[0] ?? lastGoals;
      if (rank == null || goals == null) continue;
      lastRank = rank; lastGoals = goals;
      if (club) lastClub = club;
      if (!club) unresolved.push({ season: season.id, player, rawCell: row[clubIndex] ?? null });
      output.push({ rank, player, club, goals });
    }
  }
  return output;
}

const CHAMPION_SECTION = Object.freeze({
  en: /^List of champions by season$/i,
  es: /^Champions$/i,
  de: /^Champions$/i,
  it: /^Editions$/i,
  fr: /^List of champions$/i,
});

function championTables(text, league) {
  const section = sectionRanges(text).find((item) => item.level === 2 && CHAMPION_SECTION[league].test(plainText(item.title)));
  if (!section) throw new Error(`${league} champions: primary champions section not found`);
  return parseWikitables(section.content);
}

export function championClubTargets(text, league) {
  const targets = new Set();
  const labels = new Map();
  for (const table of championTables(text, league)) {
    const headerIndex = table.findIndex((row) => row.some((cell) => /^season$|^year$/i.test(plainText(cell))) && row.some((cell) => /winner|champion/i.test(plainText(cell))));
    if (headerIndex < 0) continue;
    const headers = table[headerIndex].map((cell) => plainText(cell));
    const seasonIndex = headers.findIndex((cell) => /^season$|^year$/i.test(cell));
    const championIndex = headers.findIndex((cell) => /winner|champion/i.test(cell));
    for (const row of table.slice(headerIndex + 1)) {
      const year = plainText(row[seasonIndex]).match(/(?:18|19|20)\d{2}/)?.[0];
      if (row.length <= Math.max(seasonIndex, championIndex) || !year || Number(year) < LEAGUE_INFO[league].first) continue;
      const cell = row[championIndex] ?? '';
      const rendered = plainText(cell);
      if (!rendered || /no champions?|not held|cancelled|suspended|not contested|not played|no championship|civil war|title stripped|decoration|nazism|^[-—–]$/i.test(rendered) || /<(?:s|del)>|text-decoration\s*:\s*line-through/i.test(cell)) continue;
      const identityCell = cell.replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '').replace(/<ref\b[^/>]*\/\s*>/gi, '');
      const link = extractLinks(identityCell)[0];
      const label = (link?.label ?? rendered).replace(/\s*\(\d+\).*$/, '').trim();
      if (link?.target) labels.set(label.toLowerCase(), link.target);
      const target = link?.target ?? labels.get(label.toLowerCase()) ?? label;
      if (target) targets.add(normalizeTitle(target));
    }
  }
  return [...targets].sort();
}

export function parseChampions(text, league, metadata) {
  const info = LEAGUE_INFO[league];
  const champions = [];
  const labelTargets = new Map();
  for (const table of championTables(text, league)) {
    const headerIndex = table.findIndex((row) => row.some((cell) => /^season$|^year$/i.test(plainText(cell))) && row.some((cell) => /winner|champion/i.test(plainText(cell))));
    if (headerIndex < 0) continue;
    const headers = table[headerIndex].map((cell) => plainText(cell));
    const expectedSeasonIndex = headers.findIndex((cell) => /^season$|^year$/i.test(cell));
    const expectedChampionIndex = headers.findIndex((cell) => /winner|champion/i.test(cell));
    for (const row of table.slice(headerIndex + 1)) {
    // Section divider rows have fewer cells and must not become fake seasons.
    if (row.length <= Math.max(expectedSeasonIndex, expectedChampionIndex)) continue;
    const seasonCell = row[expectedSeasonIndex];
    if (!seasonCell) continue;
    const match = plainText(seasonCell).match(/((?:18|19|20)\d{2})(?:[\u2013-](?:\d{4}|\d{2}))?/);
    if (!match || Number(match[1]) < info.first) continue;
    const cell = row[expectedChampionIndex] ?? '';
    const rendered = plainText(cell);
    if (!rendered || /no champions?|not held|cancelled|suspended|not contested|no championship|civil war|title stripped|decoration|nazism|^[-—–]$/i.test(rendered) || /<(?:s|del)>|text-decoration\s*:\s*line-through/i.test(cell)) {
      champions.push({ season: match[0].replace('-', '–'), champion: null, printedCount: null });
      continue;
    }
    const identityCell = cell.replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '').replace(/<ref\b[^/>]*\/\s*>/gi, '');
    const link = extractLinks(identityCell)[0];
    let target = link?.target;
    const label = (link?.label ?? rendered).replace(/\s*\(\d+\).*$/, '').trim();
    if (target) labelTargets.set(label.toLowerCase(), target);
    else target = labelTargets.get(label.toLowerCase()) ?? label;
    const count = rendered.match(/\((\d+)\)\s*[^\d]*$/)?.[1];
    let meta;
    try { meta = resolveClub(metadata, target, `${league} champions ${match[0]}`); }
    catch {
      champions.push({ season: match[0].replace('-', '–'), champion: null, unresolvedTarget: target, printedCount: count ? Number(count) : null });
      continue;
    }
    champions.push({ season: match[0].replace('-', '–'), champion: meta.wikibaseItem, sourceTitle: meta.title, printedCount: count ? Number(count) : null });
    }
  }
  const unique = new Map();
  for (const entry of champions) unique.set(entry.season, entry);
  return [...unique.values()].sort((a, b) => a.season.localeCompare(b.season));
}

export function allHistoryTopScorers(text, league) {
  const start = LEAGUE_INFO[league].first;
  const bySeason = new Map();
  const seasonPattern = /^(?:18|19|20)\d{2}(?:[\u2013-](?:\d{4}|\d{2}))?$/;
  const targets = (cell) => {
    const linked = extractLinks(cell).filter((link) => !/(?:season|league|championship)$/i.test(link.target)).map((link) => link.target);
    for (const template of findTemplates(cell)) if (/^(?:sortname|sort name)$/i.test(template.name)) {
      const target = template.params['3'] || [template.params['1'], template.params['2']].filter(Boolean).join(' ');
      if (target) linked.push(target);
    }
    return [...new Set(linked)];
  };
  for (const table of parseWikitables(text)) {
    const headerIndex = table.findIndex((row) => row.some((cell) => /^season$/i.test(plainText(cell))) && row.some((cell) => /player|scorer/i.test(plainText(cell))));
    if (headerIndex < 0) continue;
    const headers = table[headerIndex].map((cell) => plainText(cell));
    const seasonColumn = headers.findIndex((cell) => /^season$/i.test(cell));
    const playerColumn = headers.findIndex((cell) => /player|scorer/i.test(cell));
    let currentSeason = null;
    for (const row of table.slice(headerIndex + 1)) {
      const foundSeason = row.findIndex((cell) => seasonPattern.test(plainText(cell)));
      let playerCell;
      if (foundSeason >= 0) {
        currentSeason = plainText(row[foundSeason]).replace('-', '–');
        playerCell = row[playerColumn + foundSeason - seasonColumn];
      } else {
        playerCell = row.find((cell) => targets(cell).length);
      }
      if (!currentSeason || Number(currentSeason.slice(0, 4)) < start || !playerCell) continue;
      const winners = targets(playerCell);
      if (!winners.length) continue;
      const existing = bySeason.get(currentSeason) ?? [];
      bySeason.set(currentSeason, [...new Set([...existing, ...winners])]);
    }
  }
  return [...bySeason].map(([season, winners]) => ({ season, winners })).sort((a, b) => a.season.localeCompare(b.season));
}
