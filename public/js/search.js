import { fold, foldCompact } from './fold.js?v=0.3.2';

const TYPE_ORDER = Object.freeze({ league: 0, club: 1, player: 2, page: 3 });
const SMALL_KANA = Object.freeze({
  'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
  'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ', 'ゔ': 'ぶ',
});

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const characterCount = (value) => [...value].length;
const containsKana = (value) => /[ぁ-ゖ]/u.test(value);
const loose = (value) => value.replace(/[っー]/gu, '').replace(/[ぁぃぅぇぉゃゅょゎゔ]/gu, (character) => SMALL_KANA[character]);

function preparedKey(value) {
  const folded = fold(value);
  const words = folded.split(' ').filter(Boolean);
  const compact = foldCompact(folded);
  const looseWords = words.map(loose).filter(Boolean);
  return { words, compact, looseWords, looseCompact: loose(compact) };
}

export function prepareIndex(entries) {
  if (!Array.isArray(entries)) throw new TypeError('search entries must be an array');
  return Object.freeze(entries.map((entry) => Object.freeze({
    entry,
    labelKey: foldCompact(entry.label),
    keys: entry.keys.map(preparedKey),
  })));
}

function tierFor(keys, foldedQuery, compactQuery, isLoose) {
  const compactName = isLoose ? 'looseCompact' : 'compact';
  const wordsName = isLoose ? 'looseWords' : 'words';
  if (keys.some((key) => key[compactName] === compactQuery)) return 0;
  if (keys.some((key) => key[wordsName].includes(foldedQuery))) return 1;
  if (keys.some((key) => key[compactName].startsWith(compactQuery)
    || key[wordsName].some((word) => word.startsWith(compactQuery)))) return 2;
  if (characterCount(compactQuery) >= 2 && keys.some((key) => key[compactName].includes(compactQuery))) return 3;
  return null;
}

export function search(index, query, { limit = 30 } = {}) {
  const foldedQuery = fold(query);
  const compactQuery = foldCompact(foldedQuery);
  if (!compactQuery || limit <= 0) return [];
  const allowLoose = containsKana(foldedQuery) && characterCount(loose(compactQuery)) >= 2;
  const looseFoldedQuery = loose(foldedQuery);
  const looseCompactQuery = loose(compactQuery);
  const matches = [];
  for (const item of index) {
    let tier = tierFor(item.keys, foldedQuery, compactQuery, false);
    if (tier === null && allowLoose) {
      const looseTier = tierFor(item.keys, looseFoldedQuery, looseCompactQuery, true);
      if (looseTier !== null) tier = looseTier + 10;
    }
    if (tier !== null) matches.push({ ...item, tier });
  }
  matches.sort((left, right) => left.tier - right.tier
    || TYPE_ORDER[left.entry.type] - TYPE_ORDER[right.entry.type]
    || (left.entry.type === 'player' ? (right.entry.goals ?? 0) - (left.entry.goals ?? 0)
      || Number(Boolean(right.entry.japan)) - Number(Boolean(left.entry.japan)) : 0)
    || (left.entry.type === 'club' ? (right.entry.titles ?? 0) - (left.entry.titles ?? 0) : 0)
    || compare(left.labelKey, right.labelKey)
    || compare(left.entry.id, right.entry.id));
  return matches.slice(0, limit).map(({ entry, tier }) => ({ ...entry, tier }));
}
