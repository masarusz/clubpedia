#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="$REPO_ROOT/reports"
RUN_DATE="$(date +%F)"
LOG_PATH="$REPORT_DIR/monthly-refresh-$RUN_DATE.log"
GUARD_PATH="$REPORT_DIR/refresh-guard.txt"
DRY_RUN=0
FORCE_HOLD=0
CURRENT_STEP="startup"
TARGET_VERSION="unknown"

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --force-hold) FORCE_HOLD=1 ;;
    *) echo "usage: $0 [--dry-run | --force-hold]" >&2; exit 1 ;;
  esac
done
if [[ $DRY_RUN -eq 1 && $FORCE_HOLD -eq 1 ]]; then
  echo "--dry-run and --force-hold are mutually exclusive" >&2
  exit 1
fi
if [[ -z "${NOTIFY_DIR:-}" ]]; then
  echo "NOTIFY_DIR is required" >&2
  exit 1
fi

mkdir -p "$REPORT_DIR" "$NOTIFY_DIR"
: > "$LOG_PATH"
cd "$REPO_ROOT"

# /usr/bin/git may be blocked by an unaccepted Xcode licence. Match deploy.sh.
if ! git --version >/dev/null 2>&1; then
  git() { /Library/Developer/CommandLineTools/usr/bin/git "$@"; }
fi

