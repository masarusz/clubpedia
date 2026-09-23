import { extractLinks, findTemplates, plainText, sectionRanges } from './wikitext.mjs';

const LEAGUE_SECTION_NAME = Object.freeze({
  en: /^Premier League$/i,
  es: /^La Liga$/i,
  de: /^Bundesliga$/i,
  it: /^Serie A$/i,
  fr: /^Ligue 1$/i,
});

const CUP_SECTION_NAME = /cup|shield|supercup|supercopa|coppa|coupe|champions league|europa|conference|play-?off|relegation|promotion|trophy|pokal|uefa/i;

const BOX_TEMPLATE = /^football\s*box(?:\s+collapsible)?$/i;

const MONTHS = new Map([
  ['january', 1], ['jan', 1], ['february', 2], ['feb', 2], ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4], ['may', 5], ['june', 6], ['jun', 6], ['july', 7],
  ['jul', 7], ['august', 8], ['aug', 8], ['september', 9], ['sep', 9], ['sept', 9],
  ['october', 10], ['oct', 10], ['november', 11], ['nov', 11], ['december', 12], ['dec', 12],
]);

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse the date values used by cached league football boxes. */
export function parseMatchDate(rawValue, seasonYear = null) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return null;
  const template = raw.match(/^\{\{\s*(start\s+date|dts|nowrap)\s*\|([\s\S]*?)\}\}$/i);
  if (template) {
    if (/^nowrap$/i.test(template[1])) return parseMatchDate(template[2], seasonYear);
    const numbers = template[2].split('|').map((value) => value.trim())
      .filter((value) => /^\d{1,4}$/.test(value)).map(Number);
    if (numbers.length >= 3) return isoDate(numbers[0], numbers[1], numbers[2]);
  }
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const text = plainText(raw).replace(/\s+/g, ' ').trim();
  const dmy = text.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/);
  if (dmy) {
    const month = MONTHS.get(dmy[2].toLowerCase().replace(/\.$/, ''));
    const year = dmy[3] ? Number(dmy[3]) : (seasonYear == null || !month ? null : seasonYear + (month < 7 ? 1 : 0));
    if (month && year != null) return isoDate(year, month, Number(dmy[1]));
  }
  const mdy = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!mdy) return null;
  const month = MONTHS.get(mdy[1].toLowerCase().replace(/\.$/, ''));
  return month ? isoDate(Number(mdy[3]), month, Number(mdy[2])) : null;
}

/** A European season runs 1 July through 30 June; 2019-20 extends to 31 August. */
export function dateInSeason(date, seasonYear) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const end = seasonYear === 2019 ? '2020-08-31' : `${seasonYear + 1}-06-30`;
  return date >= `${seasonYear}-07-01` && date <= end;
}

/** Sections (any level) whose title textually names this league's top flight. */
function leagueSections(articleText, league) {
  const pattern = LEAGUE_SECTION_NAME[league];
  return sectionRanges(articleText).filter((section) => pattern.test(plainText(section.title).trim()));
}

/**
 * Every {{football box}} / {{football box collapsible}} template in the
 * article that sits inside a section named after this league (never a cup,
 * shield or European section) — the 2023-24 Arsenal Community Shield box
 * (in its own "FA Community Shield" section) never matches "Premier League".
 */
export function leagueFootballBoxes(articleText, league) {
  const sections = leagueSections(articleText, league);
  const templates = findTemplates(articleText).filter((template) => BOX_TEMPLATE.test(template.name));
  const boxes = [];
  for (const template of templates) {
    const containing = sections
      .filter((section) => template.start >= section.bodyStart && template.start < section.end)
      .sort((a, b) => (b.bodyStart - a.bodyStart));
    if (!containing.length) continue;
    // Reject if a more specific (nested, non-league) section name between the
    // league section and the template looks like a cup competition.
    const roundText = plainText(template.params.round ?? '');
    if (CUP_SECTION_NAME.test(roundText)) continue;
    boxes.push(template);
  }
  return boxes;
}

