#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const DATA_PREFIX = 'public/data/';
const ROW_FIELDS = ['position', 'club', 'points', 'w', 'd', 'l', 'gf', 'ga', 'adjustment'];

function json(value) { return JSON.stringify(value); }
function selectedRow(row) { return Object.fromEntries(ROW_FIELDS.map((field) => [field, row?.[field] ?? null])); }
function played(season) { return (season?.matches ?? []).filter((match) => match.status === 'played').length; }
function tablePlayed(row) { return row?.played ?? ((row?.w ?? 0) + (row?.d ?? 0) + (row?.l ?? 0)); }
function seasonCoverage(season) {
  const matches = season?.matches ?? [];
  return {
    dates: matches.filter((match) => Boolean(match.date)).length,
    scorers: matches.filter((match) => match.scorers != null).length,
  };
}

async function filesUnder(root, prefix = '') {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else output.push(relative(root, path).split('\\').join('/'));
    }
  }
  try { await walk(join(root, prefix)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output.sort();
}

export async function directoryDataset(root) {
  const files = await filesUnder(root);
  return new Map(await Promise.all(files.filter((name) => name.endsWith('.json')).map(async (name) => [
    name,
    JSON.parse(await readFile(join(root, name), 'utf8')),
  ])));
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 200, ...options });
}

function newestTag() {
  const tag = git(['tag', '--list', 'v*', '--sort=-version:refname']).trim().split('\n').find(Boolean);
  if (!tag) throw new Error('No v* tag exists; pass --base <git-ref>');
  return tag;
}

export function gitDataset(ref) {
  git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const names = git(['ls-tree', '-r', '--name-only', ref, '--', 'public/data']).trim().split('\n').filter((name) => name.endsWith('.json'));
  return new Map(names.map((name) => [name.slice(DATA_PREFIX.length), JSON.parse(git(['show', `${ref}:${name}`]))]));
}

function seasonMap(dataset) {
  return new Map([...dataset].filter(([name]) => /^s\/[^/]+\.json$/.test(name)).map(([, value]) => [value.id, value]));
}

function playerMap(dataset) {
  const players = new Map();
  for (const [name, bucket] of dataset) {
    if (!/^p\/[^/]+\.json$/.test(name)) continue;
    for (const [id, player] of Object.entries(bucket)) players.set(id, player);
  }
  return players;
}

function accepted(entries, season, kind, club, from, to) {
  return entries.some((entry) => entry.season === season && entry.kind === kind
    && (kind !== 'table-row' || entry.club === club)
    && isDeepStrictEqual(entry.from, from) && isDeepStrictEqual(entry.to, to)
    && typeof entry.reason === 'string' && entry.reason.trim()
    && typeof entry.reviewedBy === 'string' && entry.reviewedBy.trim());
}

function japanName(player) { return { en: player.en ?? null, ja: player.ja ?? null }; }
function completedJapanSeasons(player, seasons) {
  return (player.seasons ?? []).filter((record) => {
    const year = Number(String(record.season).match(/^(\d{4})/)?.[1]);
    const season = seasons.get(`${record.league}-${year}`);
    return season && season.inProgress !== true;
  });
}