timestamp() { date '+%Y-%m-%d %H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(timestamp)" "$*" | tee -a "$LOG_PATH"; }
run_logged() {
  log "START $CURRENT_STEP"
  if "$@" >> "$LOG_PATH" 2>&1; then
    log "PASS  $CURRENT_STEP"
    return 0
  else
    local code=$?
    log "FAIL  $CURRENT_STEP (exit $code)"
    return "$code"
  fi
}

current_version() {
  node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const m=s.match(/VERSION\s*=\s*'"'"'(\d+\.\d+\.\d+)'"'"'/);if(!m)process.exit(1);process.stdout.write(m[1])' "$REPO_ROOT/public/js/version.js"
}

write_status() {
  local outcome="$1"
  local detail_source="$2"
  local status_path="$NOTIFY_DIR/clubpedia-refresh-status.md"
  {
    printf '# Clubpedia refresh %s\n\n' "$outcome"
    printf -- '- Date: %s\n' "$RUN_DATE"
    printf -- '- Version: %s\n' "$TARGET_VERSION"
    printf -- '- Guard report: `%s`\n' "$GUARD_PATH"
    printf -- '- Log: `%s`\n' "$LOG_PATH"
    printf -- '- Step: %s\n\n' "$CURRENT_STEP"
    if [[ "$detail_source" == "$GUARD_PATH" && -f "$GUARD_PATH" ]]; then
      printf '## Guard report (first 40 lines)\n\n```text\n'
      sed -n '1,40p' "$GUARD_PATH"
    else
      printf '## Failing step (last 40 log lines)\n\n```text\n'
      tail -40 "$LOG_PATH"
    fi
    printf '```\n'
  } > "$status_path"
  log "STATUS $status_path"
}

notify_failure() {
  local outcome="$1"
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"See the monthly refresh status file.\" with title \"Clubpedia refresh $outcome\"" >/dev/null 2>&1 || true
}

finish() {
  local outcome="$1" code="$2" source="$3"
  trap - EXIT
  write_status "$outcome" "$source"
  if [[ "$outcome" != "DEPLOYED" && "$outcome" != "DRY RUN PASS" ]]; then notify_failure "$outcome"; fi
  log "OUTCOME $outcome"
  exit "$code"
}

unexpected_exit() {
  local code=$?
  [[ $code -ne 0 ]] || return 0
  set +e
  CURRENT_STEP="${CURRENT_STEP:-unexpected script failure}"
  log "BROKE: unexpected exit $code during $CURRENT_STEP"
  write_status "BROKE" "$LOG_PATH"
  notify_failure "BROKE"
}
trap unexpected_exit EXIT

CURRENT_STEP="preflight: main, clean, origin/main, no iCloud conflicts"
TARGET_VERSION="$(current_version 2>/dev/null || printf unknown)"
log "Clubpedia monthly refresh $RUN_DATE"

if [[ "$(git branch --show-current)" != "main" ]]; then
  log "BROKE: current branch is not main"
  finish "BROKE" 1 "$LOG_PATH"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  log "BROKE: working tree is not clean"
  finish "BROKE" 1 "$LOG_PATH"
fi
CONFLICTS=()
while IFS= read -r path; do CONFLICTS+=( "$path" ); done < <(find "$REPO_ROOT" -path "$REPO_ROOT/.cache" -prune -o -name '* [0-9]*' -print)
if [[ ${#CONFLICTS[@]} -gt 0 ]]; then
  printf '%s\n' "${CONFLICTS[@]}" >> "$LOG_PATH"
  log "BROKE: iCloud conflict copies found"
  finish "BROKE" 1 "$LOG_PATH"
fi
if ! run_logged git fetch origin main; then finish "BROKE" 1 "$LOG_PATH"; fi
if ! git show-ref --verify --quiet refs/remotes/origin/main || [[ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/main)" ]]; then
  log "BROKE: main is not exactly up to date with origin/main"
  finish "BROKE" 1 "$LOG_PATH"
fi

if [[ $FORCE_HOLD -eq 1 ]]; then
  CURRENT_STEP="refresh guard (forced HOLD)"
  set +e
  node "$REPO_ROOT/tools/refresh-guard.mjs" --report "$GUARD_PATH" --synthetic-hold >> "$LOG_PATH" 2>&1
  GUARD_CODE=$?
  set -e
  if [[ $GUARD_CODE -ne 2 ]]; then
    log "BROKE: forced guard returned $GUARD_CODE instead of 2"
    finish "BROKE" 1 "$LOG_PATH"
  fi
  log "HOLD: synthetic guard rule triggered"
  finish "HOLD" 2 "$GUARD_PATH"
fi

CURRENT_STEP="fetch refreshed sources with pinned openfootball SHA"
OPENFOOTBALL_SHA="$(node -e 'const x=require(process.argv[1]);if(!/^[0-9a-f]{40}$/i.test(x.openfootball?.sha||""))process.exit(1);process.stdout.write(x.openfootball.sha)' "$REPO_ROOT/tools/sources.lock.json")" \
  || { log "BROKE: current lock has no valid openfootball SHA"; finish "BROKE" 1 "$LOG_PATH"; }
if ! run_logged node "$REPO_ROOT/tools/fetch-sources.mjs" --refresh --openfootball-sha "$OPENFOOTBALL_SHA"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="build data"
if ! run_logged node "$REPO_ROOT/tools/build-data.mjs"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="refresh guard"
set +e
node "$REPO_ROOT/tools/refresh-guard.mjs" --report "$GUARD_PATH" >> "$LOG_PATH" 2>&1
GUARD_CODE=$?
set -e
if [[ $GUARD_CODE -eq 2 ]]; then log "HOLD: refresh guard found protected changes"; finish "HOLD" 2 "$GUARD_PATH"; fi
if [[ $GUARD_CODE -ne 0 ]]; then log "BROKE: refresh guard failed with exit $GUARD_CODE"; finish "BROKE" 1 "$LOG_PATH"; fi
log "PASS  $CURRENT_STEP"

CURRENT_STEP="test suite before version bump"
if ! run_logged node "$REPO_ROOT/tests/run.mjs"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="audit before push"
if [[ ! -x "$REPO_ROOT/audit-before-push" ]]; then
  log "BROKE: audit-before-push is absent or not executable"
  finish "BROKE" 1 "$LOG_PATH"
fi
if ! run_logged "$REPO_ROOT/audit-before-push"; then finish "BROKE" 1 "$LOG_PATH"; fi

if [[ $DRY_RUN -eq 1 ]]; then
  finish "DRY RUN PASS" 0 "$GUARD_PATH"
fi

CURRENT_STEP="patch version bump and README changelog"
OLD_VERSION="$(current_version)"
TARGET_VERSION="$(node -e 'const p=process.argv[1].split(".").map(Number);p[2]+=1;process.stdout.write(p.join("."))' "$OLD_VERSION")"
if ! run_logged node -e '
  const fs = require("fs"); const path = require("path");
  const [root, oldVersion, nextVersion, date] = process.argv.slice(1);
  function replaceFile(file, transform) { const before=fs.readFileSync(file,"utf8"); const after=transform(before); if(after===before) throw new Error(`expected replacement absent: ${file}`); fs.writeFileSync(file,after); }
  function walk(dir) { for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else {const before=fs.readFileSync(file,"utf8");const after=before.replaceAll(`?v=${oldVersion}`,`?v=${nextVersion}`);if(after!==before)fs.writeFileSync(file,after);}} }
  replaceFile(path.join(root,"public/js/version.js"),s=>s.replaceAll(oldVersion,nextVersion));
  walk(path.join(root,"public"));
  replaceFile(path.join(root,"tests/ui.test.mjs"),s=>s.replaceAll(oldVersion,nextVersion));
  replaceFile(path.join(root,"README.md"),s=>{s=s.replace(`> Status: v${oldVersion}`,`> Status: v${nextVersion}`);return s.replace("## Changelog\n",`## Changelog\n\n- **v${nextVersion}** — Monthly data refresh (${date}).\n`);});
' "$REPO_ROOT" "$OLD_VERSION" "$TARGET_VERSION" "$RUN_DATE"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="test suite after version bump"
if ! run_logged node "$REPO_ROOT/tests/run.mjs"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="commit monthly refresh"
GUARD_SUMMARY="$(sed -n '1,40p' "$GUARD_PATH")"
if ! run_logged git add -- "$REPO_ROOT/public" "$REPO_ROOT/tools/sources.lock.json" "$REPO_ROOT/curated" "$REPO_ROOT/README.md" "$REPO_ROOT/tests"; then finish "BROKE" 1 "$LOG_PATH"; fi
if ! run_logged git commit -m "v$TARGET_VERSION: monthly data refresh $RUN_DATE" -m "$GUARD_SUMMARY"; then finish "BROKE" 1 "$LOG_PATH"; fi

CURRENT_STEP="push main"
if ! run_logged git push origin main; then finish "BROKE" 1 "$LOG_PATH"; fi
CURRENT_STEP="deploy site"
if ! run_logged "$REPO_ROOT/scripts/deploy.sh"; then finish "BROKE" 1 "$LOG_PATH"; fi
CURRENT_STEP="tag release"
if ! run_logged git tag "v$TARGET_VERSION"; then finish "BROKE" 1 "$LOG_PATH"; fi
if ! run_logged git push origin "v$TARGET_VERSION"; then finish "BROKE" 1 "$LOG_PATH"; fi
CURRENT_STEP="audit after push"
if ! run_logged "$REPO_ROOT/audit-before-push"; then finish "BROKE" 1 "$LOG_PATH"; fi

finish "DEPLOYED" 0 "$GUARD_PATH"
