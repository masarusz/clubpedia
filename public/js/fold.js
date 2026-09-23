export function fold(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCodePoint(char.codePointAt(0) - 0x60))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .replace(/[øæœßłđðþı]/g, (char) => ({
      ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i',
    })[char])
    .replace(/['’.]/g, '')
    .replace(/[-・･_\s]/gu, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function foldCompact(value) {
  return fold(value).replace(/ /g, '');
}
