# infra

Terraform for the Azure deployment. The plan behind it is in the wiki's
[Azure Functions Plan](https://github.com/PCBZ/job-scan/wiki/Azure-Functions-Plan).

## Secrets

Secrets reach the Function App as Key Vault references
(`@Microsoft.KeyVault(SecretUri=…)`), which the app resolves through its
managed identity. Terraform declares only the references, so no secret value
passes through Terraform state or this repo. You add the values by hand.

### Naming

Each app setting reads the secret named after it: lowercase, with `_` as `-`,
because Key Vault names allow only letters, digits and `-`.

| App setting | Key Vault secret | Holds |
|---|---|---|
| `GITHUB_RESUME_PAT` | `github-resume-pat` | Fine-grained PAT, read-only Contents on the resume repo |
| `TELEGRAM_BOT_TOKEN` | `telegram-bot-token` | The bot's token from @BotFather |
| `TYPESAFE_API_KEY` | `typesafe-api-key` | Jev's API key |
| `GMAIL_MAIN_USER` | `gmail-main-user` | A mailbox's address, one pair per account |
| `GMAIL_MAIN_PASSWORD` | `gmail-main-password` | That mailbox's app password |

The mailbox settings are the `user_env` / `password_env` keys your config.toml
reads (by default `<NAME>_USER` / `<NAME>_PASSWORD`). The mailbox named by
`report.email_account` also sends the report over SMTP, so it needs no extra
secret.

### Adding a mailbox

1. List the keys your config reads:
   `python3 scripts/fetch_mail.py --env-template`.
2. Copy `terraform.tfvars.example` to `terraform.tfvars` (gitignored) and set
   `mail_credential_envs` to those keys. It holds names only, never values.
3. Add each secret's value under the name from the table, in the Azure portal:
   Key Vault → **Objects › Secrets** → **Generate/Import**. To change a value,
   open the secret and add a **New Version**; the reference always reads the
   latest one.
4. `terraform plan`, then `terraform apply`.

### Checking

If a reference can't be resolved (the secret is missing, or a role assignment
hasn't propagated yet), the app receives the reference text itself as the
value. The mail fetch treats that value as unset, so the report names the
account as `missing_credentials`, not as a failed login. The portal also shows
each reference's status under the Function App's **Settings › Environment
variables**.

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

### Setting it up

Once, in this order, all by hand:

1. Add `operator_principal_id` to `terraform.tfvars`: your Object ID, from
   the portal's Microsoft Entra ID → Users → you. The Key Vault, OpenAI and
   config roles stay with you, whoever runs the apply.
2. Make sure the `config-toml` secret exists, then run `terraform apply` here.
   This creates the CD identity and its OIDC trust.
3. In `bootstrap/`, run `terraform apply -var "deployer=$(terraform -chdir=..
   output -json deployer)"`. This grants the CD identity its rights (below).
4. Run `infra/set-github-vars.sh`. It sets the OIDC subject template and the
   repository variables the workflow reads.

### What the CD identity can do

Its rights live in `bootstrap/`, outside what a CD run applies, so a run can't
widen them:

- **Contributor** on the main resource group.
- **Storage Blob Data Contributor** on the state container.

The main stack adds **Key Vault Secrets User**, for reading `config-toml`.

CD can't grant rights. Contributor reads role assignments but can't create or
remove them, so a change to the stack's role assignments is applied locally,
by you, before the next tag. A tag that reaches one first fails on it.
Resource provider registration needs subscription rights too, so CD skips it
and a local apply registers them.

### How the run is trusted

The workflow signs in to Azure over OIDC, so no secret is stored. The CD
identity trusts one subject, made up of the repository, the workflow name
`CD` and the ref type `tag`:

```
repo:<owner>@<id>/<repo>@<id>:workflow:CD:ref_type:tag
```

A run from a branch carries `ref_type:branch` instead, so it gets no token.
GitHub builds this subject only after the repository's subject template lists
those claim keys, which `set-github-vars.sh` sets from
`terraform output github_oidc_claim_keys`. If you rename the workflow, change
`github_workflow` to match.

The subject names neither the tag nor the workflow file. Any tag gets a token
for a workflow named `CD`, and the `v*` and "on `main`" checks live in
`cd.yml` at the tagged commit, which whoever pushes the tag controls. So
creating a tag is the real boundary: `set-github-vars.sh` applies a tag
ruleset (**Release tags**) that lets only repository admins create, move or
delete tags. A collaborator with write access can't release, and if you add
one, keep them below admin.
