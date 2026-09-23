#!/bin/bash
# Clubpedia deploy — publishes public/ to the gh-pages branch, which GitHub Pages
# serves at https://masarusz.github.io/clubpedia/
#
# Copied from Wcupedia (itself adapted from 出番表 / debanhyo); every rule below exists
# because something went wrong without it on an earlier project.
#
#   ./scripts/deploy.sh --dry-run    show what would ship, touch nothing
#   ./scripts/deploy.sh              publish and verify
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
SITE="https://masarusz.github.io/clubpedia"
BRANCH="gh-pages"
WORKTREE=".publish"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# /usr/bin/git is a shim that refuses to run until the Xcode licence is accepted
# (measured 2026-09-23); the Command Line Tools git works regardless.
if ! git --version >/dev/null 2>&1; then
  git() { /Library/Developer/CommandLineTools/usr/bin/git "$@"; }
fi

fail() { echo "DEPLOY FAILED: $*" >&2; exit 1; }
TMP_LOG="$(mktemp)"
trap 'rm -f "$TMP_LOG"' EXIT

# --- 1. Preflight -----------------------------------------------------------
echo "== preflight"
node tests/run.mjs > "$TMP_LOG" 2>&1 \
  || { tail -40 "$TMP_LOG"; fail "test suite is red - refusing to deploy"; }
echo "   tests: $(tail -1 "$TMP_LOG")"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "   WARNING: working tree is not clean; deploying the files on disk"
fi

