import { sectionRanges, plainText, extractLinks } from './wikitext.mjs';

/** ja.wikipedia country name -> our league key, and the top-flight division
 * label(s) used in the league cell (older articles abbreviate). A lower
 * division (e.g. "ブンデス2部") must not match -- the Okudera 1980-81 Hertha
 * trap. */
export const COUNTRY_LEAGUE = Object.freeze({
  イングランド: { league: 'en', names: [/^プレミア(?:リーグ)?$/] },
  ドイツ: { league: 'de', names: [/^(?:1\.ブンデス|ブンデス(?:リーガ|1部)?)$/] },
  西ドイツ: { league: 'de', names: [/^(?:1\.ブンデス|ブンデス1部)$/] },
  スペイン: { league: 'es', names: [/^(?:ラ・リーガ|リーガ・エスパニョーラ|プリメーラ(?:・ディビシオン)?|スペイン1部)$/] },
  イタリア: { league: 'it', names: [/^セリエ\s*A$/] },
  フランス: { league: 'fr', names: [/^リーグ(?:・)?1部?$/, /^リーグ・アン$/] },
});

export function topFlightLeague(country, leagueText) {
  const info = COUNTRY_LEAGUE[country.trim()];
  if (!info) return null;
  const normalized = leagueText.trim();
  return info.names.some((pattern) => pattern.test(normalized)) ? info.league : null;
}

/** Literal club-first tables often omit country headers.  In that layout the
 * division cell itself is the authoritative discriminator. */
export function topFlightLeagueFromDivision(leagueText) {
  const normalized = plainText(leagueText).replace(/\s+/gu, '').trim();
  if (/^(?:プレミアリーグ|プレミア)$/.test(normalized)) return 'en';
  if (/^(?:1\.ブンデス|ブンデスリーガ|ブンデス|ブンデス1部)$/.test(normalized)) return 'de';
  if (/^(?:ラ・リーガ|リーガ・エスパニョーラ|プリメーラ(?:・ディビシオン)?|スペイン1部)$/.test(normalized)) return 'es';
  if (/^セリエA$/i.test(normalized)) return 'it';
  if (/^(?:リーグ(?:・)?1部?|リーグ・アン)$/.test(normalized)) return 'fr';
  return null;
}

/** English Wikipedia division labels used by the career-statistics fallback.
 * Keep this deliberately strict so lower divisions are never inferred from a
 * club that also plays in a top flight. */
export function topFlightLeagueFromEnglishDivision(leagueText) {
  const normalized = plainText(leagueText).replace(/\s+/gu, ' ').trim();
  if (normalized === 'Premier League') return 'en';
  if (normalized === 'Bundesliga') return 'de';
  if (normalized === 'La Liga') return 'es';
  if (normalized === 'Serie A') return 'it';
  if (normalized === 'Ligue 1') return 'fr';
  return null;
}

/**
 * ja.wikipedia {{サッカー選手国内成績表 …}} career tables: a template-driven
 * wikitable (no literal {|...|}) with rowspan/colspan cells carrying
 * season/club/squad-no/league forward, and country blocks introduced by
 * {{サッカー選手国内成績表 th|<country>|...}}. Columns after the four
 * identity columns are, in order: league apps, league goals, cup apps, cup
 * goals, other apps, other goals, total apps, total goals — we keep only the
 * league pair.
 */

function findTopLevelPipe(text) {
  let braces = 0; let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') { braces += 1; index += 1; }
    else if (pair === '}}' && braces) { braces -= 1; index += 1; }
    else if (pair === '[[') { brackets += 1; index += 1; }
    else if (pair === ']]' && brackets) { brackets -= 1; index += 1; }
    else if (text[index] === '|' && !braces && !brackets) return index;
  }
  return -1;
}

function splitDoublePipe(line, delimiter = '||') {
  const cells = [];
  let start = 0; let braces = 0; let brackets = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const pair = line.slice(index, index + 2);
    if (pair === '{{') { braces += 1; index += 1; }
    else if (pair === '}}' && braces) { braces -= 1; index += 1; }
    else if (pair === '[[') { brackets += 1; index += 1; }
    else if (pair === ']]' && brackets) { brackets -= 1; index += 1; }
    else if (!braces && !brackets && pair === delimiter) { cells.push(line.slice(start, index)); start = index + 2; index += 1; }
  }
  cells.push(line.slice(start));
  return cells;
}

