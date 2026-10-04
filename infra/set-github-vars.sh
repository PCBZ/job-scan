#!/bin/sh
# Copy `terraform output github_variables` into the GitHub repository
# variables that .github/workflows/deploy.yml reads. Run after apply:
#
#   infra/set-github-vars.sh [owner/repo]
#
# The repository defaults to the one gh resolves from this checkout. The
# values are identifiers, not secrets, so they go in variables, not secrets.

set -eu

cd "$(dirname "$0")"
repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}

vars=$(terraform output -json github_variables)

echo "$vars" | jq -r 'to_entries[] | "\(.key)\t\(.value)"' |
  while IFS="$(printf '\t')" read -r name value; do
    gh variable set "$name" --repo "$repo" --body "$value"
    echo "set $name"
  done
