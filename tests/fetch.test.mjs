import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clubSeasonTitle,
  discoverDataTemplates,
  extractJapanesePlayerLinks,
  extractPlayerLinks,
  extractTableClubs,
  seasonArticleTitle,
} from '../tools/lib/wikitext.mjs';
import {
  Requester,
  fetchApiWithContinue,
  parseMetadataResponse,
  parseRevisionResponse,
  parseWikidataResponse,
  safeName,
  stableJson,
  unsafeName,
} from '../tools/lib/source-api.mjs';
import { runFetchSources } from '../tools/fetch-sources.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const fixture = (path) => readFile(join(FIXTURES, path), 'utf8');
const fixtureJson = async (path) => JSON.parse(await fixture(path));

function fakeResponse(body, { status = 200, headers = {} } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'error',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(bytes.toString('utf8')),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function revisionPage(title, content, revid) {
  return { pageid: revid, title, revisions: [{ revid, timestamp: '2026-09-23T00:00:00Z', slots: { main: { content } } }] };
}

export function register(test, equal, deepEqual) {
  test('season titles cover all five leagues and every 1992–2025 start year', () => {
    for (const league of ['en', 'es', 'de', 'it', 'fr']) {
      for (let year = 1992; year <= 2025; year += 1) {
        const title = seasonArticleTitle(league, year);
        equal(title.includes('–'), true, `${league}-${year} uses an en dash`);
        equal(/^\d{4}–(?:\d{2}|\d{4}) /.test(title), true, `${league}-${year} has a season prefix`);
      }
    }
    equal(seasonArticleTitle('en', 2006), '2006–07 FA Premier League');
    equal(seasonArticleTitle('en', 2007), '2007–08 Premier League');
    equal(seasonArticleTitle('fr', 2001), '2001–02 French Division 1');
    equal(seasonArticleTitle('fr', 2002), '2002–03 Ligue 1');
    equal(seasonArticleTitle('en', 1999), '1999–2000 FA Premier League');
  });

  test('template discovery finds transcluded tables case-insensitively', async () => {
    const laLiga = await fixture('wikitext/2025–26_La_Liga.wikitext');
    const bundesliga = await fixture('wikitext/2019–20_Bundesliga.wikitext');
    deepEqual(discoverDataTemplates(laLiga, '2025–26 La Liga'), ['Template:2025–26 La Liga table']);
    deepEqual(discoverDataTemplates(bundesliga, '2019–20 Bundesliga'), ['Template:2019–20 Bundesliga table']);
    deepEqual(discoverDataTemplates('{{2020–21 TEST RESULTS}}', '2020–21 Test'), ['Template:2020–21 TEST RESULTS']);
  });

  test('club extraction handles team_order, team1, linked, and bare names', async () => {
    const modern = extractTableClubs(await fixture('wikitext/Template:2025–26_La_Liga_table.wikitext'));
    equal(modern.length, 20);
    deepEqual(modern[0], { code: 'BAR', target: 'FC Barcelona', label: 'Barcelona', linked: true });
    const old = extractTableClubs(await fixture('wikitext/1999–2000_FA_Premier_League.wikitext'));
    equal(old.length, 20);
    equal(old[0].target, 'Manchester United F.C.');
    const bare = extractTableClubs('{{#invoke:Sports table|main|team1=ABC|name_ABC=Bare Town}}');
    deepEqual(bare, [{ code: 'ABC', target: 'Bare Town', label: 'Bare Town', linked: false }]);
    equal(clubSeasonTitle(1999, old[0].target), '1999–2000 Manchester United F.C. season');
  });

  test('player extraction reads match-box goals and top-scorer tables', async () => {
    const arsenal = extractPlayerLinks(await fixture('wikitext/2023–24_Arsenal_F.C._season.wikitext'));
    const inter = extractPlayerLinks(await fixture('wikitext/2023–24_Inter_Milan_season.wikitext'));
    const pichichi = extractPlayerLinks(await fixture('wikitext/Pichichi_Trophy.wikitext'), { topScorerPage: true });
    equal(arsenal.includes('Harry Kane'), true);
    equal(inter.includes('Takefusa Kubo'), true);
    equal(pichichi.includes('Kylian Mbappé'), true);
  });

  test('Japan-section extraction selects the first linked player in each row', () => {
    const text = '==Players==\n===Japan===\n{|\n|-\n| [[Takefusa Kubo]] || [[Real Sociedad]]\n|-\n| [[Kaoru Mitoma]] || [[Brighton & Hove Albion F.C.|Brighton]]\n|}\n===Korea===\n|-\n| [[Someone Else]]';
    deepEqual(extractJapanesePlayerLinks(text), ['Kaoru Mitoma', 'Takefusa Kubo']);
  });

  test('revision API parsing handles missing, normalized, and redirected pages', async () => {
    const real = parseRevisionResponse(await fixtureJson('api/enwiki-revisions-batch.json'));
    equal(real.some((page) => page.missing && page.title.includes('Nonexistent')), true);
    equal(real.find((page) => page.title === '1999–2000 FA Premier League').revid, 1373401087);
    const synthetic = {
      query: {
        normalized: [{ from: 'foo_bar', to: 'Foo bar' }],
        redirects: [{ from: 'Foo bar', to: 'Final title' }],
        pages: [revisionPage('Final title', 'body', 7)],
      },
    };
    const [page] = parseRevisionResponse(synthetic, ['foo_bar']);
    equal(page.title, 'Final title');
    equal(page.redirectedFrom, 'foo_bar');
  });

  test('API continuation is followed and merged', async () => {
    let calls = 0;
    const requester = new Requester({
      minimumWikimediaDelay: 0,
      sleep: async () => {},
      fetchImpl: async (url) => {
        calls += 1;
        const continued = new URL(url).searchParams.has('rvcontinue');
        return fakeResponse(continued
          ? { batchcomplete: true, query: { pages: [revisionPage('Second', 'b', 2)] } }
          : { continue: { rvcontinue: 'next', continue: '||' }, query: { pages: [revisionPage('First', 'a', 1)] } });
      },
    });
    const response = await fetchApiWithContinue(requester, 'https://example.invalid/api', { action: 'query' }, 'continuation fixture');
    equal(calls, 2);
    deepEqual(response.query.pages.map((page) => page.title), ['First', 'Second']);
  });

  test('page metadata and Wikidata fixtures parse required identity fields', async () => {
    const metadata = parseMetadataResponse(await fixtureJson('api/enwiki-pageprops-langlinks.json'));
    equal(metadata.find((page) => page.title === 'Takefusa Kubo').wikibaseItem, 'Q27067753');
    equal(metadata.find((page) => page.title === 'Kaoru Mitoma').jaTitle, '三笘薫');
    const entities = parseWikidataResponse(await fixtureJson('api/wikidata-wbgetentities.json'));
    equal(entities.find((entity) => entity.id === 'Q9616').labels.ja.value, 'チェルシーFC');
  });

  test('safe filenames round-trip without slash or colon collisions', () => {
    for (const title of ['Template:2025–26 La Liga/table', 'A:B/C', 'A%3AB%2FC', '三笘薫']) {
      const encoded = `${safeName(title)}.json`;
      equal(encoded.includes('/'), false);
      equal(unsafeName(encoded), title);
    }
    equal(safeName('A:B/C') === safeName('A%3AB%2FC'), false);
  });

  test('lock serialization is byte-identical for differently ordered input', () => {
    const left = stableJson({ z: 1, nested: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] });
    const right = stableJson({ a: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 });
    equal(left, right);
  });

  test('offline fake fetch runs staged refresh then resumes with zero requests', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'clubpedia-fetch-test-'));
    const out = join(temporary, 'sources');
    const lockPath = join(temporary, 'sources.lock.json');
    const laLiga = await fixture('wikitext/2025–26_La_Liga.wikitext');
    const table = await fixture('wikitext/Template:2025–26_La_Liga_table.wikitext');
    const pichichi = await fixture('wikitext/Pichichi_Trophy.wikitext');
    const openLiga = Buffer.from(await fixture('openligadb/bl1-2023-matchday1.json'));
    let revision = 100;
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.hostname === 'api.openligadb.de') return fakeResponse(openLiga);
      if (parsed.hostname === 'en.wikipedia.org') {
        const action = parsed.searchParams.get('action');
        const prop = parsed.searchParams.get('prop');
        if (action === 'query' && prop === 'revisions') {
          const titles = (parsed.searchParams.get('titles') ?? '').split('|').filter(Boolean);
          const pages = titles.map((title) => {
            const content = title === '2025–26 La Liga' ? laLiga
              : title === 'Template:2025–26 La Liga table' ? table
                : title === 'Pichichi Trophy' ? pichichi : null;
            return content === null ? { title, missing: true } : revisionPage(title, content, revision++);
          });
          return fakeResponse({ batchcomplete: true, query: { pages } });
        }
        if (action === 'query' && prop === 'pageprops|langlinks') {
          const titles = parsed.searchParams.get('titles').split('|');
          return fakeResponse({ batchcomplete: true, query: { pages: titles.map((title, index) => title === 'Real Madrid CF'
            ? { pageid: 1, title, pageprops: { wikibase_item: 'Q9616' }, langlinks: [{ lang: 'ja', title: 'レアル・マドリード' }] }
            : { title, missing: true, ns: 0, index }) } });
        }
      }
      if (parsed.hostname === 'www.wikidata.org' && parsed.searchParams.get('action') === 'wbgetentities') {
        const data = await fixtureJson('api/wikidata-wbgetentities.json');
        const entity = { ...data.entities.Q9616, lastrevid: 7654321 };
        return fakeResponse({ success: 1, entities: { Q9616: entity } });
      }
      throw new Error(`Unexpected fake URL: ${url}`);
    };
    try {
      const requester = new Requester({ fetchImpl, sleep: async () => {}, minimumWikimediaDelay: 0 });
      const refreshed = await runFetchSources({
        out, lockPath, refresh: true, requester, quiet: true, leagues: ['es'], startYears: [2025],
        listTitles: ['Pichichi Trophy'], topScorerLists: ['Pichichi Trophy'], foreignLists: [],
        openLigaYears: [2023], openfootball: false,
      });
      equal(refreshed.lock.seasons['es-2025'].tableFound, true);
      equal(refreshed.lock.seasons['es-2025'].resultsFound, true);
      equal(Object.keys(refreshed.lock.wikidata).includes('Q9616'), true);
      equal(refreshed.summary.includes('club-season: 20 pages, 20 missing'), true);
      equal(requests.every(({ url }) => !url.includes('example.com')), true);
      const pinnedRequester = new Requester({ fetchImpl: async (url) => { throw new Error(`Pinned resume touched network: ${url}`); }, sleep: async () => {}, minimumWikimediaDelay: 0 });
      const resumed = await runFetchSources({ out, lockPath, requester: pinnedRequester, quiet: true, openLigaYears: [2023], openfootball: false });
      equal(resumed.requestCount, 0);
      equal(await readFile(join(out, 'SUMMARY.txt'), 'utf8'), resumed.summary);

      await rm(join(out, 'enwiki', `${safeName('2025–26 La Liga')}.json`));
      await rm(join(out, 'wikidata', 'Q9616.json'));
      const recoveryRequester = new Requester({
        sleep: async () => {}, minimumWikimediaDelay: 0,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.hostname === 'en.wikipedia.org' && parsed.searchParams.has('revids')) {
            const revid = Number(parsed.searchParams.get('revids'));
            return fakeResponse({ batchcomplete: true, query: { pages: [revisionPage('2025–26 La Liga', laLiga, revid)] } });
          }
          if (parsed.hostname === 'www.wikidata.org' && parsed.searchParams.has('revids')) {
            const data = await fixtureJson('api/wikidata-wbgetentities.json');
            const revid = Number(parsed.searchParams.get('revids'));
            return fakeResponse({ batchcomplete: true, query: { pages: [{
              pageid: 1, title: 'Q9616', revisions: [{ revid, slots: { main: { content: JSON.stringify(data.entities.Q9616) } } }],
            }] } });
          }
          throw new Error(`Pinned recovery used an unpinned endpoint: ${url}`);
        },
      });
      const recovered = await runFetchSources({ out, lockPath, requester: recoveryRequester, quiet: true, openLigaYears: [2023], openfootball: false });
      equal(recovered.requestCount, 2);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test('fetch CLI fails loudly before network when the lock is empty', () => {
    let output = '';
    try {
      execFileSync(process.execPath, [join(ROOT, 'tools', 'fetch-sources.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { output = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
    equal(output.includes('Source lock is empty; run with --refresh first'), true);
  });
}