function parseCell(raw) {
  let text = raw.trim();
  if (text.startsWith('|')) text = text.slice(1);
  const pipe = findTopLevelPipe(text);
  if (pipe < 0) return { rowspan: 1, colspan: 1, value: text.trim() };
  const attr = text.slice(0, pipe).trim();
  const value = text.slice(pipe + 1).trim();
  const rowspan = attr.match(/rowspan\s*=\s*"?(\d+)"?/i)?.[1];
  const colspan = attr.match(/colspan\s*=\s*"?(\d+)"?/i)?.[1];
  if (!rowspan && !colspan) return { rowspan: 1, colspan: 1, value: text.trim() };
  return { rowspan: rowspan ? Number(rowspan) : 1, colspan: colspan ? Number(colspan) : 1, value };
}

const COLUMN_COUNT = 12; // season, club, no, league, then 4 apps/goals pairs
const LEAGUE_APPS_COL = 4;
const LEAGUE_GOALS_COL = 5;

/**
 * A "row" (between |- markers) can itself span several lines, each starting
 * with its own | or !, holding one or more cells (MediaWiki table syntax
 * allows either one cell per line or several joined by || on one line, and
 * articles mix both styles). Accumulate every |/!-prefixed line's cells into
 * one row, in source order — never just the row's first line.
 */