export function compareDatasets(base, current, acceptedChanges = [], { syntheticHold = false, baseLabel = 'base' } = {}) {
  const rules = [];
  const rises = [];
  const addRule = (number, title, holds, evidence) => rules.push({ number, title, status: holds.length ? 'HOLD' : 'PASS', evidence: [...holds, ...evidence] });
  const oldSeasons = seasonMap(base);
  const newSeasons = seasonMap(current);

  {
    const holds = [];
    const evidence = [];
    let compared = 0;
    for (const [id, before] of oldSeasons) {
      if (before.inProgress === true) continue;
      const after = newSeasons.get(id);
      if (!after) { holds.push(`${id}: completed season file removed`); continue; }
      compared += 1;
      if (!isDeepStrictEqual(before.champion, after.champion)) {
        if (accepted(acceptedChanges, id, 'champion', undefined, before.champion, after.champion)) evidence.push(`${id}: accepted exact champion change ${json(before.champion)} -> ${json(after.champion)}`);
        else holds.push(`${id}: champion ${json(before.champion)} -> ${json(after.champion)}`);
      }
      if (before.matches.length !== after.matches.length) {
        if (accepted(acceptedChanges, id, 'match-count', undefined, before.matches.length, after.matches.length)) evidence.push(`${id}: accepted exact match-count change ${before.matches.length} -> ${after.matches.length}`);
        else holds.push(`${id}: match count ${before.matches.length} -> ${after.matches.length}`);
      }
      const oldRows = new Map((before.table ?? []).map((row) => [row.club, selectedRow(row)]));
      const newRows = new Map((after.table ?? []).map((row) => [row.club, selectedRow(row)]));
      for (const club of new Set([...oldRows.keys(), ...newRows.keys()])) {
        const from = oldRows.get(club) ?? null;
        const to = newRows.get(club) ?? null;
        if (!isDeepStrictEqual(from, to)) {
          if (accepted(acceptedChanges, id, 'table-row', club, from, to)) evidence.push(`${id} ${club}: accepted exact table-row change ${json(from)} -> ${json(to)}`);
          else holds.push(`${id} ${club}: table row ${json(from)} -> ${json(to)}`);
        }
      }
    }
    addRule(1, 'Completed seasons are unchanged or exactly accepted', holds, [`${compared} completed season(s) compared with ${baseLabel}`, ...evidence]);
  }

  {
    const holds = [];
    let compared = 0;
    for (const [id, before] of oldSeasons) {
      const after = newSeasons.get(id);
      if (!after) continue;
      compared += 1;
      const a = seasonCoverage(before); const b = seasonCoverage(after);
      for (const key of ['scorers', 'dates']) {
        const change = b[key] - a[key];
        if (change < -2) holds.push(`${id}: matches with ${key} ${a[key]} -> ${b[key]} (drop ${-change})`);
        else if (change > 0) rises.push(`${id}: matches with ${key} rose ${a[key]} -> ${b[key]}`);
      }
    }
    addRule(2, 'Scorer/date coverage drops by at most 2 per season', holds, [`${compared} season(s) compared`]);
  }

  const oldPlayers = playerMap(base); const newPlayers = playerMap(current);
  {
    const threshold = oldPlayers.size * 0.995;
    const holds = newPlayers.size + Number.EPSILON < threshold
      ? [`total players ${oldPlayers.size} -> ${newPlayers.size}; minimum allowed ${Math.ceil(threshold)}`] : [];
    if (newPlayers.size > oldPlayers.size) rises.push(`total players rose ${oldPlayers.size} -> ${newPlayers.size}`);
    addRule(3, 'Total players drop by no more than 0.5%', holds, [`${oldPlayers.size} -> ${newPlayers.size}`]);
  }

  {
    const holds = [];
    const oldJapan = new Map((base.get('japan.json')?.players ?? []).map((player) => [player.id, player]));
    const newJapan = new Map((current.get('japan.json')?.players ?? []).map((player) => [player.id, player]));
    for (const [id, before] of oldJapan) {
      const after = newJapan.get(id);
      if (!after) { holds.push(`${id}: Japanese player removed`); continue; }
      if (!isDeepStrictEqual(japanName(before), japanName(after))) holds.push(`${id}: name changed ${json(japanName(before))} -> ${json(japanName(after))}`);
      const from = completedJapanSeasons(before, oldSeasons);
      const to = completedJapanSeasons(after, newSeasons);
      if (!isDeepStrictEqual(from, to)) holds.push(`${id}: completed-season records changed ${json(from)} -> ${json(to)}`);
    }
    if (newJapan.size > oldJapan.size) rises.push(`Japanese players rose ${oldJapan.size} -> ${newJapan.size}`);
    addRule(4, 'Japanese players and completed-season history are preserved', holds, [`${oldJapan.size} base Japanese player(s) checked`]);
  }

  {
    const holds = [];
    let compared = 0; let newCount = 0;
    for (const [id, after] of newSeasons) {
      if (after.inProgress !== true) continue;
      const before = oldSeasons.get(id);
      if (!before) { newCount += 1; continue; }
      compared += 1;
      const oldPlayed = played(before); const newPlayed = played(after);
      if (newPlayed < oldPlayed) holds.push(`${id}: played matches ${oldPlayed} -> ${newPlayed}`);
      else if (newPlayed > oldPlayed) rises.push(`${id}: played matches rose ${oldPlayed} -> ${newPlayed}`);
      const oldRows = new Map((before.table ?? []).map((row) => [row.club, tablePlayed(row)]));
      const newRows = new Map((after.table ?? []).map((row) => [row.club, tablePlayed(row)]));
      for (const [club, from] of oldRows) {
        if (!newRows.has(club)) { holds.push(`${id} ${club}: table row removed (played was ${from})`); continue; }
        const to = newRows.get(club);
        if (to < from) holds.push(`${id} ${club}: table played ${from} -> ${to}`);
        else if (to > from) rises.push(`${id} ${club}: table played rose ${from} -> ${to}`);
      }
    }
    addRule(5, 'In-progress played counts are non-decreasing', holds, [`${compared} existing and ${newCount} new in-progress season(s)`]);
  }

  {
    const before = Object.keys(base.get('photo-credits.json') ?? {}).length;
    const after = Object.keys(current.get('photo-credits.json') ?? {}).length;
    const holds = before - after > 5 ? [`photos ${before} -> ${after} (drop ${before - after})`] : [];
    if (after > before) rises.push(`photos rose ${before} -> ${after}`);
    addRule(6, 'Photo count drops by no more than 5', holds, [`${before} -> ${after}`]);
  }

  if (syntheticHold) rules.push({ number: 'synthetic', title: 'Forced HOLD test rule', status: 'HOLD', evidence: ['--synthetic-hold requested; data was not changed'] });
  return { hold: rules.some((rule) => rule.status === 'HOLD'), rules, rises };
}

