import { fold } from '../../public/js/fold.js';

const TARGET_TYPES = new Set(['club', 'player', 'league', 'page']);
const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && fold(value)))];

export function mergeSearchAliases(entries, aliases) {
  if (!Array.isArray(aliases)) throw new Error('malformed search aliases: expected an array');
  const targets = new Map(entries.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const additions = new Map();
  for (const item of aliases) {
    if (!item || typeof item !== 'object' || !TARGET_TYPES.has(String(item.target).split(':')[0])
      || !targets.has(item.target) || !item.reason || !Array.isArray(item.aliases) || !item.aliases.length) {
      throw new Error(`malformed search alias ${JSON.stringify(item)}`);
    }
    additions.set(item.target, unique(item.aliases));
  }
  return entries.map((entry) => {
    const extra = additions.get(`${entry.type}:${entry.id}`);
    return extra ? { ...entry, keys: unique([...entry.keys, ...extra]) } : entry;
  });
}
