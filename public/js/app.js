import { loadClub, loadClubs, loadHistory, loadIndex, loadOpenLiga, loadPlayers, loadSeason } from './data.js?v=0.1.2';
import { el, replace, rubyEl, rubyNodes } from './dom.js?v=0.1.2';
import { backDecision } from './navigation.js?v=0.1.2';
import { STRINGS } from './strings.js?v=0.1.2';
import { VERSION } from './version.js?v=0.1.2';
import { clubView, creditsView, errorView, homeView, leagueView, matchView, notFoundView, seasonView } from './views.js?v=0.1.2';

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
        el('a', { href: '#/credits' }, rubyNodes(STRINGS.credits)),
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
  const compact = index.seasons.filter((item) => item.id.startsWith(`${league}-`));
  const clubIds = [...new Set([...compact.map((item) => item.champion), ...historyData.champions.map((item) => item.champion)].filter(Boolean))];
  let clubs = await loadClubs(clubIds);
  const successorIds = Object.values(clubs).flatMap((club) => club.lineage.filter((item) => item.relation === 'successor').map((item) => item.club));
  clubs = { ...clubs, ...await loadClubs(successorIds) };
  const playerIds = compact.flatMap((item) => item.topScorers.map((scorer) => scorer.playerId));
  return leagueView(league, index, historyData, clubs, await loadPlayers(playerIds));
}

async function seasonRoute(league, year) {
  const season = await loadSeason(league, year);
  const clubs = await loadClubs(season.table.map((row) => row.club));
  const players = await loadPlayers(season.topScorers.map((row) => row.playerId));
  return seasonView(season, clubs, players);
}

async function matchRoute(key, league, year) {
  const season = await loadSeason(league, year);
  const match = season.matches.find((item) => item.key === key);
  if (!match) return notFoundView();
  let scorers = match.scorers ?? null;
  let openLiga = false;
  if (!scorers && league === 'de') {
    const extra = await loadOpenLiga(league, year);
    if (extra?.matches?.[key]) {
      scorers = extra.matches[key];
      openLiga = true;
    }
  }
  const renderedMatch = scorers === match.scorers ? match : { ...match, scorers };
  const playerIds = scorers ? [...scorers.home, ...scorers.away].map((item) => item.player) : [];
  return matchView(season, renderedMatch, await loadClubs([match.home, match.away]), await loadPlayers(playerIds), openLiga);
}

async function clubRoute(id) {
  const club = await loadClub(id);
  const relatedIds = [...Object.keys(club.headToHead), ...club.lineage.map((item) => item.club), id];
  const related = await loadClubs(relatedIds);
  const players = await loadPlayers(club.topScorers.map((item) => item.player));
  return clubView(club, related, players);
}

export async function renderRoute() {
  const current = ++routeNumber;
  const route = location.hash.slice(1) || '/';
  stampVisitEntry(route);
  window.scrollTo(0, 0);
  replace(main, rubyEl('p', STRINGS.loading, { class: 'loading' }));
  try {
    let view;
    if (route === '/') view = homeView(await loadIndex());
    else if (route === '/credits') view = creditsView();
    else {
      const leagueMatch = /^\/l\/([a-z]{2})$/.exec(route);
      const seasonMatch = /^\/s\/([a-z]{2})\/(\d{4})$/.exec(route);
      const matchMatch = /^\/m\/(([a-z]{2})-(\d{4})-Q\d+-Q\d+)$/.exec(route);
      const clubMatch = /^\/c\/(Q\d+)$/.exec(route);
      if (leagueMatch) view = await leagueRoute(leagueMatch[1]);
      else if (seasonMatch) view = await seasonRoute(seasonMatch[1], seasonMatch[2]);
      else if (matchMatch) view = await matchRoute(matchMatch[1], matchMatch[2], matchMatch[3]);
      else if (clubMatch) view = await clubRoute(clubMatch[1]);
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
