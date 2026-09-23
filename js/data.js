import { VERSION } from './version.js?v=0.3.0';

const cache = new Map();

async function load(path, { optional = false } = {}) {
  if (cache.has(path)) return cache.get(path);
  const pending = fetch(`${path}?v=${VERSION}`).then(async (response) => {
    if (!response.ok) {
      if (optional && response.status === 404) return null;
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    const value = await response.json();
    if (!value || typeof value !== 'object') throw new Error(`${path}: invalid JSON root`);
    return value;
  }).catch((error) => {
    cache.delete(path);
    throw error;
  });
  cache.set(path, pending);
  return pending;
}

export const loadIndex = () => load('data/index.json');
export const loadNames = () => load('data/names.json');
export const loadHistory = (league) => load(`data/h/${league}.json`);
export const loadSeason = (league, year) => load(`data/s/${league}-${year}.json`);
export const loadClub = (id) => load(`data/c/${id}.json`);
export const loadOpenLiga = (league, year) => load(`data/o/${league}-${year}.json`, { optional: true });
export const loadDay = (monthDay) => load(`data/days/${monthDay}.json`, { optional: true });
export const loadPhotoCredits = () => load('data/photo-credits.json');
export const loadJapan = () => load('data/japan.json');
export const loadRankings = () => load('data/rankings.json');
export const loadSearch = () => load('data/search.json');

export function playerBucket(id) {
  return String(Math.abs([...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0)) % 64).padStart(2, '0');
}

export async function loadPlayers(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  const bucketIds = [...new Set(wanted.map(playerBucket))];
  const files = await Promise.all(bucketIds.map((bucket) => load(`data/p/${bucket}.json`)));
  const combined = Object.assign({}, ...files);
  return Object.fromEntries(wanted.map((id) => [id, combined[id] ?? null]));
}

export async function loadClubs(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  return Object.fromEntries(await Promise.all(wanted.map(async (id) => [id, await loadClub(id)])));
}

export function clearDataCache() {
  cache.clear();
}