function foldName(value) {
  return plainText(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(?:afc|cf|fc|cfc|sc|ac)\b/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a football-box team1/team2 raw wikitext value to a club id already
 * present in this season's table. The article's own club is often left
 * unlinked ("team1 = Arsenal"); fall back to folded-name matching against the
 * season's clubs (never guessing across clubs the season does not contain).
 */
export function resolveBoxClub(rawValue, { metadata, season, resolveClub, normalizeTitle }) {
  const link = extractLinks(rawValue)[0];
  if (link) {
    try {
      const meta = resolveClub(metadata, link.target, 'scorer box team');
      if (season.table.some((row) => row.club === meta.wikibaseItem)) return meta.wikibaseItem;
      return null;
    } catch { /* fall through to name folding below */ }
  }
  const wanted = foldName(rawValue);
  if (!wanted) return null;
  const candidates = season.table.filter((row) => {
    const names = [foldName(row.sourceTitle), foldName(row.sourceName)];
    return names.some((name) => name === wanted);
  });
  return candidates.length === 1 ? candidates[0].club : null;
}

const MINUTE = /^\d{1,3}(?:\+\d{1,2})?$/;
const PEN_FLAG = /^(?:pen\.?|penalty)$/i;
const OG_FLAG = /^(?:o\.?g\.?|og|own\s*goal)$/i;
const CARD_ONLY = /^(?:yel|red|sent\s*off|sentoff|booked|subst|substituted|inj|penmiss)$/i;

/** Goal-family templates within one scorer line: {{goal}}, {{pengoal}}, {{ogoal}}. */
function goalEventsFromTemplates(entryText) {
  const events = [];
  for (const template of findTemplates(entryText)) {
    const name = template.name.toLowerCase();
    if (name === 'goal') {
      let current = null;
      for (const key of Object.keys(template.params).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))) {
        const value = template.params[key].trim();
        if (!value) continue;
        if (MINUTE.test(value)) { current = { minute: value, isPenalty: false, ownGoal: false }; events.push(current); }
        else if (PEN_FLAG.test(value) && current) current.isPenalty = true;
        else if (OG_FLAG.test(value) && current) current.ownGoal = true;
      }
    } else if (name === 'pengoal') {
      const minute = Object.values(template.params).find((value) => MINUTE.test(value.trim()));
      events.push({ minute: minute ? minute.trim() : null, isPenalty: true, ownGoal: false });
    } else if (name === 'ogoal') {
      const minute = Object.values(template.params).find((value) => MINUTE.test(value.trim()));
      events.push({ minute: minute ? minute.trim() : null, isPenalty: false, ownGoal: true });
    }
  }
  return events;
}

/** Plain-text fallback: "Name 12'" with no {{goal}} family template on the line. */
function goalEventsFromPlainText(entryText) {
  if (CARD_ONLY.test(plainText(entryText).trim())) return [];
  if (/\{\{\s*(?:yel|red|sent\s*off|sentoff|penmiss|inj|subst)/i.test(entryText)) return [];
  const found = [...entryText.matchAll(/(\d{1,3}(?:\+\d{1,2})?)\s*[′']/g)];
  if (!found.length) return [];
  const ownGoal = /o\.?g\.?/i.test(entryText);
  const isPenalty = /\(pen\.?\)/i.test(entryText);
  return found.map((match) => ({ minute: match[1], isPenalty, ownGoal }));
}

function entryPlayer(entryText) {
  const link = extractLinks(entryText).find((item) => !/^(?:File|Image|Flag):/i.test(item.target));
  if (link) return { target: link.target, display: link.label };
  const text = plainText(entryText).replace(/\d{1,3}(?:\+\d{1,2})?\s*[′']/g, '').trim();
  return text ? { target: null, display: text } : null;
}

/**
 * Parse one side's goals1/goals2 raw wikitext into scorer events. Supports
 * bullet lists, <br>-separated single-line lists, and (when no goal-family
 * template is present on a line) a plain-text "Name 12'" fallback. Card
 * templates ({{yel}}, {{sent off}}, {{sentoff}}) never produce events.
 */
export function parseGoalSide(rawValue) {
  const value = String(rawValue ?? '');
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => line.startsWith('*'));
  const entries = [];
  if (bulletLines.length) {
    for (const line of bulletLines) entries.push(line.replace(/^\*+\s*/, ''));
  } else if (lines.length) {
    for (const line of lines) for (const part of line.split(/<br\s*\/?>/i)) if (part.trim()) entries.push(part.trim());
  }
  const scorers = [];
  for (const entry of entries) {
    const templEvents = goalEventsFromTemplates(entry);
    const events = templEvents.length ? templEvents : goalEventsFromPlainText(entry);
    if (!events.length) continue;
    const player = entryPlayer(entry);
    for (const event of events) scorers.push({ ...event, player: player?.target ?? null, display: player?.display ?? null });
  }
  return scorers;
}

function scorerKey(scorer) {
  return `${scorer.player ?? scorer.display ?? ''}|${scorer.minute ?? ''}|${scorer.isPenalty ? 1 : 0}|${scorer.ownGoal ? 1 : 0}`;
}

export function sameScorers(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].map(scorerKey).sort();
  const right = [...b].map(scorerKey).sort();
  return left.every((value, index) => value === right[index]);
}
