const HEADING = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;

export const LEAGUES = Object.freeze({
  en: 'Premier League',
  es: 'La Liga',
  de: 'Bundesliga',
  it: 'Serie A',
  fr: 'Ligue 1',
});

export function seasonLabel(startYear) {
  if (!Number.isInteger(startYear) || startYear < 1000 || startYear > 9999) {
    throw new Error(`Invalid season start year: ${startYear}`);
  }
  const endYear = startYear + 1;
  const end = Math.floor(startYear / 100) === Math.floor(endYear / 100)
    ? String(endYear).slice(-2)
    : String(endYear);
  return `${startYear}\u2013${end}`;
}

export function seasonArticleTitle(league, startYear) {
  const season = seasonLabel(startYear);
  switch (league) {
    case 'en': return `${season} ${startYear <= 2006 ? 'FA Premier League' : 'Premier League'}`;
    case 'es': return `${season} La Liga`;
    case 'de': return `${season} Bundesliga`;
    case 'it': return `${season} Serie A`;
    case 'fr': return `${season} ${startYear <= 2001 ? 'French Division 1' : 'Ligue 1'}`;
    default: throw new Error(`Unknown league key: ${league}`);
  }
}

export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

export function splitTopLevel(text, separator = '|') {
  const parts = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') {
      braces += 1;
      index += 1;
    } else if (pair === '}}' && braces > 0) {
      braces -= 1;
      index += 1;
    } else if (pair === '[[') {
      brackets += 1;
      index += 1;
    } else if (pair === ']]' && brackets > 0) {
      brackets -= 1;
      index += 1;
    } else if (text[index] === separator && braces === 0 && brackets === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function topLevelEquals(text) {
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') { braces += 1; index += 1; }
    else if (pair === '}}' && braces > 0) { braces -= 1; index += 1; }
    else if (pair === '[[') { brackets += 1; index += 1; }
    else if (pair === ']]' && brackets > 0) { brackets -= 1; index += 1; }
    else if (text[index] === '=' && braces === 0 && brackets === 0) return index;
  }
  return -1;
}

/** Return every balanced template, including nested templates, in source order. */
export function findTemplates(source) {
  const text = stripComments(source);
  const stack = [];
  const found = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') {
      stack.push(index);
      index += 1;
    } else if (pair === '}}' && stack.length) {
      const start = stack.pop();
      const raw = text.slice(start, index + 2);
      const parts = splitTopLevel(raw.slice(2, -2));
      const name = (parts.shift() ?? '').trim();
      const params = {};
      let positional = 1;
      for (const part of parts) {
        const equals = topLevelEquals(part);
        if (equals === -1) params[String(positional++)] = part.trim();
        else params[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
      }
      found.push({ start, end: index + 2, raw, name, params });
      index += 1;
    }
  }
  return found.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function parseTemplate(raw) {
  const templates = findTemplates(raw);
  const exact = templates.find((entry) => entry.start === 0 && entry.end === stripComments(raw).length);
  if (!exact) throw new Error('Expected one balanced template');
  return exact;
}

export function extractLinks(text) {
  const links = [];
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  for (const match of text.matchAll(regex)) {
    const target = match[1].trim().replace(/_/g, ' ');
    if (!target || /^(?:File|Image|Category|Help|Portal|Template):/i.test(target)) continue;
    links.push({ target, label: (match[2] ?? match[1]).trim() });
  }
  return links;
}

