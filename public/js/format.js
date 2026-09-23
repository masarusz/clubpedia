export function seasonLabel(year) {
  const start = Number(year);
  return `${start}–${String((start + 1) % 100).padStart(2, '0')}シーズン`;
}

export function signed(value) {
  return Number(value) > 0 ? `+${value}` : String(value);
}

export function playerName(player, fallback = null) {
  if (!player) return fallback ?? '記録なし';
  if (player.ja?.mode === 'kanji') return player.ja.kanji;
  if (player.ja?.display) return player.ja.display;
  return player.en ?? fallback ?? player.id;
}

export function minuteLabel(value) {
  return value == null || value === '' ? '' : `${value}分`;
}