function rowsForBlock(blockText) {
  const rows = [];
  for (const block of blockText.split(/^\s*\|-.*$/m)) {
    const cells = [];
    let pending = '';
    const flush = () => {
      if (!pending) return;
      const marker = pending[0];
      const body = pending.slice(1);
      for (const part of splitDoublePipe(body, marker === '!' ? '!!' : '||')) cells.push(parseCell(part));
      pending = '';
    };
    for (const line of block.split('\n')) {
      if (/^[|!](?![}-])/.test(line.trim())) { flush(); pending = line.trim(); }
      else if (pending) pending += `\n${line}`;
    }
    flush();
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function linkTarget(cellText) {
  return extractLinks(cellText)[0]?.target ?? null;
}

function gridRows(blockText, columnCount) {
  const slots = new Array(columnCount).fill(null);
  const output = [];
  for (const cells of rowsForBlock(blockText)) {
    const values = new Array(columnCount).fill(null);
    let column = 0; let cellIndex = 0;
    while (column < columnCount) {
      if (slots[column]?.remaining > 0) {
        values[column] = slots[column].value;
        slots[column].remaining -= 1;
        if (!slots[column].remaining) slots[column] = null;
        column += 1;
        continue;
      }
      const cell = cells[cellIndex++];
      if (!cell) { column += 1; continue; }
      for (let offset = 0; offset < cell.colspan && column + offset < columnCount; offset += 1) {
        values[column + offset] = cell.value;
        if (cell.rowspan > 1) slots[column + offset] = { value: cell.value, remaining: cell.rowspan - 1 };
      }
      column += cell.colspan;
    }
    output.push(values);
  }
  return output;
}

function integerCell(value) {
  const text = plainText(value ?? '').replace(/\{\{[^{}]*\}\}/gu, '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function seasonLabel(value) {
  const text = plainText(value ?? '').trim();
  const found = text.match(/(?:19|20)\d{2}(?:\s*[–-]\s*\d{2,4})?/u);
  return found ? found[0].replace(/\s*[–-]\s*/u, '–') : null;
}

/** Club-first literal wikitables: club, season, division, league apps/goals.
 * They deliberately have no country row, so the division names above are
 * used instead. */
function parseClubFirstTables(content) {
  const output = [];
  for (const match of content.matchAll(/\{\|[^\n]*\n([\s\S]*?)\n\|\}/gu)) {
    const table = match[0];
    const header = plainText(table.slice(0, Math.min(table.length, 1200))).replace(/\s+/gu, '');
    if (!header.includes('クラブ') || !header.includes('シーズン') || !header.includes('出場') || !header.includes('得点')) continue;
    for (const values of gridRows(table, 24)) {
      const season = seasonLabel(values[1]);
      const league = values[2] ?? '';
      const leagueKey = topFlightLeagueFromDivision(league);
      const apps = integerCell(values[3]);
      const goals = integerCell(values[4]);
      if (!season || !leagueKey || apps == null || goals == null) continue;
      output.push({
        country: Object.entries(COUNTRY_LEAGUE).find(([, info]) => info.league === leagueKey)?.[0] ?? '',
        season,
        clubRaw: values[0] ?? '',
        clubTarget: linkTarget(values[0] ?? ''),
        league: plainText(league).trim(),
        apps,
        goals,
      });
    }
  }
  return output;
}

export function parseDomesticSeasons(articleText) {
  const section = sectionRanges(articleText).find((item) => /^(?:個人|選手)成績$/.test(plainText(item.title).trim()));
  if (!section) return [];
  let content = section.content.split('\n').filter((line) => !/^\{\{サッカー選手国内成績表\s+通算/.test(line.trim())).join('\n');
  // Stop at the international-record table if present in the same section.
  const intlIndex = content.indexOf('{{サッカー選手国際成績表');
  if (intlIndex >= 0) content = content.slice(0, intlIndex);

  // Country context is set either by the {{... th|country|...}} template, or
  // (when the raw table repeats its header mid-page) by a literal
  // !colspan="4"|<country>!!... header row.
  const NOT_A_COUNTRY = /^(?:国際大会|その他|通算|リーグ戦|リーグ杯|オープン杯|カップ戦|期間通算|.*(?:戦|杯|通算)$)/;
  const countryMarkers = [...content.matchAll(/^\{\{サッカー選手国内成績表\s+th\|([^|}]+)|^!\s*colspan\s*=\s*"?4"?\s*\|\s*([^|!\n]+)/gm)]
    .map((match) => ({ index: match.index, country: (match[1] ?? match[2]).trim() }))
    .filter((marker) => marker.country && !NOT_A_COUNTRY.test(marker.country));
  const seasons = [];
  for (let index = 0; index < countryMarkers.length; index += 1) {
    const { country, index: start } = countryMarkers[index];
    const end = countryMarkers[index + 1]?.index ?? content.length;
    const block = content.slice(start, end);
    for (const values of gridRows(block, COLUMN_COUNT)) {
      const seasonLabel = plainText(values[0] ?? '').trim();
      const apps = Number(plainText(values[LEAGUE_APPS_COL] ?? '').trim());
      const goals = Number(plainText(values[LEAGUE_GOALS_COL] ?? '').trim());
      if (!seasonLabel || !Number.isInteger(apps) || !Number.isInteger(goals)) continue;
      seasons.push({
        country,
        season: seasonLabel.replace(/[–-]/, '–'),
        clubRaw: values[1] ?? '',
        clubTarget: linkTarget(values[1] ?? ''),
        league: plainText(values[3] ?? '').trim(),
        apps, goals,
      });
    }
  }
  const literal = parseClubFirstTables(content);
  const unique = new Map([...seasons, ...literal].map((item) => [
    `${item.season}|${item.clubTarget ?? plainText(item.clubRaw)}|${item.league}|${item.apps}|${item.goals}`,
    item,
  ]));
  return [...unique.values()];
}

/** Parse only the league Apps/Goals pair from an en.wikipedia club career
 * table. The common table shape begins Club, Season, Division, Apps, Goals;
 * gridRows carries rowspan values forward and later cup columns are ignored. */
export function parseEnglishCareerSeasons(articleText) {
  const section = sectionRanges(articleText).find((item) => /^Career statistics$/i.test(plainText(item.title).trim()));
  if (!section) return [];
  const output = [];
  for (const match of section.content.matchAll(/\{\|[^\n]*\n([\s\S]*?)\n\|\}/gu)) {
    const table = match[0];
    const header = plainText(table.slice(0, Math.min(table.length, 1600))).replace(/\s+/gu, ' ');
    if (!/Club/i.test(header) || !/Season/i.test(header) || !/Division/i.test(header)
      || !/Apps/i.test(header) || !/Goals/i.test(header)) continue;
    for (const values of gridRows(table, 24)) {
      const season = seasonLabel(values[1]);
      const league = topFlightLeagueFromEnglishDivision(values[2] ?? '');
      const apps = integerCell(values[3]);
      const goals = integerCell(values[4]);
      if (!season || !league || apps == null || goals == null) continue;
      output.push({ season, league, clubRaw: values[0] ?? '', clubTarget: linkTarget(values[0] ?? ''), apps, goals });
    }
  }
  const unique = new Map(output.map((item) => [
    `${item.season}|${item.clubTarget ?? plainText(item.clubRaw)}|${item.league}`,
    item,
  ]));
  return [...unique.values()];
}
