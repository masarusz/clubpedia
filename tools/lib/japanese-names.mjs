/**
 * Japanese player/club name rules, adapted from Wcupedia's
 * tools/lib/players-ja.mjs (normalizeJapaneseName, articleJapaneseName) and
 * its SPEC "Formal names for one-name players".
 */

export function normalizeJapaneseName(value) {
  return String(value || '')
    .replace(/\s*[\(（][^\(（\)）]*[\)）]\s*$/u, '')
    .replace(/・/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** ja title minus a trailing bracketed disambiguation qualifier; if the
 * qualifier states a birth year that disagrees with the player's known birth
 * year, the title is the wrong person and must be dropped, never guessed. */
export function articleJapaneseName(title, birthYear) {
  const raw = String(title || '').trim();
  const qualifier = /\s*[\(（]([^\(（\)）]*)[\)）]\s*$/u.exec(raw);
  if (qualifier) {
    const year = /(\d{4})年/u.exec(qualifier[1]);
    if (year && birthYear != null && Number(year[1]) !== Number(birthYear)) {
      return { name: null, reason: `article qualifier year ${year[1]} != birth year ${birthYear}` };
    }
  }
  return { name: normalizeJapaneseName(raw), reason: null };
}

const KATAKANA_ONLY = /^[ァ-ヺー＝\s]+$/u;

/** Korean/Chinese kanji names are unreadable for the kids: prefer the ja
 * article's own katakana rendering if given (the infobox カタカナ表記 field),
 * else fall back to the Latin name. */
export function preferKatakanaOrLatin(jaTitle, katakanaField, latin) {
  const normalizedTitle = jaTitle ? normalizeJapaneseName(jaTitle) : '';
  if (normalizedTitle && KATAKANA_ONLY.test(normalizedTitle)) {
    if (oneWordLatinName(latin, normalizedTitle.split(' '))) return { display: latin, source: 'latin-one-word' };
    return { display: normalizedTitle, source: 'ja-title-katakana' };
  }
  if (katakanaField && KATAKANA_ONLY.test(normalizeJapaneseName(katakanaField))) {
    return { display: normalizeJapaneseName(katakanaField), source: 'infobox-katakana' };
  }
  return { display: latin, source: 'latin' };
}

/** When the Latin name is a single word and the only katakana available is a
 * multi-part formal name taken from the article title, show Latin only
 * (Wcupedia SPEC "Formal names for one-name players", e.g. Dida). */
export function oneWordLatinName(latin, katakanaParts) {
  const latinWords = String(latin ?? '').trim().split(/\s+/).filter(Boolean);
  return latinWords.length === 1 && katakanaParts.length > 1;
}

/** Reading from the ja lead's first parenthesis after the bolded name, e.g.
 * '''三笘 薫'''（みとま かおる、…） -> {三笘|みとま} {薫|かおる}. Returns null
 * (never a guess) when the lead has no reading or the token counts disagree. */
export function rubyFromLead(content, expectedName) {
  const bold = /'''([^']+)'''/u.exec(content);
  if (!bold) return null;
  const kanji = bold[1].trim();
  const squash = (value) => normalizeJapaneseName(value).replace(/\s+/gu, '');
  if (expectedName && squash(kanji) !== squash(expectedName)) return null;
  const after = content.slice(bold.index + bold[0].length);
  const paren = /^\s*[（(]\s*([^、（）()]+)/u.exec(after);
  if (!paren) return null;
  const reading = paren[1].trim();
  const kanjiParts = kanji.split(/[\s　]+/u).filter(Boolean);
  const readingParts = reading.split(/[\s　]+/u).filter(Boolean);
  if (!kanjiParts.length || kanjiParts.length !== readingParts.length) return null;
  if (!readingParts.every((part) => /^[ぁ-んー]+$/u.test(part))) return null;
  return kanjiParts.map((part, index) => `{${part}|${readingParts[index]}}`).join(' ');
}