function normalizedTemplateName(name) {
  return name.replace(/^Template\s*:/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function discoverDataTemplates(text, expectedSeason = '') {
  const season = expectedSeason.match(/^\d{4}[\u2013-](?:\d{2}|\d{4})/)?.[0] ?? expectedSeason;
  const comparableSeason = season.replace(/-/g, '\u2013');
  const output = new Set();
  for (const template of findTemplates(text)) {
    const name = normalizedTemplateName(template.name);
    if (!name || name.startsWith('#') || name.includes('{{')) continue;
    if (!/(?:table|results?)/i.test(name)) continue;
    if (season && !name.replace(/-/g, '\u2013').includes(comparableSeason)) continue;
    output.add(`Template:${name}`);
  }
  return [...output].sort();
}

export function hasSportsTable(text) {
  return /\{\{\s*#invoke\s*:\s*sports\s+table\s*\|/i.test(stripComments(text));
}

export function hasSportsResults(text) {
  return /\{\{\s*#invoke\s*:\s*sports\s+results\s*\|/i.test(stripComments(text));
}

function cleanPlainName(value) {
  return value
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
    .replace(/<ref\b[^/>]*\/\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .trim();
}

export function extractTableClubs(text) {
  const tables = findTemplates(text).filter((template) => /^#invoke\s*:\s*sports\s+table$/i.test(template.name));
  const clubs = [];
  for (const table of tables) {
    let codes = [];
    const orderKey = Object.keys(table.params).find((key) => key.toLowerCase() === 'team_order');
    if (orderKey) codes = table.params[orderKey].split(',').map((code) => code.trim()).filter(Boolean);
    if (!codes.length) {
      codes = Object.entries(table.params)
        .filter(([key]) => /^team\d+$/i.test(key))
        .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)))
        .map(([, code]) => code.trim())
        .filter(Boolean);
    }
    for (const code of codes) {
      const nameKey = Object.keys(table.params).find((key) => key.trim().toLowerCase() === `name_${code}`.toLowerCase());
      if (!nameKey) continue;
      const raw = table.params[nameKey];
      const link = extractLinks(raw)[0];
      const target = link?.target ?? cleanPlainName(raw);
      const label = link?.label ?? cleanPlainName(raw);
      if (target) clubs.push({ code, target, label, linked: Boolean(link) });
    }
  }
  const seen = new Set();
  return clubs.filter((club) => !seen.has(club.target) && seen.add(club.target));
}

export function clubSeasonTitle(startYear, clubArticleTitle) {
  return `${seasonLabel(startYear)} ${clubArticleTitle.trim()} season`;
}

export function sectionRanges(text) {
  const headings = [...text.matchAll(HEADING)].map((match) => ({
    start: match.index,
    bodyStart: match.index + match[0].length,
    level: match[1].length,
    title: match[2].replace(/'{2,}/g, '').trim(),
  }));
  return headings.map((heading, index) => {
    let end = text.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].start; break; }
    }
    return { ...heading, end, content: text.slice(heading.bodyStart, end) };
  });
}

/** Convert the small subset of wikitext used in data labels and notes to text. */
export function plainText(value = '') {
  let text = stripComments(String(value));
  text = text
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
    .replace(/<ref\b[^/>]*\/\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1');
  // Resolve innermost templates repeatedly. Formatting templates retain their
  // useful argument; citations, flags and references disappear.
  for (let pass = 0; pass < 8 && /\{\{[^{}]*\}\}/.test(text); pass += 1) {
    text = text.replace(/\{\{([^{}]*)\}\}/g, (_whole, body) => {
      const parts = splitTopLevel(body).map((part) => part.trim());
      const name = (parts.shift() ?? '').toLowerCase();
      if (/^(?:small|nowrap|nobr|center|sort|sortname|abbr|tooltip|0|color box|font color)$/.test(name)) {
        return parts.filter((part) => !part.includes('=')).at(-1) ?? '';
      }
      if (/^(?:convert|formatnum)$/.test(name)) return parts[0] ?? '';
      return '';
    });
  }
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_whole, target, label) => label ?? target);
  return text.replace(/'{2,}/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function splitCells(line, delimiter) {
  const cells = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const pair = line.slice(index, index + 2);
    if (pair === '{{') { braces += 1; index += 1; }
    else if (pair === '}}' && braces) { braces -= 1; index += 1; }
    else if (pair === '[[') { brackets += 1; index += 1; }
    else if (pair === ']]' && brackets) { brackets -= 1; index += 1; }
    else if (!braces && !brackets && pair === delimiter) {
      cells.push(line.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  cells.push(line.slice(start));
  return cells;
}

function cellValue(raw) {
  const value = raw.trim();
  // Cell attributes precede a single pipe. Do not mistake pipes in links or
  // templates for the attribute separator.
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pair = value.slice(index, index + 2);
    if (pair === '{{') { braces += 1; index += 1; }
    else if (pair === '}}' && braces) { braces -= 1; index += 1; }
    else if (pair === '[[') { brackets += 1; index += 1; }
    else if (pair === ']]' && brackets) { brackets -= 1; index += 1; }
    else if (value[index] === '|' && !braces && !brackets) return value.slice(index + 1).trim();
  }
  return value;
}

/** A deliberately small wikitable reader: rows and raw cells, with markup intact. */
export function parseWikitables(source) {
  const tables = [];
  for (const match of stripComments(source).matchAll(/^\{\|[^\n]*\n([\s\S]*?)^\|\}\s*$/gm)) {
    const rows = [];
    for (const block of match[1].split(/^\s*\|-.*$/m)) {
      const cells = [];
      let pending = '';
      const flush = () => {
        if (!pending) return;
        const marker = pending[0];
        const body = pending.slice(1);
        for (const part of splitCells(body, marker === '!' ? '!!' : '||')) cells.push(cellValue(part));
        pending = '';
      };
      for (const line of block.split('\n')) {
        if (/^[|!](?![}|])/.test(line)) { flush(); pending = line; }
        else if (pending) pending += `\n${line}`;
      }
      flush();
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function plausiblePersonTarget(target) {
  return !/^(?:\d{4}(?:\u2013|-)|List of |Premier League|La Liga|Bundesliga|Serie A|Ligue 1|Association football|[A-Z][^.]+ F\.C\.|[A-Z][^.]+ FC$)/i.test(target);
}

export function extractPlayerLinks(text, { topScorerPage = false } = {}) {
  const targets = new Set();
  for (const template of findTemplates(text)) {
    for (const [key, value] of Object.entries(template.params)) {
      if (/^goals[12]$/i.test(key.trim())) {
        for (const { target } of extractLinks(value)) if (plausiblePersonTarget(target)) targets.add(target);
      }
    }
  }
  const relevantSections = sectionRanges(text).filter((section) => /top\s*(?:goal)?scorers?|goalscorers?|winners?/i.test(section.title));
  if (topScorerPage && !relevantSections.length) relevantSections.push({ content: text });
  for (const section of relevantSections) {
    for (const { target } of extractLinks(section.content)) if (plausiblePersonTarget(target)) targets.add(target);
  }
  return [...targets].sort();
}

export function extractJapanesePlayerLinks(text) {
  const sections = sectionRanges(text).filter((section) => {
    const title = cleanPlainName(section.title).replace(/\s+/g, ' ').trim();
    return /^Japan(?:ese)?$/i.test(title);
  });
  const targets = new Set();
  for (const section of sections) {
    for (const row of section.content.split('\n').filter((line) => /^\s*\*/.test(line))) {
      const link = extractLinks(row)[0];
      if (link && plausiblePersonTarget(link.target)) targets.add(link.target);
    }
    if (/^\s*\{\|/m.test(section.content)) {
      for (const row of section.content.split(/\n\s*\|-/)) {
        const link = extractLinks(row)[0];
        if (link && plausiblePersonTarget(link.target)) targets.add(link.target);
      }
    }
  }
  return [...targets].sort();
}

export function discoverLigueOneListPages(text) {
  return [...new Set(extractLinks(text)
    .map(({ target }) => target)
    .filter((target) => /^List of foreign Ligue 1 players:\s*[^/]+$/i.test(target)))]
    .sort();
}
