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

export function seasonYear(seasonId) {
  const match = /-(\d{4})$/.exec(String(seasonId));
  return match ? Number(match[1]) : null;
}

export function birthDateLabel(value) {
  if (!value) return null;
  if (value.length === 4) return `${Number(value)}年生まれ`;
  if (value.length === 7) return `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月生まれ`;
  if (value.length === 10) return `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日生まれ`;
  return null;
}

export function topScorerFinish(rank) {
  if (!rank) return null;
  return rank === 1 ? '得点王' : `${rank}位`;
}
