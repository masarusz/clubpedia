import { el, rubyEl, rubyNodes, text } from './dom.js?v=0.1.2';
import { minuteLabel, playerName, seasonLabel, signed } from './format.js?v=0.1.2';
import { STRINGS } from './strings.js?v=0.1.2';
import { VERSION } from './version.js?v=0.1.2';

const LEAGUE_NAMES = Object.freeze({
  en: 'プレミアリーグ', es: 'ラ・リーガ', de: 'ブンデスリーガ', it: 'セリエA', fr: 'リーグ・アン',
});

const LEAGUE_COUNTRIES = Object.freeze({
  en: { name: 'イングランド', flag: 'gb-eng.svg' },
  es: { name: 'スペイン', flag: 'es.svg' },
  de: { name: 'ドイツ', flag: 'de.svg' },
  it: { name: 'イタリア', flag: 'it.svg' },
  fr: { name: 'フランス', flag: 'fr.svg' },
});

function leagueFlag(league) {
  const country = LEAGUE_COUNTRIES[league];
  return el('img', {
    class: 'league-flag', src: `assets/flags/${country.flag}?v=${VERSION}`, alt: country.name, width: 36, height: 27,
  });
}

function leagueTitle(league) {
  return [leagueFlag(league), text(LEAGUE_NAMES[league])];
}

function chip(colour) {
  const node = el('span', { class: 'club-chip', role: 'presentation' });
  const safe = typeof colour === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(colour) ? colour : '#9aa4a0';
  node.style.backgroundColor = safe;
  return node;
}

function clubName(club, fallback = 'クラブ') {
  return club?.names?.ja ?? fallback;
}

function clubNameNodes(name) {
  const parts = String(name).split('・');
  const nodes = [];
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    nodes.push(text(last ? part : `${part}・`));
    if (!last) nodes.push(el('wbr'));
  });
  return nodes;
}

function clubLink(id, clubs, className = 'club-link', breakable = false) {
  const club = clubs[id];
  const name = clubName(club, id);
  return el('a', { class: className, href: `#/c/${id}` }, [chip(club?.colour), ...(breakable ? clubNameNodes(name) : [text(name)])]);
}

function playerLink(id, players, fallback) {
  if (!id) return el('span', { class: 'player-name' }, fallback ?? '記録なし');
  return el('a', { class: 'player-link', href: `#/p/${id}` }, playerName(players[id], fallback));
}

function section(title, children, className = '') {
  return el('section', { class: `panel ${className}`.trim() }, [el('h2', {}, title), children]);
}

function canonicalClub(id, clubs) {
  let current = id;
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    const successor = clubs[current]?.lineage?.find((entry) => entry.relation === 'successor')?.club;
    if (!successor) return current;
    current = successor;
  }
  return id;
}

export function homeView(index) {
  const cards = index.leagues.map((league) => {
    const champion = league.latest?.champion;
    return el('a', { class: `league-card league-${league.id}`, href: `#/l/${league.id}` }, [
      el('div', { class: 'league-card-title' }, [leagueFlag(league.id), el('h2', {}, league.name)]),
      el('p', { class: 'latest-season' }, `${league.latest?.season ?? ''}シーズン`),
      champion
        ? el('p', { class: 'latest-champion' }, [chip(champion.colour), text(`優勝 ${champion.name}`)])
        : el('p', { class: 'latest-champion' }, '優勝チームなし'),
    ]);
  });
  return el('section', { class: 'page home-page' }, [
    el('div', { class: 'page-heading' }, [el('h1', {}, '欧州5大リーグ')]),
    el('div', { class: 'league-grid' }, cards),
  ]);
}

