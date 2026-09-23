#!/usr/bin/env node
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clubSeasonTitle,
  discoverDataTemplates,
  discoverLigueOneListPages,
  extractJapanesePlayerLinks,
  extractPlayerLinks,
  extractTableClubs,
  hasSportsResults,
  hasSportsTable,
  seasonArticleTitle,
} from './lib/wikitext.mjs';
import {
  Requester,
  cachePath,
  chunks,
  fetchApiWithContinue,
  parseMetadataResponse,
  parseRevisionResponse,
  parseWikidataResponse,
  readJson,
  safeName,
  sha256,
  stableJson,
  writeAtomic,
} from './lib/source-api.mjs';

const ENWIKI_API = 'https://en.wikipedia.org/w/api.php';
const JAWIKI_API = 'https://ja.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const OPENFOOTBALL_REPO = 'openfootball/football.json';

export const CHAMPION_LISTS = Object.freeze([
  'List of English football champions',
  'List of Spanish football champions',
  'List of German football champions',
  'List of Italian football champions',
  'List of French football champions',
]);

export const TOP_SCORER_LISTS = Object.freeze([
  'List of English football first tier top scorers',
  'Premier League Golden Boot',
  'Pichichi Trophy',
  'List of Bundesliga top scorers',
  'Capocannoniere',
  'List of Ligue 1 top scorers',
]);

export const FOREIGN_PLAYER_LISTS = Object.freeze([
  'List of foreign Premier League players',
  'List of foreign La Liga players',
  'List of foreign Bundesliga players',
  'List of foreign Serie A players',
  'List of foreign Ligue 1 players',
]);

