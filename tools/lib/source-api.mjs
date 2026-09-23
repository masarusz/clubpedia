import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const USER_AGENT = 'Clubpedia/0.1 (https://github.com/masarusz/clubpedia)';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function safeName(title) {
  return encodeURIComponent(title);
}

export function unsafeName(filename) {
  const name = filename.endsWith('.json') ? filename.slice(0, -5) : filename;
  return decodeURIComponent(name);
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export async function writeAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function chunks(values, size = 50) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function revisionContent(revision) {
  return revision?.slots?.main?.content ?? revision?.slots?.main?.['*'] ?? revision?.content ?? revision?.['*'];
}

function aliasMap(query = {}) {
  const aliases = new Map();
  for (const item of [...(query.normalized ?? []), ...(query.redirects ?? [])]) aliases.set(item.from, item.to);
  return aliases;
}

function finalAlias(title, aliases) {
  const visited = new Set();
  let current = title;
  while (aliases.has(current) && !visited.has(current)) {
    visited.add(current);
    current = aliases.get(current);
  }
  return current;
}

export function parseRevisionResponse(response, requestedTitles = []) {
  const pages = response?.query?.pages ?? [];
  const aliases = aliasMap(response?.query);
  const byTitle = new Map(pages.map((page) => [page.title, page]));
  const requested = requestedTitles.length ? requestedTitles : pages.map((page) => page.title);
  return requested.map((requestedTitle) => {
    const canonical = finalAlias(requestedTitle, aliases);
    const page = byTitle.get(canonical) ?? byTitle.get(requestedTitle);
    if (!page || page.missing === true || page.missing === '') {
      return { requestedTitle, title: canonical, missing: true, ...(canonical !== requestedTitle ? { redirectedFrom: requestedTitle } : {}) };
    }
    const revision = page.revisions?.[0];
    if (!revision || !Number.isInteger(revision.revid)) throw new Error(`No revision returned for ${requestedTitle}`);
    const content = revisionContent(revision);
    if (typeof content !== 'string') throw new Error(`No revision content returned for ${requestedTitle}`);
    return {
      requestedTitle,
      title: page.title,
      pageid: page.pageid,
      revid: revision.revid,
      timestamp: revision.timestamp,
      content,
      ...(page.title !== requestedTitle ? { redirectedFrom: requestedTitle } : {}),
    };
  });
}

export function parseMetadataResponse(response, requestedTitles = []) {
  const pages = response?.query?.pages ?? [];
  const aliases = aliasMap(response?.query);
  const byTitle = new Map(pages.map((page) => [page.title, page]));
  const requested = requestedTitles.length ? requestedTitles : pages.map((page) => page.title);
  return requested.map((requestedTitle) => {
    const canonical = finalAlias(requestedTitle, aliases);
    const page = byTitle.get(canonical) ?? byTitle.get(requestedTitle);
    if (!page || page.missing === true || page.missing === '') return { requestedTitle, title: canonical, missing: true };
    return {
      requestedTitle,
      title: page.title,
      pageid: page.pageid,
      wikibaseItem: page.pageprops?.wikibase_item ?? null,
      jaTitle: page.langlinks?.find((link) => link.lang === 'ja')?.title ?? null,
      ...(page.title !== requestedTitle ? { redirectedFrom: requestedTitle } : {}),
    };
  });
}

export function parseWikidataResponse(response) {
  return Object.values(response?.entities ?? {}).map((entity) => ({
    id: entity.id,
    lastrevid: entity.lastrevid,
    labels: entity.labels ?? {},
    claims: entity.claims ?? {},
    sitelinks: entity.sitelinks ?? {},
    ...(entity.missing === '' || entity.missing === true ? { missing: true } : {}),
  }));
}

export function mergeApiResponses(responses) {
  const merged = { batchcomplete: true, query: { pages: [], normalized: [], redirects: [] } };
  for (const response of responses) {
    merged.query.pages.push(...(response.query?.pages ?? []));
    merged.query.normalized.push(...(response.query?.normalized ?? []));
    merged.query.redirects.push(...(response.query?.redirects ?? []));
  }
  if (!merged.query.normalized.length) delete merged.query.normalized;
  if (!merged.query.redirects.length) delete merged.query.redirects;
  return merged;
}

function retryDelay(response, defaultMilliseconds) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return defaultMilliseconds;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? defaultMilliseconds : Math.max(0, date - Date.now());
}

export class Requester {
  constructor({ fetchImpl = globalThis.fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), minimumWikimediaDelay = 1000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.minimumWikimediaDelay = minimumWikimediaDelay;
    this.lastWikimediaRequest = 0;
    this.requestCount = 0;
  }

  async fetch(url, { label = url, headers = {}, wikimedia = false } = {}) {
    for (let retry = 0; retry <= 8; retry += 1) {
      if (wikimedia) {
        const wait = this.minimumWikimediaDelay - (Date.now() - this.lastWikimediaRequest);
        if (wait > 0) await this.sleep(wait);
        this.lastWikimediaRequest = Date.now();
      }
      this.requestCount += 1;
      let response;
      try {
        response = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
      } catch (error) {
        if (retry === 8) throw new Error(`${label}: network request failed after 9 attempts: ${error.message}`);
        await this.sleep(30_000);
        continue;
      }
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
      if (retry === 8) throw new Error(`${label}: HTTP ${response.status} after 9 attempts`);
      await this.sleep(retryDelay(response, 30_000));
    }
    throw new Error(`${label}: retry loop exhausted`);
  }

  async json(url, options) {
    const response = await this.fetch(url, options);
    try { return await response.json(); }
    catch (error) { throw new Error(`${options?.label ?? url}: invalid JSON: ${error.message}`); }
  }

  async bytes(url, options) {
    const response = await this.fetch(url, options);
    return Buffer.from(await response.arrayBuffer());
  }
}

export async function fetchApiWithContinue(requester, endpoint, parameters, label) {
  const responses = [];
  let continuation = {};
  do {
    const query = new URLSearchParams({ ...parameters, ...continuation });
    const response = await requester.json(`${endpoint}?${query}`, { label, wikimedia: true });
    if (response.error) throw new Error(`${label}: API error ${response.error.code}: ${response.error.info}`);
    responses.push(response);
    continuation = response.continue ?? null;
  } while (continuation);
  return mergeApiResponses(responses);
}

export function cachePath(root, wiki, title) {
  return join(root, wiki, `${safeName(title)}.json`);
}
