# Data license

The data files are published under two licences, kept in separate files.

## CC BY-SA 4.0 — everything except `public/data/o/`

The files in `public/data/` (except `public/data/o/`) and `curated/` are
licensed under the **Creative Commons Attribution-ShareAlike 4.0 International
License** (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/legalcode

They are derived from:

- **English Wikipedia** — league season articles, league table templates,
  club season articles, lists of champions and top scorers, player articles.
  https://en.wikipedia.org — CC BY-SA 4.0.
- **Japanese Wikipedia** — Japanese names of clubs and players, Japanese
  players' season statistics. https://ja.wikipedia.org — CC BY-SA 4.0.
- **Wikidata** — player and club identifiers and dates of birth.
  https://www.wikidata.org — CC0 1.0.

## ODbL 1.0 — `public/data/o/`

The files in `public/data/o/` (Bundesliga goal events) are derived from
**OpenLigaDB** (https://www.openligadb.de) and are made available under the
**Open Database License** (ODbL 1.0): https://opendatacommons.org/licenses/odbl/1-0/

## Modifications

- Restricted to the top divisions of England, Spain, Germany, Italy and France,
  seasons 1992-93 to 2025-26 (champions and top scorers: all seasons).
- Official league tables kept as published; results checked against them, with
  reviewed corrections where the two disagree.
- Goal scorers kept only where they reconcile with the final score.
- Clubs and players re-keyed by Wikidata identifier, with club lineages.
- Japanese names and reading aids added.
- Restructured into per-season, club, player and search JSON files.

No warranty is given for the accuracy of the data.