function emptyLock() {
  return {
    version: 1,
    enwiki: {},
    jawiki: {},
    metadata: {},
    wikidata: {},
    openligadb: {},
    openfootball: null,
    seasons: {},
  };
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function cachedPageMatches(path, revid) {
  try { return (await readJson(path)).revid === revid; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}

async function cacheRevision(root, wiki, record) {
  if (record.missing) return;
  const output = {
    title: record.title,
    pageid: record.pageid,
    revid: record.revid,
    timestamp: record.timestamp,
    content: record.content,
    ...(record.redirectedFrom ? { redirectedFrom: record.redirectedFrom } : {}),
  };
  await writeAtomic(cachePath(root, wiki, record.requestedTitle), stableJson(output));
}

function lockRevision(record, kind, extra = {}) {
  if (record.missing) return { missing: true, kind, ...extra };
  return {
    revid: record.revid,
    kind,
    ...(record.title !== record.requestedTitle ? { title: record.title, redirectedFrom: record.requestedTitle } : {}),
    ...extra,
  };
}

async function fetchCurrentPages({ requester, root, wiki, endpoint, titles, kind, lock, saveLock, extraForTitle = () => ({}) }) {
  const output = new Map();
  const pending = [];
  for (const title of [...new Set(titles)].sort()) {
    const entry = lock[wiki][title];
    const path = cachePath(root, wiki, title);
    if (lock.refreshIncomplete && entry && (entry.missing || await cachedPageMatches(path, entry.revid))) {
      if (!entry.missing) output.set(title, await readJson(path));
      else output.set(title, { requestedTitle: title, title, missing: true });
    } else pending.push(title);
  }
  for (const batch of chunks(pending)) {
    const response = await fetchApiWithContinue(requester, endpoint, {
      action: 'query', format: 'json', formatversion: '2', prop: 'revisions',
      rvprop: 'ids|timestamp|content', rvslots: 'main', redirects: '1', titles: batch.join('|'),
    }, `${wiki} revisions: ${batch[0]}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}`);
    const records = parseRevisionResponse(response, batch);
    for (const record of records) {
      await cacheRevision(root, wiki, record);
      lock[wiki][record.requestedTitle] = lockRevision(record, kind, extraForTitle(record.requestedTitle));
      output.set(record.requestedTitle, record);
    }
    await saveLock();
  }
  return output;
}

async function fetchPinnedPages({ requester, root, wiki, endpoint, lock }) {
  const entries = Object.entries(lock[wiki]);
  const pending = [];
  for (const [requestedTitle, entry] of entries) {
    if (entry.missing) continue;
    if (!await cachedPageMatches(cachePath(root, wiki, requestedTitle), entry.revid)) pending.push([requestedTitle, entry]);
  }
  for (const batch of chunks(pending)) {
    const byRevision = new Map(batch.map(([title, entry]) => [entry.revid, [title, entry]]));
    const response = await fetchApiWithContinue(requester, endpoint, {
      action: 'query', format: 'json', formatversion: '2', prop: 'revisions',
      rvprop: 'ids|timestamp|content', rvslots: 'main', revids: [...byRevision.keys()].join('|'),
    }, `${wiki} pinned revisions: ${batch[0][0]}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}`);
    const returned = new Set();
    for (const page of response.query?.pages ?? []) {
      const revision = page.revisions?.[0];
      const mapping = revision && byRevision.get(revision.revid);
      if (!mapping) continue;
      const [requestedTitle] = mapping;
      const [record] = parseRevisionResponse({ query: { pages: [page] } }, [page.title]);
      record.requestedTitle = requestedTitle;
      if (requestedTitle !== record.title) record.redirectedFrom = requestedTitle;
      await cacheRevision(root, wiki, record);
      returned.add(revision.revid);
    }
    const absent = [...byRevision.keys()].filter((id) => !returned.has(id));
    if (absent.length) throw new Error(`${wiki}: pinned revisions not returned: ${absent.join(', ')}`);
  }
}

async function pageContent(root, wiki, title) {
  return (await readJson(cachePath(root, wiki, title))).content;
}

async function fetchMetadata({ requester, root, titles, lock, saveLock }) {
  const pending = [...new Set(titles)].sort().filter((title) => !lock.metadata[title]);
  for (const batch of chunks(pending)) {
    const response = await fetchApiWithContinue(requester, ENWIKI_API, {
      action: 'query', format: 'json', formatversion: '2', prop: 'pageprops|langlinks',
      lllang: 'ja', lllimit: 'max', redirects: '1', titles: batch.join('|'),
    }, `enwiki metadata: ${batch[0]}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}`);
    for (const record of parseMetadataResponse(response, batch)) {
      lock.metadata[record.requestedTitle] = record;
      await writeAtomic(join(root, 'metadata', 'enwiki', `${safeName(record.requestedTitle)}.json`), stableJson(record));
    }
    await saveLock();
  }
  for (const [title, record] of Object.entries(lock.metadata)) {
    const path = join(root, 'metadata', 'enwiki', `${safeName(title)}.json`);
    if (!await exists(path)) await writeAtomic(path, stableJson(record));
  }
}

async function fetchWikidataCurrent({ requester, root, ids, lock, saveLock }) {
  const pending = [];
  for (const id of [...new Set(ids)].sort()) {
    const entry = lock.wikidata[id];
    if (lock.refreshIncomplete && entry && !entry.missing) {
      try {
        if (sha256(await readFile(join(root, 'wikidata', `${id}.json`))) === entry.sha256) continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!(lock.refreshIncomplete && entry?.missing)) pending.push(id);
  }
  for (const batch of chunks(pending)) {
    const query = new URLSearchParams({
      action: 'wbgetentities', format: 'json', ids: batch.join('|'), props: 'info|claims|labels|sitelinks',
      languages: 'ja|en', sitefilter: 'enwiki|jawiki',
    });
    const response = await requester.json(`${WIKIDATA_API}?${query}`, {
      label: `wikidata entities: ${batch[0]}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}`,
      wikimedia: true,
    });
    if (response.error) throw new Error(`Wikidata API error ${response.error.code}: ${response.error.info}`);
    const entities = parseWikidataResponse(response);
    for (const entity of entities) {
      if (!entity.missing && !Number.isInteger(entity.lastrevid)) throw new Error(`Wikidata ${entity.id} has no lastrevid`);
      const bytes = stableJson(entity);
      await writeAtomic(join(root, 'wikidata', `${entity.id}.json`), bytes);
      lock.wikidata[entity.id] = entity.missing
        ? { missing: true }
        : { lastrevid: entity.lastrevid, sha256: sha256(bytes) };
    }
    await saveLock();
  }
}

async function fetchWikidataPinned({ requester, root, lock }) {
  const pending = [];
  for (const [id, entry] of Object.entries(lock.wikidata)) {
    if (entry.missing) continue;
    const path = join(root, 'wikidata', `${id}.json`);
    try {
      const bytes = await readFile(path);
      if (sha256(bytes) === entry.sha256) continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    pending.push([id, entry]);
  }
  for (const batch of chunks(pending)) {
    const wanted = new Map(batch.map(([id, entry]) => [entry.lastrevid, id]));
    const response = await fetchApiWithContinue(requester, WIKIDATA_API, {
      action: 'query', format: 'json', formatversion: '2', prop: 'revisions', rvprop: 'ids|content',
      rvslots: 'main', revids: [...wanted.keys()].join('|'),
    }, `wikidata pinned revisions: ${batch[0][0]}${batch.length > 1 ? ` (+${batch.length - 1})` : ''}`);
    const returned = new Set();
    for (const page of response.query?.pages ?? []) {
      const revision = page.revisions?.[0];
      const id = revision && wanted.get(revision.revid);
      if (!id) continue;
      const content = revision.slots?.main?.content ?? revision.slots?.main?.['*'];
      const raw = JSON.parse(content);
      const entity = {
        id,
        lastrevid: revision.revid,
        labels: Object.fromEntries(Object.entries(raw.labels ?? {}).filter(([language]) => language === 'ja' || language === 'en')),
        claims: raw.claims ?? {},
        sitelinks: Object.fromEntries(Object.entries(raw.sitelinks ?? {}).filter(([site]) => site === 'enwiki' || site === 'jawiki')),
      };
      const bytes = stableJson(entity);
      if (sha256(bytes) !== lock.wikidata[id].sha256) throw new Error(`Wikidata ${id}: pinned content hash mismatch`);
      await writeAtomic(join(root, 'wikidata', `${id}.json`), bytes);
      returned.add(id);
    }
    const absent = batch.map(([id]) => id).filter((id) => !returned.has(id));
    if (absent.length) throw new Error(`Wikidata pinned entities not returned: ${absent.join(', ')}`);
  }
}

async function fetchOpenLiga({ requester, root, years, refresh, lock, saveLock }) {
  for (const year of years) {
    const name = `bl1-${year}.json`;
    const path = join(root, 'openligadb', name);
    const pinned = lock.openligadb[name];
    if (pinned) {
      try {
        const bytes = await readFile(path);
        if (sha256(bytes) === pinned.sha256 && (!refresh || lock.refreshIncomplete)) continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const url = `https://api.openligadb.de/getmatchdata/bl1/${year}`;
    const bytes = await requester.bytes(url, { label: `OpenLigaDB Bundesliga ${year}`, headers: { Accept: 'application/json' } });
    JSON.parse(bytes.toString('utf8'));
    const hash = sha256(bytes);
    if (!refresh && pinned && hash !== pinned.sha256) throw new Error(`${name}: OpenLigaDB bytes changed (wanted ${pinned.sha256}, got ${hash})`);
    await writeAtomic(path, bytes);
    lock.openligadb[name] = { url, sha256: hash };
    await saveLock();
  }
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

export async function extractTarGz(bytes, destination) {
  const tar = gunzipSync(bytes);
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await mkdir(temporary, { recursive: true });
  try {
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const fullName = [tarString(header, 345, 155), tarString(header, 0, 100)].filter(Boolean).join('/');
      const size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8);
      const type = tarString(header, 156, 1) || '0';
      const relative = fullName.split('/').slice(1).join('/');
      if (relative && !relative.split('/').some((part) => part === '..')) {
        const target = join(temporary, relative);
        if (type === '5') await mkdir(target, { recursive: true });
        else if (type === '0' || type === '\0') {
          await mkdir(dirname(target), { recursive: true });
          await writeAtomic(target, tar.subarray(offset + 512, offset + 512 + size));
        }
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function fetchOpenFootball({ requester, root, refresh, requestedSha, lock, saveLock, extractArchive = extractTarGz }) {
  let commit = requestedSha ?? lock.openfootball?.sha;
  if (refresh && !commit) {
    const repository = await requester.json(`https://api.github.com/repos/${OPENFOOTBALL_REPO}`, { label: 'openfootball repository' });
    if (typeof repository.default_branch !== 'string') throw new Error('openfootball repository response has no default_branch');
    const response = await requester.json(`https://api.github.com/repos/${OPENFOOTBALL_REPO}/commits/${encodeURIComponent(repository.default_branch)}`, { label: 'openfootball commit' });
    commit = response.sha;
  }
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new Error('No valid openfootball commit SHA; pass --openfootball-sha SHA with --refresh');
  const directory = join(root, 'openfootball', `football.json-${commit}`);
  if (lock.openfootball?.sha === commit && await exists(directory) && (!refresh || lock.refreshIncomplete)) {
    try {
      if ((await readFile(join(directory, '_archive.sha256'), 'utf8')).trim() === lock.openfootball.sha256) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const url = `https://codeload.github.com/${OPENFOOTBALL_REPO}/tar.gz/${commit}`;
  const bytes = await requester.bytes(url, { label: `openfootball ${commit}` });
  const hash = sha256(bytes);
  if (!refresh && lock.openfootball && hash !== lock.openfootball.sha256) throw new Error(`openfootball archive hash mismatch`);
  await extractArchive(bytes, directory);
  await writeAtomic(join(directory, '_archive.sha256'), `${hash}\n`);
  lock.openfootball = { repo: OPENFOOTBALL_REPO, sha: commit, url, sha256: hash };
  await saveLock();
}

function summaryText(lock, requestCount) {
  const lines = ['Clubpedia source fetch summary', ''];
  for (const wiki of ['enwiki', 'jawiki']) {
    const entries = Object.values(lock[wiki]);
    const kinds = new Map();
    for (const entry of entries) {
      const counts = kinds.get(entry.kind) ?? { pages: 0, missing: 0 };
      counts.pages += 1;
      if (entry.missing) counts.missing += 1;
      kinds.set(entry.kind, counts);
    }
    for (const [kind, counts] of [...kinds].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${wiki} ${kind}: ${counts.pages} pages, ${counts.missing} missing`);
    }
  }
  lines.push(`wikidata: ${Object.keys(lock.wikidata).length} entities`);
  lines.push(`openligadb: ${Object.keys(lock.openligadb).length} files`);
  lines.push(`openfootball: ${lock.openfootball?.sha ?? 'not fetched'}`);
  lines.push('', 'League-seasons:');
  for (const [key, season] of Object.entries(lock.seasons).sort()) {
    lines.push(`${key}: article=${season.articleFound ? 'yes' : 'missing'} table=${season.tableFound ? 'yes' : 'missing'} results=${season.resultsFound ? 'yes' : 'missing'}`);
  }
  lines.push('', `Network requests this run: ${requestCount}`, '');
  return lines.join('\n');
}

export async function runFetchSources(options = {}) {
  const root = resolve(options.out ?? '.cache/sources');
  const lockPath = resolve(options.lockPath ?? 'tools/sources.lock.json');
  const refresh = options.refresh === true;
  let oldLock;
  try { oldLock = await readJson(lockPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; oldLock = emptyLock(); }
  if (!refresh && (!oldLock.version || !Object.keys(oldLock.enwiki ?? {}).length)) {
    throw new Error(`Source lock is empty; run with --refresh first (${lockPath})`);
  }
  const resumingRefresh = refresh && oldLock.refreshIncomplete === true;
  const lock = refresh && !resumingRefresh ? emptyLock() : { ...emptyLock(), ...oldLock };
  if (refresh) lock.refreshIncomplete = true;
  const saveLock = async () => writeAtomic(lockPath, stableJson(lock));
  if (refresh) await saveLock();
  const requester = options.requester ?? new Requester(options.requestOptions);
  const leagues = options.leagues ?? ['en', 'es', 'de', 'it', 'fr'];
  const startYears = options.startYears ?? Array.from({ length: 34 }, (_, index) => 1992 + index);
  const listTitles = options.listTitles ?? [...CHAMPION_LISTS, ...TOP_SCORER_LISTS, ...FOREIGN_PLAYER_LISTS];
  const topScorerLists = new Set(options.topScorerLists ?? TOP_SCORER_LISTS);
  const foreignLists = new Set(options.foreignLists ?? FOREIGN_PLAYER_LISTS);

  if (!refresh) {
    await fetchPinnedPages({ requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, lock });
    await fetchPinnedPages({ requester, root, wiki: 'jawiki', endpoint: JAWIKI_API, lock });
    await fetchMetadata({ requester, root, titles: [], lock, saveLock });
    await fetchWikidataPinned({ requester, root, lock });
  } else {
    const seasonSpecs = leagues.flatMap((league) => startYears.map((startYear) => ({ league, startYear, title: seasonArticleTitle(league, startYear) })));
    const specByTitle = new Map(seasonSpecs.map((spec) => [spec.title, spec]));
    const seasonPages = await fetchCurrentPages({
      requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: seasonSpecs.map(({ title }) => title),
      kind: 'season', lock, saveLock,
      extraForTitle: (title) => ({ league: specByTitle.get(title).league, startYear: specByTitle.get(title).startYear }),
    });
    const templateTitles = new Set();
    for (const spec of seasonSpecs) {
      const page = seasonPages.get(spec.title);
      if (!page?.missing) for (const title of discoverDataTemplates(page.content, spec.title)) templateTitles.add(title);
    }
    const templatePages = await fetchCurrentPages({
      requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: [...templateTitles], kind: 'template', lock, saveLock,
    });
    let discoveredMore = true;
    while (discoveredMore) {
      const more = new Set();
      for (const [title, page] of templatePages) {
        if (!page.missing) for (const found of discoverDataTemplates(page.content, title)) if (!templatePages.has(found)) more.add(found);
      }
      discoveredMore = more.size > 0;
      if (discoveredMore) {
        const fetched = await fetchCurrentPages({ requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: [...more], kind: 'template', lock, saveLock });
        for (const pair of fetched) templatePages.set(...pair);
      }
    }
    const listPages = await fetchCurrentPages({
      requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: listTitles, kind: 'list', lock, saveLock,
    });
    const ligueIndex = listPages.get('List of foreign Ligue 1 players');
    if (ligueIndex && !ligueIndex.missing) {
      const splitTitles = discoverLigueOneListPages(ligueIndex.content);
      const splitPages = await fetchCurrentPages({ requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: splitTitles, kind: 'foreign-list', lock, saveLock });
      for (const pair of splitPages) listPages.set(...pair);
      for (const title of splitTitles) foreignLists.add(title);
    }

    const clubTargets = new Set();
    const clubSeasonSpecs = [];
    for (const spec of seasonSpecs) {
      const article = seasonPages.get(spec.title);
      const relatedTitles = new Set(discoverDataTemplates(article?.content ?? '', spec.title));
      const queue = [...relatedTitles];
      while (queue.length) {
        const title = queue.shift();
        const page = templatePages.get(title);
        if (!page || page.missing) continue;
        for (const dependency of discoverDataTemplates(page.content, title)) {
          if (!relatedTitles.has(dependency)) { relatedTitles.add(dependency); queue.push(dependency); }
        }
      }
      const relatedTemplates = [...relatedTitles].sort().map((title) => [title, templatePages.get(title)]).filter(([, page]) => page);
      const combined = [article, ...relatedTemplates.map(([, page]) => page)].filter((page) => page && !page.missing).map((page) => page.content).join('\n');
      const clubs = extractTableClubs(combined);
      for (const club of clubs) {
        clubTargets.add(club.target);
        clubSeasonSpecs.push({ title: clubSeasonTitle(spec.startYear, club.target), league: spec.league, startYear: spec.startYear });
      }
      lock.seasons[`${spec.league}-${spec.startYear}`] = {
        articleTitle: spec.title,
        articleFound: Boolean(article && !article.missing),
        templateTitles: relatedTemplates.map(([title]) => title).sort(),
        tableFound: hasSportsTable(combined),
        resultsFound: hasSportsResults(combined),
        clubSeasonTitles: clubs.map((club) => clubSeasonTitle(spec.startYear, club.target)).sort(),
      };
    }
    await saveLock();
    const clubSpecByTitle = new Map(clubSeasonSpecs.map((spec) => [spec.title, spec]));
    const clubSeasonPages = await fetchCurrentPages({
      requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: clubSeasonSpecs.map(({ title }) => title),
      kind: 'club-season', lock, saveLock,
      extraForTitle: (title) => ({ league: clubSpecByTitle.get(title).league, startYear: clubSpecByTitle.get(title).startYear }),
    });

    const playerTargets = new Set();
    for (const page of seasonPages.values()) if (!page.missing) for (const title of extractPlayerLinks(page.content)) playerTargets.add(title);
    for (const page of clubSeasonPages.values()) if (!page.missing) for (const title of extractPlayerLinks(page.content)) playerTargets.add(title);
    const japanesePlayers = new Set();
    for (const [title, page] of listPages) {
      if (page.missing) continue;
      if (topScorerLists.has(title)) for (const player of extractPlayerLinks(page.content, { topScorerPage: true })) playerTargets.add(player);
      if (foreignLists.has(title)) for (const player of extractJapanesePlayerLinks(page.content)) {
        japanesePlayers.add(player);
        playerTargets.add(player);
      }
    }
    await fetchMetadata({ requester, root, titles: [...clubTargets, ...playerTargets], lock, saveLock });
    const entityIds = Object.values(lock.metadata).map((record) => record.wikibaseItem).filter(Boolean);
    await fetchWikidataCurrent({ requester, root, ids: entityIds, lock, saveLock });
    const japaneseEnPages = await fetchCurrentPages({
      requester, root, wiki: 'enwiki', endpoint: ENWIKI_API, titles: [...japanesePlayers], kind: 'japanese-player', lock, saveLock,
    });
    const japaneseJaTitles = [...japaneseEnPages.keys()].map((title) => lock.metadata[title]?.jaTitle).filter(Boolean);
    await fetchCurrentPages({ requester, root, wiki: 'jawiki', endpoint: JAWIKI_API, titles: japaneseJaTitles, kind: 'japanese-player', lock, saveLock });
  }

  await fetchOpenLiga({ requester, root, years: options.openLigaYears ?? Array.from({ length: 18 }, (_, index) => 2008 + index), refresh, lock, saveLock });
  if (options.openfootball !== false) {
    await fetchOpenFootball({
      requester, root, refresh, requestedSha: options.openfootballSha, lock, saveLock,
      extractArchive: options.extractArchive ?? extractTarGz,
    });
  }
  delete lock.refreshIncomplete;
  await saveLock();
  const summary = summaryText(lock, requester.requestCount);
  await writeAtomic(join(root, 'SUMMARY.txt'), summary);
  if (!options.quiet) process.stdout.write(summary);
  return { lock, summary, requestCount: requester.requestCount };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--refresh') options.refresh = true;
    else if (argument === '--out' && argv[index + 1]) options.out = argv[++index];
    else if (argument === '--lock' && argv[index + 1]) options.lockPath = argv[++index];
    else if (argument === '--openfootball-sha' && argv[index + 1]) options.openfootballSha = argv[++index];
    else throw new Error('usage: node tools/fetch-sources.mjs [--refresh] [--out DIR] [--lock FILE] [--openfootball-sha SHA]');
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runFetchSources(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`fetch-sources: ${error.message}`); process.exitCode = 1; }
}
