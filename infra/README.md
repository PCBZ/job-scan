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

## Releasing

A release is a `v*` tag on `main`. Pushing one runs `.github/workflows/cd.yml`,
which checks and builds the tagged commit, then deploys it:

```sh
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The workflow fails before deploying if the tag isn't on `main`, if any check
fails, or if the `daily` function isn't registered afterwards.

### How the deploy is trusted

The workflow signs in to Azure over OIDC, so no secret is stored. The deploy
identity trusts one subject, made up of the repository, the workflow name
`CD` and the ref type `tag`:

```
repo:<owner>@<id>/<repo>@<id>:workflow:CD:ref_type:tag
```

A run from a branch carries `ref_type:branch` instead, so it gets no token.
GitHub builds this subject only after the repository's subject template lists
those claim keys. After an apply, run `infra/set-github-vars.sh`: it sets the
template from `terraform output github_oidc_claim_keys`, and copies the
repository variables the workflow reads. If you rename the workflow, change
`github_workflow` to match.
