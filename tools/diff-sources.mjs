#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableJson } from './lib/source-api.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'public/data/s');
const CACHE = join(ROOT, '.cache/sources');
const REPORT = join(ROOT, 'reports/diff-sources.txt');
const OF_NAMES = { en: 'en.1.json', es: 'es.1.json', de: 'de.1.json', it: 'it.1.json', fr: 'fr.1.json' };

function aggregate(matches) {
  const teams = new Map();
  const get = (name) => { if (!teams.has(name)) teams.set(name, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }); return teams.get(name); };
  for (const match of matches) {
    const home = get(match.home); const away = get(match.away); const hg = match.hg; const ag = match.ag;
    home.p += 1; away.p += 1; home.gf += hg; home.ga += ag; away.gf += ag; away.ga += hg;
    if (hg > ag) { home.w += 1; away.l += 1; } else if (hg < ag) { away.w += 1; home.l += 1; } else { home.d += 1; away.d += 1; }
  }
  return [...teams.values()].map((row) => `${row.p}/${row.w}/${row.d}/${row.l}/${row.gf}/${row.ga}`).sort();
}

function tableMultiset(season) { return season.table.map((row) => `${row.w + row.d + row.l}/${row.w}/${row.d}/${row.l}/${row.gf}/${row.ga}`).sort(); }
function same(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
async function exists(path) { try { await readFile(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

const lines = ['Clubpedia source comparison', 'Method: name-free sorted multisets of P/W/D/L/GF/GA.', ''];
const roots = (await readdir(join(CACHE, 'openfootball'))).sort();
const ofRoot = join(CACHE, 'openfootball', roots[0]);
for (let year = 2010; year <= 2023; year += 1) for (const league of Object.keys(OF_NAMES)) {
  const label = `${year}-${String(year + 1).slice(-2)}`;
  const path = join(ofRoot, label, OF_NAMES[league]);
  if (!(await exists(path))) { lines.push(`openfootball ${league}-${year}: missing cross-check file`); continue; }
  const source = JSON.parse(await readFile(path, 'utf8'));
  const season = JSON.parse(await readFile(join(DATA, `${league}-${year}.json`), 'utf8'));
  const matches = source.matches.filter((match) => Array.isArray(match.score?.ft)).map((match) => ({ home: match.team1, away: match.team2, hg: Number(match.score.ft[0]), ag: Number(match.score.ft[1]) }));
  const actual = aggregate(matches); const expected = tableMultiset(season);
  if (!same(actual, expected)) lines.push(`openfootball ${league}-${year}: DIFFERENT clubs=${actual.length}/${expected.length}, played=${matches.length}`);
}
for (let year = 2008; year <= 2025; year += 1) {
  const source = JSON.parse(await readFile(join(CACHE, 'openligadb', `bl1-${year}.json`), 'utf8'));
  const season = JSON.parse(await readFile(join(DATA, `de-${year}.json`), 'utf8'));
  const matches = source.filter((match) => match.matchIsFinished).flatMap((match) => {
    const result = (match.matchResults ?? []).find((item) => item.resultTypeKind === 'After90Minutes')
      ?? [...(match.matchResults ?? [])].sort((a, b) => b.resultOrderID - a.resultOrderID)[0];
    return result ? [{ home: match.team1.teamName, away: match.team2.teamName, hg: result.pointsTeam1, ag: result.pointsTeam2 }] : [];
  });
  const actual = aggregate(matches); const expected = tableMultiset(season);
  if (!same(actual, expected)) lines.push(`OpenLigaDB de-${year}: DIFFERENT clubs=${actual.length}/${expected.length}, played=${matches.length}`);
}
if (lines.length === 3) lines.push('No differences.');
await mkdir(join(ROOT, 'reports'), { recursive: true });
await writeFile(REPORT, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
