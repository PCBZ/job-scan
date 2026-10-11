#!/bin/sh
# Copy `terraform output github_variables` and the backend.hcl values into the
# GitHub repository variables that .github/workflows/cd.yml reads, and set the
# repository's OIDC
# subject template to the claims the deploy identity trusts
# (`terraform output github_oidc_claim_keys`). Run after apply, so the
# identity trusts the new subject before GitHub issues it:
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

# The state backend CD initialises against, from backend.hcl.
for pair in resource_group_name:TFSTATE_RESOURCE_GROUP storage_account_name:TFSTATE_STORAGE_ACCOUNT \
  container_name:TFSTATE_CONTAINER key:TFSTATE_KEY; do
  field=${pair%%:*}
  name=${pair#*:}
  value=$(sed -n "s/^[[:space:]]*${field}[[:space:]]*=[[:space:]]*\"\(.*\)\".*/\1/p" backend.hcl)
  [ -n "$value" ] || { echo "backend.hcl has no $field" >&2; exit 1; }
  gh variable set "$name" --repo "$repo" --body "$value"
  echo "set $name"
done

# Immutable subjects stay on: the repo segment keeps owner and repository IDs.
# https://docs.github.com/en/rest/actions/oidc#set-the-customization-template-for-an-oidc-subject-claim-for-a-repository
keys=$(terraform output -json github_oidc_claim_keys)
printf '{"use_default":false,"use_immutable_subject":true,"include_claim_keys":%s}' "$keys" |
  gh api -X PUT "repos/$repo/actions/oidc/customization/sub" --input - >/dev/null
echo "set OIDC subject claims $keys"

# Any tag of a workflow named CD gets a token (see infra/github_oidc.tf), so
# only admins may create, move or delete tags: a writer can't release.
# RepositoryRole 5 is the admin role.
# https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
ruleset='{"name":"Release tags","target":"tag","enforcement":"active",
  "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
  "conditions":{"ref_name":{"include":["~ALL"],"exclude":[]}},
  "rules":[{"type":"creation"},
    {"type":"update","parameters":{"update_allows_fetch_and_merge":false}},
    {"type":"deletion"}]}'
id=$(gh api "repos/$repo/rulesets?targets=tag" --jq '.[] | select(.name == "Release tags") | .id')
if [ -n "$id" ]; then
  printf '%s' "$ruleset" | gh api -X PUT "repos/$repo/rulesets/$id" --input - >/dev/null
else
  printf '%s' "$ruleset" | gh api -X POST "repos/$repo/rulesets" --input - >/dev/null
fi
echo "set tag ruleset: only admins create, move or delete tags"
