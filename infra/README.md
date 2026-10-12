# infra

Terraform for the Azure deployment, in two stacks. The plan behind it is in the
wiki's [Azure Functions Plan](https://github.com/PCBZ/job-scan/wiki/Azure-Functions-Plan).

| Stack | Applied by | Holds |
|---|---|---|
| `bootstrap/` | you, by hand, rarely | the state backend; the main and platform resource groups; the Key Vault and its secrets; the app's and CD's identities, CD's OIDC trust; **every role assignment** |
| `infra/` (main) | CD, on every release tag | storage, OpenAI, App Insights, the plan and the Function App, the config blob. **No role assignments** |

The split lets CD, which holds only Contributor, build the app from an empty
resource group: it can't grant roles, so none are left for it to grant. Roles on
the main resource group reach whatever CD creates in it. A destroy of the main
stack leaves the vault, the identities and their roles in place, so the next
tag rebuilds the app.

## From zero

Once, by hand, in this order:

1. **Bootstrap.** Copy `bootstrap/terraform.tfvars.example` to
   `bootstrap/terraform.tfvars` and set `mail_credential_envs` (below). Then,
   in `bootstrap/`: `terraform init && terraform apply`. Paste its
   `backend_hcl` output into `infra/backend.hcl`.
2. **Secrets.** Add every secret in the table below to the Key Vault
   (`terraform -chdir=bootstrap output key_vault_uri`), with `config-toml`.
3. **GitHub.** Run `infra/set-github-vars.sh`. It sets the repository
   variables CD reads, the OIDC subject template and the tag ruleset.
4. **Release.** Push a tag (below). CD builds everything else.

To apply the main stack locally instead, write bootstrap's output where
Terraform reads it, then plan as usual:

```sh
terraform -chdir=bootstrap output -json main_tfvars > platform.auto.tfvars.json
```

## Secrets

The app reads its secrets from Key Vault itself, at the start of each run
(`functions/src/lib/run/secrets.ts`), signed in as its user-assigned identity.
Flex Consumption can't resolve Key Vault references as a user-assigned
identity, because azurerm has no `key_vault_reference_identity_id` for it.
Terraform passes only the vault's URI and the setting names
(`KEY_VAULT_SECRETS`), so no secret value passes through Terraform state or
this repo.

### Naming

Each setting reads the secret named after it: lowercase, with `_` as `-`,
because Key Vault names allow only letters, digits and `-`.

| App setting | Key Vault secret | Holds |
|---|---|---|
| `GITHUB_RESUME_PAT` | `github-resume-pat` | Fine-grained PAT, read-only Contents on the resume repo |
| `TELEGRAM_BOT_TOKEN` | `telegram-bot-token` | The bot's token from @BotFather |
| `TYPESAFE_API_KEY` | `typesafe-api-key` | Jev's API key |
| `GMAIL_MAIN_USER` | `gmail-main-user` | A mailbox's address, one pair per account |
| `GMAIL_MAIN_PASSWORD` | `gmail-main-password` | That mailbox's app password |
| — | `config-toml` | Your config.toml, copied to the `config` blob on each apply |

The mailbox settings are the `user_env` / `password_env` keys your config.toml
reads (by default `<NAME>_USER` / `<NAME>_PASSWORD`). The mailbox named by
`report.email_account` also sends the report over SMTP, so it needs no extra
secret.

### Adding a mailbox

1. List the keys your config reads:
   `python3 scripts/fetch_mail.py --env-template`.
2. Add them to `mail_credential_envs` in `bootstrap/terraform.tfvars`. It holds
   names only, never values. Apply bootstrap, then run `set-github-vars.sh`, so
   CD passes the new list.
3. Add each value under its secret's name, in the Azure portal: Key Vault →
   **Objects › Secrets** → **Generate/Import**. To change a value, open the
   secret and add a **New Version**; the app reads the latest at its next run.

### Checking

A listed secret that doesn't exist is logged at the start of the run
(`daily: not in Key Vault, so unset: …`). The setting stays unset, so a mailbox
without credentials shows in the report as `missing_credentials`, and a
required setting fails the run, naming itself. Any other Key Vault error, such
as missing access, fails the run.

## config.toml

The cloud run reads `config.toml` from the `config` blob. Its source is the
Key Vault secret `config-toml`, so a CD run, which has no local file, applies
the same config. Terraform copies the secret into the blob on every apply.
The file carries no credentials by design; its text does pass through
Terraform state. After editing your config, update the secret (a new version)
before the next apply.

## Releasing

A release is a `v*` tag on `main`. Pushing one runs `.github/workflows/cd.yml`:
it checks and builds the tagged commit, then runs `terraform apply` on this
directory as committed, with the tag's build as the app's code. There is no
manual approval; the plan is printed in the log as it applies.

```sh
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The workflow stops before applying if the tag isn't on `main` or if any check
fails. The code goes out through `zip_deploy_file`, which redeploys only when
the package path changes, so each package is named after its tag. A local
apply leaves `app_package` unset and keeps the deployed code.

### What each identity can do

All granted in `bootstrap/identities.tf`:

- **The app** (`job-scan-app`, user-assigned), on the main resource group:
  Storage Blob Data Owner, Table Data Contributor and Queue Data Contributor,
  and Cognitive Services OpenAI User. On the vault: Key Vault Secrets User.
- **CD** (`job-scan-github-deploy`), on the main resource group: Contributor,
  and Storage Blob Data Contributor for the config blob. On the vault: Key
  Vault Secrets User, for `config-toml`, and Reader, because Terraform looks
  the vault up over ARM before reading the secret. On the state container:
  Storage Blob Data Contributor.
- **You**, the operator who applies bootstrap: Key Vault Secrets Officer, and
  on the main resource group Storage Blob Data Contributor and Cognitive
  Services OpenAI User, for a local apply and the live evals.

CD can't grant rights. A change to any of these is a bootstrap apply, by you.
Resource provider registration needs subscription rights too, so bootstrap
registers the main stack's providers.

### How the run is trusted

The workflow signs in to Azure over OIDC, so no secret is stored. The CD
identity trusts one subject, made up of the repository, the workflow name
`CD` and the ref type `tag`:

```
repo:<owner>@<id>/<repo>@<id>:workflow:CD:ref_type:tag
```

A run from a branch carries `ref_type:branch` instead, so it gets no token.
GitHub builds this subject only after the repository's subject template lists
those claim keys, which `set-github-vars.sh` sets from bootstrap's
`github_oidc_claim_keys`. If you rename the workflow, change `github_workflow`
in bootstrap to match.

The subject names neither the tag nor the workflow file. Any tag gets a token
for a workflow named `CD`, and the `v*` and "on `main`" checks live in
`cd.yml` at the tagged commit, which whoever pushes the tag controls. So
creating a tag is the real boundary: `set-github-vars.sh` applies a tag
ruleset (**Release tags**) that lets only repository admins create, move or
delete tags. A collaborator with write access can't release, and if you add
one, keep them below admin.