# --- 2. The allowlist -------------------------------------------------------
# NAME WHAT PRODUCTION RUNS, never what it must not have. These are fixed
# patterns, not a blocklist: a new kind of file (a .DS_Store, a draft, a
# report) matches none of them and is simply not published. Every pattern must
# match at least one file, so a renamed directory fails loudly here instead of
# shipping a half-empty site.
PATTERNS=(
  "index.html"
  "manifest.webmanifest"
  "css/*.css"
  "js/*.js"
  "data/*.json"
  "data/s/*.json"
  "data/c/*.json"
  "data/o/*.json"
  "assets/*.png"
)
FILES=()
shopt -s nullglob
for p in "${PATTERNS[@]}"; do
  matches=( public/$p )
  [[ ${#matches[@]} -gt 0 ]] || fail "allowlist pattern matched nothing: public/$p"
  printf '   %-40s %3d file(s)\n' "$p" "${#matches[@]}"
  for m in "${matches[@]}"; do FILES+=( "${m#public/}" ); done
done
shopt -u nullglob
echo "== allowlist: ${#FILES[@]} files"

if [[ $DRY_RUN -eq 1 ]]; then
  echo; echo "== dry run: nothing was written, nothing was pushed"; exit 0
fi

# --- 3. Stage the publish branch -------------------------------------------
echo "== staging $BRANCH"
git worktree remove --force "$WORKTREE" 2>/dev/null || true
rm -rf "$WORKTREE"
git worktree prune
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WORKTREE" "$BRANCH" >/dev/null
elif git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "$BRANCH:$BRANCH"
  git worktree add "$WORKTREE" "$BRANCH" >/dev/null
else
  # First publish: an EMPTY worktree on a new unborn branch. Measured 2026-09-11:
  # `worktree add --detach` + `checkout --orphan` keeps every file of main staged,
  # and `git rm` then refuses ("files have changes staged in the index").
  git worktree add --orphan -b "$BRANCH" "$WORKTREE" >/dev/null
fi
# Remove everything tracked, then lay down exactly the allowlist. The error from
# `git rm` is not suppressed: a partial cleanup must not leave a stray file.
if [[ -n "$( cd "$WORKTREE" && git ls-files )" ]]; then
  ( cd "$WORKTREE" && git rm -rfq . ) || fail "could not clear the $BRANCH worktree"
fi
( cd "$WORKTREE" && git clean -fdq ) || fail "could not clean the $BRANCH worktree"
for f in "${FILES[@]}"; do
  mkdir -p "$WORKTREE/$(dirname "$f")"
  cp "public/$f" "$WORKTREE/$f"
done
# .nojekyll: without it Pages runs Jekyll, which drops files starting with "_".
touch "$WORKTREE/.nojekyll"

# The published tree must be EXACTLY the allowlist plus .nojekyll.
# Stage the allowlist by name, never `git add -A`: measured 2026-09-11, macOS
# wrote .DS_Store into the fresh worktree between the copy and the add (the
# gh-pages branch has no .gitignore), `add -A` staged it, and the check below
# refused the deploy. Untracked junk now stays out of the commit; the exact-tree
# check still catches anything that does get staged.
( cd "$WORKTREE"
  git add -- "${FILES[@]}" .nojekyll
  EXPECTED=$(printf '%s\n' "${FILES[@]}" .nojekyll | sort)
  ACTUAL=$(git ls-files | sort)
  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "   published tree does not match the allowlist:" >&2
    diff <(echo "$EXPECTED") <(echo "$ACTUAL") | sed 's/^/     /' >&2
    exit 90
  fi
  if git diff --cached --quiet; then echo "   no changes to publish"
  else git commit -q -m "Publish $(date -u +%Y-%m-%dT%H:%M:%SZ)"; fi
  git push -q origin "$BRANCH" ) || fail "staging or pushing $BRANCH failed"
echo "   pushed $BRANCH"
git worktree remove --force "$WORKTREE" 2>/dev/null || true

# --- 4. Verify EVERY deployed file against the live host --------------------
# Pages builds asynchronously; a fixed sleep races it. Poll until every file
# matches, re-fetching only the files that still differ, for up to ~5 minutes.
# The check asks for the real path with a no-cache header - a ?v= URL proves
# nothing, because static hosts ignore query strings.
# Checked 16 at a time: on Wcupedia several thousand player photos made one
# sequential curl per file take 20-30 minutes a round (estimated 2026-09-11). Every file is still checked; only the waiting is parallel. Paths
# never contain spaces or quotes (allowlist patterns), so xargs -I is safe.
# `mismatches` reads paths on stdin and prints each one whose live bytes differ
# from public/ (a failed fetch hashes the empty string, so it counts as a DIFF).
mismatches() {
  xargs -P 16 -I{} sh -c 'want=$(shasum -a 256 "public/$1" | cut -d" " -f1); got=$(curl -sS --fail -H "Cache-Control: no-cache" "$2/$1" 2>/dev/null | shasum -a 256 | cut -d" " -f1); [ "$got" = "$want" ] || echo "$1"' _ {} "$SITE"
}
PENDING=( "${FILES[@]}" )
echo "== waiting for Pages to publish ${#FILES[@]} files (up to ~10 min)"
for i in $(seq 1 40); do
  STILL=( $(printf '%s\n' "${PENDING[@]}" | mismatches) )
  if [[ ${#STILL[@]} -eq 0 ]]; then echo "   all files matched after round $i"; PENDING=(); break; fi
  echo "   round $i: ${#STILL[@]} file(s) not yet live"
  PENDING=( "${STILL[@]}" )
  sleep 10
done

echo "== verifying ${#FILES[@]} files against $SITE"
CHECKED=${#FILES[@]}
[[ $CHECKED -gt 0 ]] || fail "manifest was empty - verified nothing"
DIFF_LIST=( $(printf '%s\n' "${FILES[@]}" | mismatches) )
DIFFS=${#DIFF_LIST[@]}
# bash 3.2 (macOS /bin/bash) + set -u rejects "${arr[@]}" on an empty array.
if [[ $DIFFS -gt 0 ]]; then for f in "${DIFF_LIST[@]}"; do echo "   DIFF  $f"; done; fi
echo "   $((CHECKED-DIFFS))/$CHECKED files match"

# --- 5. Prove the unpublished paths are not served --------------------------
echo "== confirming unpublished paths are not reachable"
LEAKS=0
for p in README.md LICENSE DATA-LICENSE.md .gitignore scripts/deploy.sh \
         tools/build-data.mjs tests/run.mjs tests/golden/facts.json \
         curated/clubs.json public/index.html; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/$p" || echo 000)
  if [[ "$code" == "404" ]]; then echo "   404   $p"
  else echo "   LEAK  $p -> HTTP $code"; LEAKS=$((LEAKS+1)); fi
done

# --- 6. A check whose failure still prints "Done." is not a check ----------
echo
if [[ $DIFFS -gt 0 || $LEAKS -gt 0 ]]; then
  fail "$DIFFS file(s) differ from the live host, $LEAKS unpublished path(s) reachable"
fi
echo "Deploy verified: $CHECKED/$CHECKED files match, 0 unpublished paths reachable."
echo "$SITE/"
