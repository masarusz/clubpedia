# Clubpedia（クラブペディア）

**欧州5大リーグ大図鑑** — a kid-friendly encyclopedia of Europe's big five football
leagues (England, Spain, Germany, Italy, France), 1992-93 to 2025-26, in
Japanese: seasons, final tables, matches, clubs and players, plus every Japanese
player who has played in those leagues. Built for children to browse on an
iPad. A sibling of [Wcupedia](https://github.com/masarusz/wcupedia).

**Live site:** https://masarusz.github.io/clubpedia/

A static site: no accounts, no tracking, no server.

> Status: v0.2.1: leagues, seasons, matches, clubs, players, Japanese
> players, a player guide, search and rankings.

## Data

| Source | Used for | License |
|---|---|---|
| [English Wikipedia](https://en.wikipedia.org) | Tables, results, champions, top scorers, goal scorers | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/legalcode) |
| [Japanese Wikipedia](https://ja.wikipedia.org) | Japanese names, Japanese players' seasons | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/legalcode) |
| [Wikidata](https://www.wikidata.org) | Player and club identifiers, dates of birth | CC0 1.0 |
| [OpenLigaDB](https://www.openligadb.de) | Bundesliga goal scorers | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |

See [DATA-LICENSE.md](DATA-LICENSE.md). Flags: [flag-icons](https://github.com/lipis/flag-icons)
(MIT). Club crests and league logos are not used. Code is MIT — see
[LICENSE](LICENSE).

## Development

Node.js 24 or later. No package dependencies.

```bash
node tools/fetch-sources.mjs     # download the pinned sources into .cache/sources
node tools/build-data.mjs        # generate public/data (deterministic)
node tests/run.mjs               # build, then run the test suite
node scripts/serve.mjs 4183 public   # serve locally
```

`scripts/deploy.sh` publishes `public/` to the `gh-pages` branch from an
explicit allowlist and verifies every published file on the live site.

## Changelog

- **v0.2.1** — 選手名鑑 can switch league and season, and tapping a club
  shows its players; goals on player pages name the opponent and venue; the
  header fits on one row on an iPad in portrait.
- **v0.2.0** — Player pages (seasons, clubs, goals linked to their matches,
  top-scorer finishes); 日本人選手: every Japanese player in the five leagues,
  all eras; 選手名鑑 by season and club; kana search (lazily loaded); rankings
  (goals, top-scorer titles across all history, titles, points, wins).
  Match lists show 勝/分/負 next to the score, and pages load only the data
  they show (a club page went from 91 files to 2).
- **v0.1.2** — First public release. Every season of the five leagues from
  1992-93 to 2025-26 with official final tables, results and scorers; league
  pages with every champion since each league began; club pages with titles,
  positions and head-to-head records (wins highlighted); national flags;
  a credits page.