export function renderReport(result, { base, generated = new Date().toISOString() }) {
  const lines = ['Clubpedia monthly refresh guard', `Base: ${base}`, `Generated: ${generated}`, `Outcome: ${result.hold ? 'HOLD' : 'PASS'}`, ''];
  for (const rule of result.rules) {
    lines.push(`[${rule.status}] Rule ${rule.number}: ${rule.title}`);
    for (const item of rule.evidence) lines.push(`  - ${item}`);
  }
  lines.push('', 'Counts that rose (informational only)');
  if (result.rises.length) for (const item of result.rises) lines.push(`  - ${item}`);
  else lines.push('  - none');
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  let base; let report = join(ROOT, 'reports/refresh-guard.txt'); let syntheticHold = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && argv[i + 1]) base = argv[++i];
    else if (argv[i] === '--report' && argv[i + 1]) report = resolve(argv[++i]);
    else if (argv[i] === '--synthetic-hold') syntheticHold = true;
    else throw new Error('usage: node tools/refresh-guard.mjs [--base <git-ref>] [--report <file>] [--synthetic-hold]');
  }
  base ??= newestTag();
  const acceptedChanges = JSON.parse(await readFile(join(ROOT, 'curated/accepted-changes.json'), 'utf8'));
  if (!Array.isArray(acceptedChanges)) throw new Error('curated/accepted-changes.json must contain an array');
  const result = compareDatasets(gitDataset(base), await directoryDataset(join(ROOT, 'public/data')), acceptedChanges, { syntheticHold, baseLabel: base });
  const text = renderReport(result, { base });
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, text);
  process.stdout.write(text);
  process.exitCode = result.hold ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => { console.error(`refresh guard failed: ${error.stack ?? error.message}`); process.exitCode = 1; });
}