export function leagueView(league, index, history, clubs, players) {
  const seasons = index.seasons.filter((item) => item.id.startsWith(`${league}-`)).sort((a, b) => b.id.localeCompare(a.id));
  const seasonRows = seasons.map((item) => el('li', { class: 'season-row' }, [
    el('a', { class: 'season-link', href: `#/s/${league}/${item.id.slice(3)}` }, `${item.label}シーズン`),
    item.champion ? el('span', { class: 'season-champion' }, [text('優勝 '), clubLink(item.champion, clubs)]) : el('strong', { class: 'no-champion' }, '優勝チームなし'),
    el('span', { class: 'season-scorers' }, item.topScorers.length ? [
      text('得点王 '),
      item.topScorers.flatMap((scorer, indexValue) => [indexValue ? text('、') : null, playerLink(scorer.playerId, players, scorer.player), text(` ${scorer.goals}得点`)]),
    ] : '得点王の記録なし'),
  ]));

  const champions = [...history.champions].sort((a, b) => b.season.localeCompare(a.season));
  const entryCounts = new Map();
  const printedCounts = new Map();
  for (const item of champions) if (item.champion) {
    const id = canonicalClub(item.champion, clubs);
    entryCounts.set(id, (entryCounts.get(id) ?? 0) + 1);
    if (item.printedCount != null) printedCounts.set(id, Math.max(printedCounts.get(id) ?? 0, item.printedCount));
  }
  const counts = new Map([...entryCounts].map(([id, count]) => [id, Math.max(count, printedCounts.get(id) ?? 0)]));
  let previousCount = null;
  let previousRank = 0;
  const ranking = [...counts].sort((a, b) => b[1] - a[1] || clubName(clubs[a[0]], a[0]).localeCompare(clubName(clubs[b[0]], b[0]), 'ja'))
    .map(([id, count], indexValue) => {
      const rank = count === previousCount ? previousRank : indexValue + 1;
      previousCount = count;
      previousRank = rank;
      return el('li', { class: 'title-row' }, [el('span', { class: 'rank' }, `${rank}位`), clubLink(id, clubs), el('strong', {}, `${count}回`)]);
    });

  return el('article', { class: 'page league-page' }, [
    el('div', { class: 'page-heading' }, [el('p', { class: 'eyebrow' }, LEAGUE_COUNTRIES[league].name), el('h1', { class: 'league-heading' }, leagueTitle(league))]),
    section('シーズン', el('ol', { class: 'season-list' }, seasonRows), 'season-panel'),
    section('優勝回数', el('ol', { class: 'title-ranking' }, ranking), 'title-panel'),
    section('歴代優勝チーム', el('ol', { class: 'history-list' }, champions.map((item) => el('li', {}, [
      el('span', { class: 'history-season' }, item.season),
      item.champion ? clubLink(item.champion, clubs) : el('strong', { class: 'no-champion' }, '優勝チームなし'),
    ]))), 'history-panel'),
  ]);
}

function deductionReason(reason) {
  const value = String(reason ?? '').toLowerCase();
  if (/financial|profitability|accounting|tax|wage|payment|administration|bankruptcy|licens/.test(value)) return 'クラブのお金や登録の規則に違反したためです。';
  if (/brib|calciopoli|scandal/.test(value)) return '不正な行為があったためです。';
  if (/crowd|supporter|abandon|incident/.test(value)) return '観客の問題で試合を続けられなかったためです。';
  if (/foreign players|quota/.test(value)) return '外国人選手の人数の規則に違反したためです。';
  if (/fixture|fulfill/.test(value)) return '決められた試合を行わなかったためです。';
  return '規則により勝点が引かれました。';
}

function matchResult(match, selectedClub) {
  if (match.status === 'double-defeat') return 'loss';
  if (match.status === 'awarded') return match.winner === selectedClub ? 'win' : 'loss';
  const selectedGoals = match.home === selectedClub ? match.homeGoals : match.awayGoals;
  const opposingGoals = match.home === selectedClub ? match.awayGoals : match.homeGoals;
  return selectedGoals > opposingGoals ? 'win' : selectedGoals < opposingGoals ? 'loss' : 'draw';
}

function resultMark(result) {
  const labels = { win: '勝', draw: '分', loss: '負' };
  return el('span', { class: `result-mark result-${result}` }, labels[result]);
}

