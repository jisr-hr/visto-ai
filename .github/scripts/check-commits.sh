#!/usr/bin/env bash
# Checks that every non-merge commit in <base>..<head>, and the pull request
# title in $TITLE when set, follow the conventional commit format.
# Usage: check-commits.sh <base> <head>
set -euo pipefail

types='feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert'
pattern="^($types)(\\([^()]+\\))?!?: [^ ].*"
revert='^Revert ".+"'

ok() { [[ $1 =~ $pattern || $1 =~ $revert ]]; }

bad=0
while IFS=$'\t' read -r sha subject; do
  if ! ok "$subject"; then
    echo "::error::Commit $sha does not follow the format: $subject"
    bad=1
  fi
done < <(git log --no-merges --format='%h%x09%s' "$1..$2")

if [[ -n ${TITLE:-} ]] && ! ok "$TITLE"; then
  echo "::error::The pull request title does not follow the format: $TITLE"
  bad=1
fi

if (( bad )); then
  echo "Expected: type(scope)!: subject, where the scope and ! are optional"
  echo "and type is one of: ${types//|/, }."
  exit 1
fi
echo "Every commit and the title follow the format."
