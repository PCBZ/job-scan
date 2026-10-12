# The main resource group is created here, empty: every role below is scoped to
# it, so the resources CD creates in it inherit them. CD owns what's inside.
resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = var.tags
}

# The Key Vault and the identities live apart from the app, where CD has no
# rights, so a destroy of the main stack keeps the secrets and the trust.
resource "azurerm_resource_group" "platform" {
  name     = "${var.name}-platform-rg"
  location = var.location
  tags     = var.tags
}

# Holds every secret the app reads at start (functions/src/lib/run/secrets.ts),
# plus config-toml, which the main stack copies to the config blob. Values are
# added by hand; see infra/README.md#secrets.
module "key_vault" {
  source                       = "../modules/key_vault"
  name                         = "${var.name}-kv-${random_string.suffix.result}"
  resource_group_name          = azurerm_resource_group.platform.name
  location                     = azurerm_resource_group.platform.location
  tenant_id                    = data.azurerm_client_config.current.tenant_id
  secrets_officer_principal_id = data.azurerm_client_config.current.object_id
  tags                         = var.tags
}

locals {
  # The app settings filled from the vault, each from the secret named after
  # it: lowercase, "_" as "-".
  secret_settings = concat(
    [
      "GITHUB_RESUME_PAT",  # the resume repo, read-only (#11)
      "TELEGRAM_BOT_TOKEN", # the bot (#21)
      "TYPESAFE_API_KEY",   # Jev
    ],
    var.mail_credential_envs, # IMAP, and the SMTP sender's (#9, #20)
  )
}
