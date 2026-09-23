import { sectionRanges, plainText, extractLinks } from './wikitext.mjs';

/** ja.wikipedia country name -> our league key, and the top-flight division
 * label(s) used in the league cell (older articles abbreviate). A lower
 * division (e.g. "ブンデス2部") must not match -- the Okudera 1980-81 Hertha
 * trap. */
export const COUNTRY_LEAGUE = Object.freeze({
  イングランド: { league: 'en', names: [/^プレミア(?:リーグ)?$/] },
  ドイツ: { league: 'de', names: [/^ブンデス(?:リーガ|1部)$/] },
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

export function parseDomesticSeasons(articleText) {
  const section = sectionRanges(articleText).find((item) => /^個人成績$/.test(plainText(item.title).trim()));
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
    const slots = new Array(COLUMN_COUNT).fill(null);
    for (const cells of rowsForBlock(block)) {
      const values = new Array(COLUMN_COUNT).fill(null);
      let column = 0; let cellIndex = 0;
      while (column < COLUMN_COUNT) {
        if (slots[column] && slots[column].remaining > 0) {
          values[column] = slots[column].value;
          slots[column].remaining -= 1;
          column += 1;
          continue;
        }
        const cell = cells[cellIndex];
        cellIndex += 1;
        if (!cell) { column += 1; continue; }
        for (let offset = 0; offset < cell.colspan && column + offset < COLUMN_COUNT; offset += 1) values[column + offset] = cell.value;
        if (cell.rowspan > 1) slots[column] = { value: cell.value, remaining: cell.rowspan - 1 };
        column += cell.colspan;
      }
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
  return seasons;
}
