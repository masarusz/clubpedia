const REQUIRED_HEADERS = ['Pos', 'Team', 'Pld', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'];
const OPTIONAL_HEADERS = new Set(['Qualification or relegation', 'Qualification, relegation or play-offs', 'QR']);

function decodeHtml(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ndash: '–', minus: '−' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const number = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function text(html) {
  return decodeHtml(String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\[[a-z]\]/gi, '').replace(/\s+/g, ' ').trim();
}

function attribute(markup, name) {
  const match = markup.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3]) : null;
}

function cells(row) {
  return [...row.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((match) => ({
    kind: match[1].toLowerCase(), attributes: match[2], html: match[3], value: text(match[3]),
  }));
}

function integer(value, context) {
  const normalized = value.replace(/^[−–]/, '-').replace(/^\+/, '');
  if (!/^-?\d+$/.test(normalized)) throw new Error(`${context}: expected integer in ${JSON.stringify(value)}`);
  return Number(normalized);
}

function referenceNotes(html) {
  const notes = new Map();
  for (const match of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const id = attribute(match[1], 'id');
    if (id?.startsWith('cite_note-')) notes.set(`#${id}`, text(match[2]).replace(/^\^\s*/, '').trim());
  }
  return notes;
}

function teamLink(cell, context) {
  for (const match of cell.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const title = attribute(match[1], 'title');
    const href = attribute(match[1], 'href');
    if (title && href?.startsWith('/wiki/') && !href.includes('#')) return { title, name: text(match[2]) };
  }
  throw new Error(`${context}: Team cell has no article link`);
}

function deductionReason(cell, notes) {
  for (const match of cell.html.matchAll(/<a\b([^>]*)>/gi)) {
    const href = attribute(match[1], 'href');
    if (href && notes.has(href)) return notes.get(href);
  }
  return null;
}

/** Parse one MediaWiki-rendered Sports table without trusting browser HTML recovery. */
export function parseRenderedStandings(html, { context = 'rendered standings', expectedClubs, pointSystem = { win: 3, draw: 1, loss: 0 } } = {}) {
  if (typeof html !== 'string') throw new Error(`${context}: rendered HTML is missing`);
  const candidates = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)]
    .filter((match) => /(?:^|\s)wikitable(?:\s|$)/i.test(attribute(match[1], 'class') ?? ''));
  const matches = candidates.map((match) => {
    const rows = [...match[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => cells(row[1]));
    return { html: match[0], rows, headerIndex: rows.findIndex((row) => row.map((cell) => cell.value).join('|').startsWith('Pos|Team|')) };
  }).filter((table) => table.headerIndex >= 0);
  if (matches.length !== 1) throw new Error(`${context}: expected exactly one standings wikitable, found ${matches.length}`);
  const table = matches[0];
  const headers = table.rows[table.headerIndex].map((cell) => cell.value);
  if (headers.slice(0, REQUIRED_HEADERS.length).join('|') !== REQUIRED_HEADERS.join('|')) {
    throw new Error(`${context}: columns are ${headers.join(', ')}; expected ${REQUIRED_HEADERS.join(', ')}`);
  }
  const extras = headers.slice(REQUIRED_HEADERS.length);
  if (extras.some((header) => !OPTIONAL_HEADERS.has(header)) || extras.length > 1) {
    throw new Error(`${context}: unexpected columns ${extras.join(', ') || '(none)'}`);
  }
  const notes = referenceNotes(html);
  const dataRows = table.rows.slice(table.headerIndex + 1).filter((row) => row.some((cell) => cell.kind === 'td'));
  if (Number.isInteger(expectedClubs) && dataRows.length !== expectedClubs) {
    throw new Error(`${context}: row count ${dataRows.length} does not match clubs ${expectedClubs}`);
  }
  const seenPositions = new Set();
  return dataRows.map((row, rowIndex) => {
    // The optional qualification column uses rowspan, so subsequent rows can
    // legitimately omit that final cell. Required statistical cells never do.
    if (row.length < REQUIRED_HEADERS.length || row.length > headers.length) {
      throw new Error(`${context}: row ${rowIndex + 1} has ${row.length} cells; expected ${REQUIRED_HEADERS.length}${headers.length === REQUIRED_HEADERS.length ? '' : ` or ${headers.length}`}`);
    }
    const values = Object.fromEntries(REQUIRED_HEADERS.filter((header) => header !== 'Team').map((header) => {
      const index = REQUIRED_HEADERS.indexOf(header);
      return [header, integer(row[index].value, `${context} row ${rowIndex + 1} ${header}`)];
    }));
    const team = teamLink(row[1], `${context} row ${rowIndex + 1}`);
    if (seenPositions.has(values.Pos)) throw new Error(`${context}: duplicate position ${values.Pos}`);
    seenPositions.add(values.Pos);
    if (values.Pld !== values.W + values.D + values.L) throw new Error(`${context} ${team.title}: Pld does not equal W+D+L`);
    if (values.GD !== values.GF - values.GA) throw new Error(`${context} ${team.title}: GD does not equal GF-GA`);
    const expectedPoints = values.W * pointSystem.win + values.D * pointSystem.draw + values.L * pointSystem.loss;
    const adjustment = values.Pts - expectedPoints;
    const reason = deductionReason(row[1], notes);
    if (adjustment && !reason) throw new Error(`${context} ${team.title}: points adjustment ${adjustment} has no note`);
    return {
      position: values.Pos, teamTitle: team.title, teamName: team.name, pld: values.Pld,
      w: values.W, d: values.D, l: values.L, gf: values.GF, ga: values.GA, gd: values.GD,
      points: values.Pts, adjustment, adjustmentReason: reason,
    };
  });
}
