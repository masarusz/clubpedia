import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DATA = join(ROOT, 'public/data');
const load = (path) => JSON.parse(readFileSync(join(DATA, path), 'utf8'));

class FakeNode {}
class FakeText extends FakeNode {
  constructor(value) { super(); this.value = String(value); }
  get textContent() { return this.value; }
  set textContent(value) { this.value = String(value); }
}
class FakeElement extends FakeNode {
  constructor(tagName) {
    super(); this.tagName = tagName.toUpperCase(); this.attributes = new Map(); this.childNodes = []; this.listeners = new Map(); this.value = '';
    this.style = { backgroundColor: '' };
  }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); if (name === 'value') this.value = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { for (const child of children) this.childNodes.push(child instanceof FakeNode ? child : new FakeText(child)); }
  replaceChildren(...children) { this.childNodes = []; this.append(...children); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new FakeText(value)); }
}

function descendants(node) {
  if (!(node instanceof FakeElement)) return [];
  return [node, ...node.childNodes.flatMap(descendants)];
}
const hasClass = (node, name) => (node.getAttribute('class') ?? '').split(/\s+/).includes(name);
const withClass = (node, name) => descendants(node).filter((item) => item instanceof FakeElement && hasClass(item, name));
const settle = async () => { for (let count = 0; count < 5; count += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise)); };

function findOpenLigaCase() {
  for (const file of readdirSync(join(DATA, 'o'))) {
    const extra = load(`o/${file}`);
    const season = load(`s/${file}`);
    for (const key of Object.keys(extra.matches)) if (!season.matches.find((match) => match.key === key)?.scorers) return key;
  }
  return null;
}

function findNoScorerCase() {
  for (const file of readdirSync(join(DATA, 's')).filter((name) => !name.startsWith('de-'))) {
    const season = load(`s/${file}`);
    const match = season.matches.find((item) => !item.scorers);
    if (match) return match.key;
  }
  return null;
}

