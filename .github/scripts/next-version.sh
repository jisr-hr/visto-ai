#!/usr/bin/env bash
# Works out the next version from the commits since the last vX.Y.Z tag and
# prints version=, tag= and range= lines for $GITHUB_OUTPUT.
# A breaking change bumps the major number (the minor one while under 1.0),
# feat bumps the minor number, anything else bumps the patch number.
set -euo pipefail

last=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
if [[ -n $last ]]; then
  range="$last..HEAD"
  IFS=. read -r major minor patch <<< "${last#v}"
else
  range=HEAD
  major=0 minor=0 patch=0
fi

if [[ -z $(git log --no-merges --format=%h "$range") ]]; then
  echo "No commits since $last: nothing to release." >&2
  exit 1
fi

subjects=$(git log --no-merges --format=%s "$range")
bodies=$(git log --no-merges --format=%b "$range")

if grep -qE '^[a-z]+(\([^()]+\))?!:' <<< "$subjects" || grep -qE '^BREAKING[ -]CHANGE:' <<< "$bodies"; then
  level=major
elif grep -qE '^feat(\([^()]+\))?:' <<< "$subjects"; then
  level=minor
else
  level=patch
fi
if [[ $level == major && $major == 0 ]]; then
  level=minor
fi

case $level in
  major) major=$((major + 1)) minor=0 patch=0 ;;
  minor) minor=$((minor + 1)) patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac

echo "version=$major.$minor.$patch"
echo "tag=v$major.$minor.$patch"
echo "range=$range"