function matchRow(match, clubs, selectedClub) {
  const result = matchResult(match, selectedClub);
  return el('li', { class: `match-row match-${result}` }, [
    clubLink(match.home, clubs),
    el('a', { class: 'score-link', href: `#/m/${match.key}` }, `${match.homeGoals}–${match.awayGoals}`),
    clubLink(match.away, clubs),
    resultMark(result),
  ]);
}

export function seasonView(season, clubs, players) {
  const deductions = season.table.filter((row) => row.adjustment < 0);
  const table = el('table', { class: 'standings-table' }, [
    el('thead', {}, el('tr', {}, ['順位', 'クラブ', '試合', '勝', '分', '負', '得点', '失点', '得失点', '勝点'].map((label) => el('th', { scope: 'col' }, label)))),
    el('tbody', {}, season.table.map((row) => el('tr', { class: row.unreconciled ? 'unreconciled' : '' }, [
      el('td', {}, String(row.position)),
      el('td', {}, [clubLink(row.club, clubs, 'club-link', true), row.club === season.champion ? el('span', { class: 'badge champion-badge' }, '優勝') : null, String(row.status ?? '').includes('R') ? el('span', { class: 'badge relegated-badge' }, '降格') : null, row.unreconciled ? el('small', { class: 'row-note' }, '記録によって数字がちがいます') : null]),
      el('td', {}, String(row.w + row.d + row.l)), el('td', {}, String(row.w)), el('td', {}, String(row.d)), el('td', {}, String(row.l)),
      el('td', {}, String(row.gf)), el('td', {}, String(row.ga)), el('td', {}, signed(row.gf - row.ga)), el('td', {}, String(row.points)),
    ]))),
  ]);

  const selector = el('select', { id: 'club-results', class: 'club-select', name: 'club' }, season.table.map((row, indexValue) =>
    el('option', { value: row.club, selected: indexValue === 0 }, clubName(clubs[row.club], row.club))));
  const results = el('ol', { class: 'match-list' });
  const renderMatches = () => {
    const selected = selector.value || season.table[0].club;
    results.replaceChildren(...season.matches.filter((match) => match.home === selected || match.away === selected).map((match) => matchRow(match, clubs, selected)));
  };
  selector.addEventListener('change', renderMatches);
  if (!selector.value) selector.value = season.table[0].club;
  renderMatches();

  return el('article', { class: 'page season-page' }, [
    el('div', { class: 'page-heading' }, [el('p', { class: 'eyebrow league-eyebrow' }, leagueTitle(season.league)), el('h1', {}, seasonLabel(season.year))]),
    season.champion ? el('p', { class: 'season-winner panel' }, [text('優勝 '), clubLink(season.champion, clubs)]) : el('p', { class: 'season-winner panel no-champion' }, '優勝チームなし'),
    section('順位表', [el('div', { class: 'table-shell' }, table), season.pointSystem?.win === 2 ? el('p', { class: 'plain-note' }, 'このころは勝ちが2点でした') : null,
      deductions.length ? el('ul', { class: 'footnotes' }, deductions.map((row) => el('li', {}, [clubLink(row.club, clubs), text(`は勝点が${Math.abs(row.adjustment)}引かれました。${deductionReason(row.adjustmentReason)}`)]))) : null], 'standings-panel'),
    section('得点王', season.topScorers.length ? el('ol', { class: 'scorer-list' }, season.topScorers.map((scorer) => el('li', {}, [
      el('span', { class: 'rank' }, `${scorer.rank}位`), playerLink(scorer.playerId, players, scorer.player), clubLink(scorer.club, clubs), el('strong', {}, `${scorer.goals}得点`),
    ]))) : el('p', {}, '得点王の記録なし'), 'scorers-panel'),
    section('試合', [el('label', { for: 'club-results' }, 'クラブを選ぶ'), selector, results], 'results-panel'),
  ]);
}