export function register(test, equal, deepEqual) {
  test('every Phase 3 route renders real data and Home fetches only index.json', async () => {
    const previous = { document: globalThis.document, Node: globalThis.Node, window: globalThis.window, location: globalThis.location, history: globalThis.history, fetch: globalThis.fetch };
    const appRoot = new FakeElement('div');
    const listeners = new Map();
    const requested = [];
    globalThis.Node = FakeNode;
    globalThis.document = { createElement: (tag) => new FakeElement(tag), createTextNode: (value) => new FakeText(value), querySelector: (selector) => selector === '#app' ? appRoot : null };
    globalThis.window = { addEventListener: (type, listener) => listeners.set(type, listener), scrollTo: () => {} };
    globalThis.location = { hash: '' };
    globalThis.history = { state: null, back: () => {}, replaceState(state) { this.state = state; } };
    globalThis.fetch = async (url) => {
      const path = String(url).split('?')[0]; requested.push(path);
      try { return { ok: true, status: 200, json: async () => load(path.replace(/^data\//, '')) }; }
      catch { return { ok: false, status: 404, json: async () => ({}) }; }
    };

    try {
      await import(`../public/js/app.js?ui=${Date.now()}`);
      await settle();
      deepEqual([...new Set(requested)], ['data/index.json'], 'Home request set');
      equal(appRoot.textContent.includes('欧州5大リーグ'), true, 'Home heading');
      deepEqual(withClass(appRoot, 'league-flag').map((node) => node.getAttribute('alt')).sort(),
        ['イングランド', 'イタリア', 'スペイン', 'ドイツ', 'フランス'].sort(), 'Home league flag alt text');
      const renderedRoutes = ['#/credits'];
      for (const league of ['en', 'es', 'de', 'it', 'fr']) renderedRoutes.push(`#/l/${league}`, `#/s/${league}/2025`);
      renderedRoutes.push('#/s/it/2004', '#/s/fr/1992', '#/s/es/2003');
      const openLigaKey = findOpenLigaCase();
      const noScorerKey = findNoScorerCase();
      renderedRoutes.push('#/m/fr-2000-Q19521-Q19518', '#/m/fr-2013-Q192071-Q208399', '#/m/fr-1992-Q212269-Q132885', `#/m/${openLigaKey}`, `#/m/${noScorerKey}`);
      const clubFiles = readdirSync(join(DATA, 'c'));
      const withTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => club.championSeasons.length);
      const withoutTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => !club.championSeasons.length && club.positions.length);
      renderedRoutes.push(`#/c/${withTitles.id}`, `#/c/${withoutTitles.id}`, '#/c/Q132885');

      for (const hash of renderedRoutes) {
        globalThis.location.hash = hash;
        await listeners.get('hashchange')();
        await settle();
        equal(descendants(appRoot).some((node) => hasClass(node, 'error-view')), false, `${hash} error view`);
        const body = appRoot.textContent;
        equal(/[{|]/u.test(body), false, `${hash} ruby leak`);
        equal(/undefined|null|NaN/u.test(body), false, `${hash} invalid value`);
        equal(body.length > 20, true, `${hash} rendered text`);
        if (hash === `#/m/${noScorerKey}`) equal(body.includes('得点者の記録なし'), true, 'no-scorer message');
        if (hash === `#/m/${openLigaKey}`) equal(body.includes('OpenLigaDB'), true, 'OpenLigaDB credit');
        if (hash === '#/s/en/2025') {
          const rows = withClass(appRoot, 'match-row');
          equal(rows.length > 0, true, 'season match rows rendered');
          equal(rows.every((row) => withClass(row, 'result-mark').length === 1), true, 'season match rows have result marks');
          equal(rows.some((row) => hasClass(row, 'match-win')), true, 'season wins are highlighted');
          equal(withClass(appRoot, 'league-flag').some((node) => node.getAttribute('alt') === 'イングランド'), true, 'season header flag');
        }
        if (hash === '#/m/fr-2013-Q192071-Q208399') {
          const ruling = body.indexOf('試合のあとで、SCバスティアの勝ちになりました');
          const scorers = body.indexOf('グラウンドでの得点（2-0）');
          equal(ruling >= 0, true, 'awarded ruling rendered');
          equal(scorers > ruling, true, 'pitch-score scorer heading follows ruling');
        }
        if (hash === `#/c/${withTitles.id}`) {
          const rows = withClass(appRoot, 'opponent-match-row');
          equal(rows.length > 0, true, 'club head-to-head match rows rendered');
          equal(rows.every((row) => withClass(row, 'result-mark').length === 1), true, 'club match rows have result marks');
          equal(rows.some((row) => hasClass(row, 'match-win')), true, 'club wins are highlighted');
        }
        if (hash === '#/c/Q132885') {
          equal(withClass(appRoot, 'season-chip-list')[0].childNodes.length, 10, 'Marseille title total matches its chips');
          const extraTitle = withClass(appRoot, 'extra-title');
          equal(extraTitle.length, 1, 'Marseille pre-professional title chip');
          equal(extraTitle[0].textContent, '1928–29プロリーグができる前');
          equal(descendants(extraTitle[0]).some((node) => node.tagName === 'A'), false, 'pre-professional title is not linked');
        }
      }

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('forced failure'); };
      const { clearDataCache } = await import('../public/js/data.js?v=0.1.2');
      clearDataCache();
      globalThis.location.hash = '#/s/en/2024';
      await listeners.get('hashchange')();
      await settle();
      equal(descendants(appRoot).some((node) => hasClass(node, 'error-view')), true, 'fetch failure renders error view');
      globalThis.fetch = originalFetch;
    } finally {
      Object.assign(globalThis, previous);
    }
  });

  test('release strings, cache versions, and minimum text sizes are consistent', () => {
    const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
    const manifest = readFileSync(join(ROOT, 'public/manifest.webmanifest'), 'utf8');
    const css = readFileSync(join(ROOT, 'public/css/app.css'), 'utf8');
    const sourceFiles = readdirSync(join(ROOT, 'public/js')).filter((name) => name.endsWith('.js'));
    equal(html.includes('Clubpedia（欧州5大リーグ大図鑑）'), true);
    equal(manifest.includes('Clubpedia（欧州5大リーグ大図鑑）'), true);
    equal(manifest.includes('"short_name": "クラブペディア"'), true);
    const releaseSources = [html, manifest, ...sourceFiles.map((name) => readFileSync(join(ROOT, 'public/js', name), 'utf8'))];
    equal(releaseSources.some((value) => /v=0\.1\.[01]\b/.test(value)), false, 'stale asset version');
    equal(readFileSync(join(ROOT, 'public/js/version.js'), 'utf8').includes("VERSION = '0.1.2'"), true, 'footer version');
    const remSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((match) => Number(match[1]));
    const pixelSizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
    equal(remSizes.every((size) => size >= 0.875), true, 'rem text is at least 14px at the 16px root');
    equal(pixelSizes.every((size) => size >= 14), true, 'pixel text is at least 14px');
  });
}
