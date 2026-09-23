import { loadClub, loadDay, loadHistory, loadIndex, loadJapan, loadNames, loadOpenLiga, loadOpenLigaPlayers, loadPhotoCredits, loadPlayers, loadRankings, loadSearch, loadSeason } from './data.js?v=0.3.2';
import { el, replace, rubyEl, rubyNodes } from './dom.js?v=0.3.2';
import { backDecision } from './navigation.js?v=0.3.2';
import { prepareIndex } from './search.js?v=0.3.2';
import { STRINGS } from './strings.js?v=0.3.2';
import { VERSION } from './version.js?v=0.3.2';
import { clubView, creditsView, errorView, homeView, japanView, leagueView, matchView, meikanChooserView, meikanView, notFoundView, photoCreditsView, playerView, rankingsView, searchView, seasonView } from './views.js?v=0.3.2';

const root = document.querySelector('#app');

function shell() {
  const main = el('main', { id: 'main', 'aria-live': 'polite' });
  const backSlot = el('span', { class: 'header-back-slot' });
  replace(root, [
    el('header', { class: 'site-header' }, el('div', { class: 'header-inner' }, [
      backSlot,
      el('a', { class: 'brand', href: '#/' }, [
        el('img', { class: 'brand-mark', src: `assets/icon.svg?v=${VERSION}`, alt: '', width: 34, height: 34 }),
        el('span', { class: 'brand-copy' }, [el('strong', {}, 'Clubpedia'), rubyEl('small', STRINGS.subtitle)]),
      ]),
      el('nav', { class: 'site-nav', 'aria-label': 'main' }, [
        el('a', { href: '#/' }, rubyNodes(STRINGS.home)),
        el('a', { href: '#/j' }, rubyNodes(STRINGS.japanFeature)),
        el('a', { href: '#/r' }, rubyNodes(STRINGS.rankings)),
        el('a', { href: '#/s' }, rubyNodes(STRINGS.search)),
      ]),
    ])),
    main,
    el('footer', { class: 'site-footer' }, [el('span', { id: 'version' }, `v${VERSION}`), el('a', { href: '#/credits' }, 'クレジット')]),
  ]);
  return { main, backSlot };
}

const { main, backSlot } = shell();
let routeNumber = 0;
let currentRoute = '/';
let visitIndex = 0;
let visitEntryStamped = false;
const visitId = `${Date.now()}-${Math.random()}`;

const backButton = el('button', { class: 'header-back', type: 'button' }, '‹ 戻る');
backButton.addEventListener('click', () => {
  const decision = backDecision(currentRoute, visitIndex > 0);
  if (decision.action === 'back') history.back();
  else location.hash = decision.hash;
});

function stampVisitEntry(route) {
  const state = history.state && typeof history.state === 'object' ? history.state : {};
  if (state.clubpediaVisit === visitId && Number.isInteger(state.clubpediaVisitIndex)) {
    visitIndex = state.clubpediaVisitIndex;
  } else {
    if (visitEntryStamped) visitIndex += 1;
    history.replaceState({ ...state, clubpediaVisit: visitId, clubpediaVisitIndex: visitIndex }, '');
  }
  visitEntryStamped = true;
  currentRoute = route;
  backSlot.replaceChildren(...(route === '/' ? [] : [backButton]));
}

async function leagueRoute(league) {
  const [index, historyData] = await Promise.all([loadIndex(), loadHistory(league)]);
  if (!index.leagues.some((item) => item.id === league)) return notFoundView();
  return leagueView(league, index, historyData, historyData.clubs ?? {});
}

async function seasonRoute(league, year) {
  const [season, clubs] = await Promise.all([loadSeason(league, year), loadNames()]);
  const players = await loadPlayers(season.topScorers.map((row) => row.playerId));
  return seasonView(season, clubs, players);
}

async function matchRoute(key, league, year) {
  const season = await loadSeason(league, year);
  const match = season.matches.find((item) => item.key === key);
  if (!match) return notFoundView();
  let scorers = match.scorers ?? null;
  let date = match.date ?? null;
  let openLiga = false;
  if ((!scorers || !date) && league === 'de') {
    const extra = await loadOpenLiga(league, year);
    if (extra?.matches?.[key]) {
      scorers = extra.matches[key];
      openLiga = true;
    }
    if (!date && extra?.dates?.[key]) {
      date = extra.dates[key];
      openLiga = true;
    }
  }
  const renderedMatch = scorers === match.scorers && date === match.date ? match : { ...match, scorers, date };
  const playerIds = scorers ? [...scorers.home, ...scorers.away].map((item) => item.player) : [];
  return matchView(season, renderedMatch, await loadNames(), await loadPlayers(playerIds), openLiga);
}

async function clubRoute(id) {
  const [club, names] = await Promise.all([loadClub(id), loadNames()]);
  return clubView(club, names);
}

async function playerRoute(id) {
  const players = await loadPlayers([id]);
  const player = players[id];
  const [names, openLiga] = await Promise.all([
    loadNames(),
    player?.seasons?.some((season) => season.league === 'de') ? loadOpenLigaPlayers() : null,
  ]);
  return playerView(id, player, names, openLiga?.players?.[id] ?? null);
}

function todayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

async function japanRoute() {
  const [japan, names] = await Promise.all([loadJapan(), loadNames()]);
  return japanView(japan, names);
}

async function meikanRoute(league, year, clubId) {
  const [season, names] = await Promise.all([loadSeason(league, year), loadNames()]);
  const clubIds = Object.keys(season.players ?? {}).sort((a, b) => (names[a]?.name ?? a).localeCompare(names[b]?.name ?? b, 'ja'));
  const selected = clubId && clubIds.includes(clubId) ? clubId : clubIds[0];
  const entries = selected ? season.players[selected] ?? [] : [];
  const players = await loadPlayers(entries.map((entry) => entry.id));
  return meikanView(season, names, players, selected);
}

async function meikanEntryRoute(league = null) {
  const index = await loadIndex();
  if (!league) return meikanChooserView(index);
  const latest = index.seasons.filter((item) => item.id.startsWith(`${league}-`)).sort((a, b) => b.id.localeCompare(a.id))[0];
  return latest ? meikanRoute(league, latest.id.slice(3)) : notFoundView();
}

async function rankingsRoute(kind, metric) {
  const [rankings, names] = await Promise.all([loadRankings(), loadNames()]);
  return rankingsView(rankings, names, kind, metric);
}

let searchContextPromise = null;
function loadSearchContext() {
  if (!searchContextPromise) {
    searchContextPromise = Promise.all([loadSearch(), loadNames()])
      .then(([entries, names]) => ({ index: prepareIndex(entries), names }))
      .catch((error) => { searchContextPromise = null; throw error; });
  }
  return searchContextPromise;
}

function searchOptions(path, query, eager = false) {
  return {
    initialQuery: query,
    eager,
    loadContext: loadSearchContext,
    updateUrl: (value) => {
      const suffix = value ? `?q=${encodeURIComponent(value)}` : '';
      history.replaceState(history.state, '', `#${path}${suffix}`);
    },
  };
}

export async function renderRoute() {
  const current = ++routeNumber;
  const rawRoute = location.hash.slice(1) || '/';
  const separator = rawRoute.indexOf('?');
  const route = separator < 0 ? rawRoute : rawRoute.slice(0, separator);
  const parameters = new URLSearchParams(separator < 0 ? '' : rawRoute.slice(separator + 1));
  const query = parameters.get('q') || '';
  stampVisitEntry(route);
  window.scrollTo(0, 0);
  replace(main, rubyEl('p', STRINGS.loading, { class: 'loading' }));
  try {
    let view;
    if (route === '/') {
      const [index, day] = await Promise.all([loadIndex(), loadDay(todayKey())]);
      view = homeView(index, searchOptions('/', ''), day);
    }
    else if (route === '/credits') view = creditsView();
    else if (route === '/credits/photos') view = photoCreditsView(await loadPhotoCredits());
    else if (route === '/j') view = await japanRoute();
    else if (route === '/s') view = searchView(searchOptions('/s', query, true));
    else {
      const leagueMatch = /^\/l\/([a-z]{2})$/.exec(route);
      const seasonMatch = /^\/s\/([a-z]{2})\/(\d{4})$/.exec(route);
      const matchMatch = /^\/m\/(([a-z]{2})-(\d{4})-Q\d+-Q\d+)$/.exec(route);
      const clubMatch = /^\/c\/(Q\d+)$/.exec(route);
      const playerMatch = /^\/p\/(Q\d+)$/.exec(route);
      const meikanEntryMatch = /^\/z(?:\/([a-z]{2}))?$/.exec(route);
      const meikanMatch = /^\/z\/([a-z]{2})\/(\d{4})(?:\/(Q\d+))?$/.exec(route);
      const rankingMatch = /^\/r(?:\/(players|clubs)\/([a-zA-Z]+))?$/.exec(route);
      if (leagueMatch) view = await leagueRoute(leagueMatch[1]);
      else if (seasonMatch) view = await seasonRoute(seasonMatch[1], seasonMatch[2]);
      else if (matchMatch) view = await matchRoute(matchMatch[1], matchMatch[2], matchMatch[3]);
      else if (clubMatch) view = await clubRoute(clubMatch[1]);
      else if (playerMatch) view = await playerRoute(playerMatch[1]);
      else if (meikanEntryMatch) view = await meikanEntryRoute(meikanEntryMatch[1]);
      else if (meikanMatch) view = await meikanRoute(meikanMatch[1], meikanMatch[2], meikanMatch[3]);
      else if (rankingMatch) view = await rankingsRoute(rankingMatch[1] || 'players', rankingMatch[2] || 'goals');
      else view = notFoundView();
    }
    if (current === routeNumber) replace(main, view);
  } catch (error) {
    console.error(error);
    if (current === routeNumber) replace(main, errorView(renderRoute));
  }
}

window.addEventListener('hashchange', renderRoute);
renderRoute();
