#!/usr/bin/env bash
# Prints release notes in Markdown for the non-merge commits in <range>,
# grouped into Features, Fixes and Other.
# Usage: release-notes.sh <range>
set -euo pipefail

features=() fixes=() other=()
while IFS=$'\t' read -r sha subject; do
  if [[ $subject =~ ^([a-z]+)(\(([^()]+)\))?(!)?:\ (.*)$ ]]; then
    type=${BASH_REMATCH[1]} scope=${BASH_REMATCH[3]} bang=${BASH_REMATCH[4]} text=${BASH_REMATCH[5]}
    if [[ -n $bang ]] || git log -1 --format=%b "$sha" | grep -qE '^BREAKING[ -]CHANGE:'; then
      text="**Breaking:** $text"
    fi
    [[ -n $scope ]] && text="**$scope:** $text"
  else
    type=other text=$subject
  fi
  line="- $text ($sha)"
  case $type in
    feat) features+=("$line") ;;
    fix) fixes+=("$line") ;;
    *) other+=("$line") ;;
  esac
done < <(git log --no-merges --reverse --format='%h%x09%s' "$1")

section() {
  local title=$1
  shift
  (( $# )) || return 0
  printf '## %s\n\n' "$title"
  printf '%s\n' "$@"
  printf '\n'
}
section Features ${features[@]+"${features[@]}"}
section Fixes ${fixes[@]+"${fixes[@]}"}
section Other ${other[@]+"${other[@]}"}
