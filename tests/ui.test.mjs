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
      const renderedRoutes = ['#/credits'];
      for (const league of ['en', 'es', 'de', 'it', 'fr']) renderedRoutes.push(`#/l/${league}`, `#/s/${league}/2025`);
      renderedRoutes.push('#/s/it/2004', '#/s/fr/1992', '#/s/es/2003');
      const openLigaKey = findOpenLigaCase();
      const noScorerKey = findNoScorerCase();
      renderedRoutes.push('#/m/fr-2000-Q19521-Q19518', '#/m/fr-1992-Q212269-Q132885', `#/m/${openLigaKey}`, `#/m/${noScorerKey}`);
      const clubFiles = readdirSync(join(DATA, 'c'));
      const withTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => club.championSeasons.length);
      const withoutTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => !club.championSeasons.length && club.positions.length);
      renderedRoutes.push(`#/c/${withTitles.id}`, `#/c/${withoutTitles.id}`);

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
      }

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('forced failure'); };
      const { clearDataCache } = await import('../public/js/data.js?v=0.1.0');
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
}