function scorerRows(events, players) {
  return [...events].sort((a, b) => Number.parseInt(a.minute, 10) - Number.parseInt(b.minute, 10)).map((event) => el('li', {}, [
    el('span', { class: 'minute' }, minuteLabel(event.minute)),
    playerLink(event.player, players, event.display ?? event.name),
    event.penalty || event.isPenalty ? el('span', { class: 'badge' }, 'PK') : null,
    event.ownGoal ? el('span', { class: 'badge' }, 'オウンゴール') : null,
  ]));
}

export function matchView(season, match, clubs, players, openLiga = false) {
  const scorers = match.scorers;
  const homeEvents = scorers?.home ?? [];
  const awayEvents = scorers?.away ?? [];
  const winnerName = match.winner ? clubName(clubs[match.winner], match.winner) : null;
  const ruling = match.status === 'awarded'
    ? el('p', { class: 'special-note' }, `試合のあとで、${winnerName}の勝ちになりました${/^\d+[–-]\d+$/.test(match.pitchScore ?? '') ? `（グラウンドでは ${match.pitchScore}）` : ''}`)
    : match.status === 'double-defeat' ? el('p', { class: 'special-note' }, '両チームとも負けになりました') : null;
  const scorerHeading = match.status === 'awarded' && /^\d+[–-]\d+$/.test(match.pitchScore ?? '')
    ? `グラウンドでの得点（${match.pitchScore.replace('–', '-')}）`
    : '得点者';
  return el('article', { class: 'page match-page' }, [
    el('div', { class: 'page-heading' }, [el('p', { class: 'eyebrow' }, `${LEAGUE_NAMES[season.league]} ${seasonLabel(season.year)}`), el('h1', {}, '試合')]),
    el('section', { class: 'match-hero panel' }, [
      clubLink(match.home, clubs, 'match-club'),
      el('strong', { class: 'match-score' }, `${match.homeGoals}–${match.awayGoals}`),
      clubLink(match.away, clubs, 'match-club'),
    ]),
    ruling,
    section(scorerHeading, homeEvents.length || awayEvents.length ? el('div', { class: 'scoring-columns' }, [
      el('div', {}, [el('h3', {}, clubName(clubs[match.home], match.home)), el('ol', { class: 'goal-list' }, scorerRows(homeEvents, players))]),
      el('div', {}, [el('h3', {}, clubName(clubs[match.away], match.away)), el('ol', { class: 'goal-list' }, scorerRows(awayEvents, players))]),
    ]) : el('p', {}, '得点者の記録なし'), 'goals-panel'),
    openLiga ? el('p', { class: 'source-note' }, '得点者：OpenLigaDB（ODbL 1.0）') : null,
  ]);
}

