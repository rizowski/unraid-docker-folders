#!/bin/bash
# Claude Code hook for this repo. Exit 2 sends stderr back to Claude and blocks.
#
#   dfm-checks.sh edit   PostToolUse on Edit|Write: oxlint on the one edited
#                        frontend file. Fast, so it runs on every edit.
#   dfm-checks.sh stop   Stop and SubagentStop: for each package the work
#                        touched, run what the release workflow runs:
#                        frontend `oxlint src dev --deny-warnings` and
#                        `vue-tsc --noEmit`; plugin
#                        `tsc --noEmit -p tsconfig.test.json` (test files too).
#
# It works from the path in the hook input, not from the project directory, so
# a subagent in a git worktree is checked in its own worktree.

export PATH="$HOME/.proto/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"

MODE="$1"
INPUT="$(cat)"
MAIN="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
PLUGIN_REL="packages/unraid-api-plugin-docker-folders"

fail() {
  # $1 = title, $2 = output
  {
    echo "dfm-checks: $1 FAILED. Fix this before you go on."
    echo "$2" | tail -60
  } >&2
}

if [ "$MODE" = "edit" ]; then
  f="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')"
  [ -n "$f" ] && [ -f "$f" ] || exit 0
  case "$f" in
    */src/frontend/src/*|*/src/frontend/dev/*) ;;
    *) exit 0 ;;
  esac
  case "$f" in
    *.ts|*.vue|*.js|*.mjs|*.tsx) ;;
    *) exit 0 ;;
  esac
  root="${f%%/src/frontend/*}/src/frontend"
  bin="$root/node_modules/.bin/oxlint"
  [ -x "$bin" ] || bin="$MAIN/src/frontend/node_modules/.bin/oxlint"
  [ -x "$bin" ] || exit 0
  out="$(cd "$root" && "$bin" --deny-warnings "$f" 2>&1)"
  if [ $? -ne 0 ]; then
    fail "oxlint on $f" "$out"
    exit 2
  fi
  exit 0
fi

if [ "$MODE" = "stop" ]; then
  # Already continuing because of a stop hook: do not loop.
  [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
  cwd="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
  [ -n "$cwd" ] && [ -d "$cwd" ] || exit 0
  top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || exit 0
  [ -f "$top/unraid-docker-folders-modern.plg" ] || exit 0

  base="$(git -C "$top" merge-base HEAD origin/dev 2>/dev/null)"
  changed="$(
    {
      git -C "$top" diff --name-only HEAD 2>/dev/null
      git -C "$top" ls-files --others --exclude-standard 2>/dev/null
      [ -n "$base" ] && git -C "$top" diff --name-only "$base" HEAD 2>/dev/null
    } | sort -u
  )"
  [ -n "$changed" ] || exit 0

  status=0
  skipped=""

  if printf '%s\n' "$changed" | grep -q -E '^src/frontend/(src|dev)/'; then
    fe="$top/src/frontend"
    if [ -x "$fe/node_modules/.bin/oxlint" ] && [ -x "$fe/node_modules/.bin/vue-tsc" ]; then
      out="$(cd "$fe" && node_modules/.bin/oxlint src dev --deny-warnings 2>&1)" \
        || { fail "frontend lint (yarn lint) in $fe" "$out"; status=2; }
      out="$(cd "$fe" && node_modules/.bin/vue-tsc --noEmit 2>&1)" \
        || { fail "frontend type check (yarn type-check) in $fe" "$out"; status=2; }
    else
      skipped="$skipped frontend"
    fi
  fi

  if printf '%s\n' "$changed" | grep -q "^$PLUGIN_REL/"; then
    pl="$top/$PLUGIN_REL"
    if [ -x "$pl/node_modules/.bin/tsc" ]; then
      out="$(cd "$pl" && node_modules/.bin/tsc --noEmit -p tsconfig.test.json 2>&1)" \
        || { fail "plugin type check (npm run type-check, includes test files) in $pl" "$out"; status=2; }
    else
      skipped="$skipped plugin"
    fi
  fi

  if [ -n "$skipped" ] && [ $status -eq 0 ]; then
    {
      echo "dfm-checks: these packages changed but have no node_modules in $top, so lint and type checks did NOT run:$skipped."
      echo "Install the dependencies and run the checks, or state in your report that they were not run."
    } >&2
    exit 2
  fi
  exit $status
fi

exit 0
