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
      const today = new Date();
      const todayKey = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      await import(`../public/js/app.js?ui=${Date.now()}`);
      await settle();
      deepEqual([...new Set(requested)], ['data/index.json', `data/days/${todayKey}.json`], 'Home request set');
      equal(appRoot.textContent.includes('欧州5大リーグ'), true, 'Home heading');
      deepEqual(withClass(appRoot, 'league-flag').map((node) => node.getAttribute('alt')).sort(),
        ['イングランド', 'イタリア', 'スペイン', 'ドイツ', 'フランス'].sort(), 'Home league flag alt text');
      const { homeView } = await import(`../public/js/views.js?today=${Date.now()}`);
      const september23 = homeView(load('index.json'), null, load('days/09-23.json'));
      const todayRows = withClass(september23, 'today-match-row').map((row) => row.textContent);
      equal(todayRows.length > 0, true, '09-23 has today-history matches');
      equal(todayRows.every((row) => !/Q\d+/.test(row)), true, 'today-history uses club names, not Wikidata ids');
      equal(todayRows.every((row) => !row.includes('0年')), true, 'today-history uses real years');
      equal(todayRows.every((row) => /^\d{4}年 .+ \d+–\d+ .+$/u.test(row)), true, 'today-history row shape');
      const { clearDataCache, playerBucket } = await import('../public/js/data.js?v=1.0.0');
      const renderedRoutes = ['#/credits'];
      for (const league of ['en', 'es', 'de', 'it', 'fr']) renderedRoutes.push(`#/l/${league}`, `#/s/${league}/2025`);
      renderedRoutes.push('#/s/it/2004', '#/s/fr/1992', '#/s/es/2003');
      const openLigaKey = findOpenLigaCase();
      const noScorerKey = findNoScorerCase();
      renderedRoutes.push('#/m/fr-2000-Q19521-Q19518', '#/m/fr-2013-Q192071-Q208399', '#/m/fr-1992-Q212269-Q132885', `#/m/${openLigaKey}`, `#/m/${noScorerKey}`);
      const clubFiles = readdirSync(join(DATA, 'c'));
      const withTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => club.championSeasons.length);
      const withoutTitles = clubFiles.map((file) => load(`c/${file}`)).find((club) => !club.championSeasons.length && club.positions.length);
      renderedRoutes.push(`#/c/${withTitles.id}`, `#/c/${withoutTitles.id}`, '#/c/Q132885', '#/c/Q9617', '#/c/Q10333');

      // Phase 4: player (with and without goals), a Japanese player with an
      // en-fallback season, 日本人選手, 選手名鑑 (one season per league),
      // ランキング (both tabs), and search (empty and with a query).
      const playerWithGoals = 'Q44395063'; // 三笘薫
      const playerWithoutGoals = 'Q106239673';
      const japan = load('japan.json');
      const enFallbackPlayer = japan.players.find((item) => item.seasons.some((season) => season.source === 'en'));
      renderedRoutes.push(`#/p/${playerWithGoals}`, '#/p/Q27067753', '#/p/Q43666', '#/p/Q483583', `#/p/${playerWithoutGoals}`, `#/p/${enFallbackPlayer.id}`, '#/p/Q999999999999');
      renderedRoutes.push('#/credits/photos');
      renderedRoutes.push('#/j');
      renderedRoutes.push('#/z', '#/z/es', '#/z/de/2015');
      const meikanSeasons = { en: '2025', es: '2025', de: '2025', it: '2025', fr: '2025' };
      for (const [lg, year] of Object.entries(meikanSeasons)) renderedRoutes.push(`#/z/${lg}/${year}`);
      renderedRoutes.push('#/r', '#/r/players/topScorers', '#/r/clubs/titles', '#/r/clubs/seasonPoints', '#/r/clubs/wins');
      renderedRoutes.push('#/s', '#/s?q=みとま', '#/s?q=xyzxyznomatch');

      for (const hash of renderedRoutes) {
        clearDataCache();
        requested.length = 0;
        globalThis.location.hash = hash;
        await listeners.get('hashchange')();
        await settle();
        equal(descendants(appRoot).some((node) => hasClass(node, 'error-view')), false, `${hash} error view`);
        const body = appRoot.textContent;
        equal(/[{|]/u.test(body), false, `${hash} ruby leak`);
        equal(/undefined|null|NaN/u.test(body), false, `${hash} invalid value`);
        equal(body.length > 20, true, `${hash} rendered text`);
        equal(descendants(appRoot).filter((node) => node.tagName === 'A').every((anchor) => !descendants(anchor).slice(1).some((node) => node.tagName === 'A')), true, `${hash} has no nested links`);
        const dataRequests = [...new Set(requested.filter((path) => path.startsWith('data/')))];
        if (hash.startsWith('#/c/')) {
          equal(dataRequests.length <= 3, true, `${hash} fetches at most three data files`);
          equal(dataRequests.some((path) => path.startsWith('data/p/')), false, `${hash} embeds displayed player names`);
        }
        if (hash.startsWith('#/l/')) equal(dataRequests.length <= 2, true, `${hash} fetches only index and league history data`);
        if (hash === '#/s/en/2025') {
          const season = load('s/en-2025.json');
          const buckets = new Set(season.topScorers.map((item) => item.playerId).filter(Boolean).map(playerBucket));
          equal(dataRequests.length <= 2 + buckets.size, true, 'season fetches only its file, names, and displayed-player buckets');
        }
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
        if (hash === '#/c/Q9617') equal(body.includes('12/23'), true, 'head-to-head row shows its Wikipedia date');
        if (hash === '#/c/Q10333') {
          const scorerRows = withClass(appRoot, 'club-scorers')[0]?.childNodes ?? [];
          const tied = scorerRows.filter((row) => row.textContent.includes('47得点')).map((row) => row.textContent);
          equal(tied.length, 3, 'three Valencia scorers share 47 goals');
          equal(tied.every((row) => row.startsWith('2位')), true, 'club scorer ties use competition ranks');
          equal(scorerRows.find((row) => row.textContent.includes('38得点'))?.textContent.startsWith('5位'), true, 'rank after three-way tie skips to fifth');
        }
        if (hash === `#/p/${playerWithGoals}`) {
          const names = load('names.json');
          equal(dataRequests.length <= 3, true, `${hash} fetches only its player bucket, names, and photo credits when needed`);
          equal(body.includes('三笘'), true, 'player kanji name rendered');
          equal(withClass(appRoot, 'player-goal-list').some((list) => list.childNodes.length > 0), true, 'goal-scorer season shows goal links');
          const goalAnchors = descendants(appRoot).filter((node) => node.tagName === 'A' && node.getAttribute('href')?.startsWith('#/m/'));
          equal(goalAnchors.length > 0, true, 'goal links rendered');
          equal(goalAnchors.every((anchor) => /^vs .+（(?:ホーム|アウェー)）(?: \d+得点)?$/u.test(anchor.textContent)), true, 'goal links show opponent and venue');
          equal(goalAnchors.every((anchor) => {
            const opponent = /^vs (.+)（(?:ホーム|アウェー)）/u.exec(anchor.textContent)?.[1] ?? '';
            return opponent && !/^[a-z]{2}$/u.test(opponent) && opponent !== '試合'
              && Object.values(names).some((item) => item.name === opponent);
          }), true, 'goal links use Japanese club names from names.json');
        }
        if (hash === '#/p/Q27067753') {
          equal(dataRequests.length <= 2, true, `${hash} fetches only its player bucket and names`);
          equal(dataRequests.includes('data/photo-credits.json'), false, `${hash} does not fetch photo credits`);
          const images = descendants(appRoot).filter((node) => node.tagName === 'IMG');
          equal(images.some((image) => image.getAttribute('src')?.endsWith('Q27067753.webp?v=1.0.0')), true, 'Kubo player photo renders');
          equal(body.includes('写真:'), true, 'Kubo player photo credit renders');
        }
        if (hash === '#/p/Q43666') {
          equal(body.includes('OpenLigaDBの記録: 1得点'), true, 'Bundesliga season shows the separate OpenLigaDB total');
          equal(body.includes('ODbL 1.0'), true, 'OpenLigaDB player total has an ODbL credit');
          equal(dataRequests.includes('data/o/players.json'), true, 'Bundesliga player loads the compact ODbL player totals');
        }
        if (hash === '#/p/Q483583') {
          equal(body.includes('記録のある試合で 0得点'), true, 'recorded goal count is explicitly partial');
          equal(body.includes('シーズン 31得点'), true, 'authoritative season total is shown separately');
          equal(dataRequests.includes('data/o/players.json'), false, 'non-Bundesliga player does not load ODbL totals');
        }
        if (hash === `#/p/${playerWithoutGoals}`) {
          const record = load(`p/${playerBucket(playerWithoutGoals)}.json`)[playerWithoutGoals];
          const hasBundesligaSeason = record.seasons.some((season) => season.league === 'de');
          equal(dataRequests.length <= (hasBundesligaSeason ? 3 : 2), true, `${hash} fetches its player bucket, names, and ODbL totals only for Bundesliga`);
          equal(dataRequests.includes('data/o/players.json'), hasBundesligaSeason, `${hash} ODbL player-total fetch follows Bundesliga participation`);
        }
        if (hash === `#/p/${enFallbackPlayer.id}`) {
          equal(body.includes('英語版の記録'), true, 'en-fallback season shows its source note');
        }
        if (hash === '#/p/Q999999999999') {
          equal(body.includes('見つかりません'), true, 'unknown player id shows not-found view, not an error');
        }
        if (hash === '#/j') {
          equal(dataRequests.length <= 2, true, `${hash} fetches only japan.json and names`);
          equal(withClass(appRoot, 'japan-player-row').length > 0, true, '日本人選手 rows rendered');
        }
        if (['#/z', '#/z/es', '#/z/de/2015'].includes(hash) || hash.startsWith('#/z/')) {
          const switcher = withClass(appRoot, 'meikan-league-switcher')[0] ?? appRoot;
          const switcherFlags = withClass(switcher, 'league-flag').map((node) => node.getAttribute('alt')).sort();
          equal(switcherFlags.join(','), ['イングランド', 'イタリア', 'スペイン', 'ドイツ', 'フランス'].sort().join(','), `${hash} meikan switcher shows all five leagues`);
          const picker = withClass(appRoot, 'meikan-season-select')[0];
          equal(picker?.childNodes.length, 34, `${hash} season picker holds 34 seasons`);
          if (hash === '#/z') {
            picker.value = '2024';
            for (const listener of picker.listeners.get('change') ?? []) listener();
            const premier = descendants(switcher).find((node) => node.tagName === 'A' && node.textContent.includes('プレミアリーグ'));
            equal(premier?.getAttribute('href'), '#/z/en/2024', 'chooser season updates league targets');
          }
        }
        if (hash.startsWith('#/z/') && /^#\/z\/[a-z]{2}\/\d{4}$/.test(hash)) {
          const [, lg, year] = /^#\/z\/([a-z]{2})\/(\d{4})$/.exec(hash);
          const season = load(`s/${lg}-${year}.json`);
          const names = load('names.json');
          const firstClub = Object.keys(season.players ?? {}).sort((a, b) => (names[a]?.name ?? a).localeCompare(names[b]?.name ?? b, 'ja'))[0];
          const buckets = new Set((season.players?.[firstClub] ?? []).map((item) => item.id).map(playerBucket));
          equal(dataRequests.length <= 2 + buckets.size, true, `${hash} fetches only its season file, names, and the shown club's player buckets`);
          const cards = withClass(appRoot, 'meikan-card');
          equal(cards.length > 0, true, `${hash} renders player cards`);
          equal(cards.every((card) => !/^Q\d+$/.test(withClass(card, 'meikan-name')[0]?.textContent ?? '')), true, `${hash} card names resolve to Japanese display names, not raw ids`);
        }
        if (hash === '#/r' || hash.startsWith('#/r/')) {
          equal(dataRequests.length <= 2, true, `${hash} fetches only rankings.json and names`);
          equal(withClass(appRoot, 'ranking-row').length > 0, true, `${hash} renders ranking rows`);
        }
        if (hash === '#/credits/photos') {
          const credits = load('photo-credits.json');
          const rows = withClass(appRoot, 'photo-credit-row');
          equal(rows.length, Object.keys(credits).length, 'photo credits renders one row per accepted photo');
          equal(rows.every((row) => /.+ \/ .+/u.test(row.textContent)), true, 'photo credits rows include artist and licence');
          equal(rows.every((row) => !/^Q\d{3,}/u.test(row.textContent)), true, 'photo credits rows start with player names, not ids');
          equal(!/\/Q\d{3,}/u.test(body), true, 'photo credits page text contains no raw Wikidata id paths');
          equal(rows.every((row) => descendants(row).some((node) => node.tagName === 'A' && /commons\.wikimedia\.org/.test(node.getAttribute('href') ?? ''))), true, 'photo credits rows include Commons links');
          for (const [id, photo] of Object.entries(credits)) if (/\bCC BY(?:-SA)?\b/i.test(photo.licence ?? '')) {
            const row = rows.find((item) => descendants(item).some((node) => node.getAttribute?.('href') === `#/p/${id}`));
            equal(row?.textContent.includes('（切り抜き・縮小）'), true, `${id} has crop/resize note`);
          }
        }
        if (hash === '#/s?q=みとま') {
          equal(withClass(appRoot, 'search-result').some((node) => node.getAttribute('href') === `#/p/${playerWithGoals}`), true, '三笘 search result links to his player page');
        }
        if (hash === '#/s?q=xyzxyznomatch') {
          equal(body.includes('見つかりませんでした'), true, 'no-match search shows the empty-result message');
        }
      }

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('forced failure'); };
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

  test('search input element is never re-rendered while typing (IME safety)', async () => {
    const previous = { document: globalThis.document, Node: globalThis.Node };
    globalThis.Node = FakeNode;
    globalThis.document = { createElement: (tag) => new FakeElement(tag), createTextNode: (value) => new FakeText(value) };
    try {
      const { searchComponent } = await import(`../public/js/views.js?search-input=${Date.now()}`);
      const { prepareIndex } = await import(`../public/js/search.js?search-input=${Date.now()}`);
      const entries = load('search.json');
      const names = load('names.json');
      let contextLoads = 0;
      const loadContext = async () => { contextLoads += 1; return { index: prepareIndex(entries), names }; };
      const widget = searchComponent({ loadContext, updateUrl: () => {} });
      const input = withClass(widget, 'search-input')[0];
      input.listeners.get('focus')[0]();
      await settle();
      equal(contextLoads, 1, 'search context loads once, on focus (never eagerly)');
      input.value = 'み';
      input.listeners.get('input')[0]();
      await settle();
      equal(withClass(widget, 'search-input')[0], input, 'input node identity survives the first keystroke');
      input.value = 'みと';
      input.listeners.get('input')[0]();
      await settle();
      equal(withClass(widget, 'search-input')[0], input, 'input node identity survives the second keystroke');
      equal(withClass(widget, 'search-result').length > 0, true, 'typing renders results without re-rendering the input');
      equal(contextLoads, 1, 'search index is fetched once, not on every keystroke');
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
    equal(releaseSources.some((value) => /v=0\.1\.\d\b/.test(value)), false, 'stale asset version');
    equal(releaseSources.some((value) => /v=0\.2\.0\b/.test(value)), false, 'stale 0.2.0 asset version');
    equal(releaseSources.some((value) => /v=0\.2\.1\b/.test(value)), false, 'stale 0.2.1 asset version');
    equal(/\.brand-copy small\s*\{[^}]*white-space:\s*nowrap/u.test(css), true, 'header subtitle element has white-space nowrap');
    equal(readFileSync(join(ROOT, 'public/js/version.js'), 'utf8').includes("VERSION = '1.0.0'"), true, 'footer version');
    const remSizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((match) => Number(match[1]));
    const pixelSizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
    equal(remSizes.every((size) => size >= 0.875), true, 'rem text is at least 14px at the 16px root');
    equal(pixelSizes.every((size) => size >= 14), true, 'pixel text is at least 14px');
  });
}