export function clubView(club, relatedClubs, players) {
  const leagues = club.leagues.map((id) => LEAGUE_NAMES[id]).join('・') || 'リーグ記録なし';
  const titleItems = [...club.championSeasons].sort((a, b) => b.season.localeCompare(a.season));
  const opponents = Object.entries(club.headToHead).sort((a, b) => b[1].p - a[1].p || clubName(relatedClubs[a[0]], a[0]).localeCompare(clubName(relatedClubs[b[0]], b[0]), 'ja'));
  return el('article', { class: 'page club-page' }, [
    el('div', { class: 'page-heading club-heading' }, [chip(club.colour), el('div', {}, [el('p', { class: 'eyebrow' }, leagues), el('h1', {}, club.names.ja)])]),
    section('優勝回数', [el('strong', { class: 'title-total' }, `${club.titleCount ?? titleItems.length}回`), titleItems.length ? el('ul', { class: 'season-chip-list' }, titleItems.map((item) => el('li', { class: item.note ? 'extra-title' : null }, [item.season, item.note ? el('span', { class: 'title-note' }, item.note) : null]))) : el('p', {}, '優勝の記録なし')], 'club-titles'),
    club.lineage.length ? section('クラブのつながり', el('ul', { class: 'lineage-list' }, club.lineage.map((item) => el('li', {}, [text(item.relation === 'predecessor' ? '前身 ' : '後継 '), clubLink(item.club, relatedClubs)]))), 'lineage-panel') : null,
    section('シーズン順位', el('ol', { class: 'position-list' }, club.positions.map((item) => el('li', {}, [el('a', { href: `#/s/${item.season.slice(0, 2)}/${item.season.slice(3)}` }, `${item.season.slice(3)}–${String(Number(item.season.slice(3)) + 1).slice(-2)}シーズン`), el('strong', {}, `${item.position}位`)]))), 'positions-panel'),
    section('対戦成績', el('div', { class: 'opponents-table-wrap' }, el('table', { class: 'opponents-table' }, [
      el('thead', {}, el('tr', {}, ['クラブ', '試合', '勝', '分', '負', '得点', '失点'].map((label) => el('th', { scope: 'col' }, label)))),
      el('tbody', {}, opponents.map(([opponent, stats]) => el('tr', {}, [
        el('td', {}, el('details', {}, [el('summary', {}, clubLink(opponent, relatedClubs, 'club-link', true)), el('ol', { class: 'opponent-matches' }, stats.matches.map((key, indexValue) => ({ key, result: { w: 'win', d: 'draw', l: 'loss' }[stats.outcomes[indexValue]] })).reverse().map((match) => el('li', { class: `opponent-match-row match-${match.result}` }, [
          el('a', { href: `#/m/${match.key}` }, `${match.key.slice(3, 7)}–${String(Number(match.key.slice(3, 7)) + 1).slice(-2)}シーズンの試合`),
          resultMark(match.result),
        ])))])),
        ...['p', 'w', 'd', 'l', 'gf', 'ga'].map((key) => el('td', {}, String(stats[key]))),
      ]))),
    ])), 'head-to-head-panel'),
    section('得点ランキング', club.topScorers.length ? el('ol', { class: 'scorer-list club-scorers' }, club.topScorers.map((item, indexValue) => el('li', {}, [el('span', { class: 'rank' }, `${indexValue + 1}位`), playerLink(item.player, players), el('strong', {}, `${item.goals}得点`)]))) : el('p', {}, '得点の記録なし'), 'club-scorers-panel'),
  ]);
}

export function creditsView() {
  return el('article', { class: 'page credits-page' }, [
    el('div', { class: 'page-heading' }, [el('p', { class: 'eyebrow' }, 'Clubpedia'), el('h1', {}, 'クレジット')]),
    section('データの出典', el('ul', { class: 'credit-list' }, [
      el('li', {}, [el('a', { href: 'https://en.wikipedia.org/' }, '英語版Wikipedia'), text('・'), el('a', { href: 'https://ja.wikipedia.org/' }, '日本語版Wikipedia'), text(' — CC BY-SA 4.0')]),
      el('li', {}, [el('a', { href: 'https://www.wikidata.org/' }, 'Wikidata'), text(' — CC0')]),
      el('li', {}, [el('a', { href: 'https://openligadb.de/' }, 'OpenLigaDB'), text(' — ODbL 1.0')]),
      el('li', {}, [el('a', { href: 'https://github.com/lipis/flag-icons' }, 'flag-icons'), text(' — MIT License')]),
    ])),
    section('変更したところ', el('p', {}, '必要な情報を選び、整理し、クラブと選手にキーを付け、日本語名を加えています。')),
    section('コード', el('p', {}, [text('サイトのコードは '), el('a', { href: 'https://github.com/masarusz/clubpedia' }, 'GitHub'), text(' で公開しています。') ])),
    section('エンブレムについて', el('p', {}, 'クラブのエンブレムやリーグのロゴは使っていません。クラブは名前とユニフォームの色で表しています。')),
  ]);
}

export function notFoundView() {
  return el('section', { class: 'page message-page' }, [rubyEl('h1', STRINGS.pageNotFound), el('a', { class: 'button-link', href: '#/' }, 'ホームへ')]);
}

export function errorView(retry) {
  const button = rubyEl('button', STRINGS.retry, { class: 'retry-button', type: 'button' });
  button.addEventListener('click', retry);
  return el('section', { class: 'page message-page error-view' }, [rubyEl('h1', STRINGS.dataError), button]);
}

export { LEAGUE_NAMES };
