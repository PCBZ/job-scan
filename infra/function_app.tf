# Secrets reach the app as Key Vault references, resolved by its identity, so
# no value passes through Terraform state. Each setting reads the secret named
# after it: lowercase, "_" as "-" (Key Vault names allow only letters, digits
# and "-"). The values are added by hand; see infra/README.md#secrets.
locals {
  secret_settings = concat(
    [
      "GITHUB_RESUME_PAT",  # the resume repo, read-only (#11)
      "TELEGRAM_BOT_TOKEN", # the bot (#21)
      "TYPESAFE_API_KEY",   # Jev
    ],
    var.mail_credential_envs, # IMAP, and the SMTP sender's (#9, #20)
  )
  secret_references = {
    for k in local.secret_settings :
    k => "@Microsoft.KeyVault(SecretUri=${module.key_vault.uri}secrets/${replace(lower(k), "_", "-")}/)"
  }
}

module "function_app" {
  source              = "./modules/function_app"
  name                = "${var.name}-func-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = var.tags

  storage_account_id            = module.storage.id
  storage_account_name          = module.storage.name
  deployment_container_endpoint = module.storage.container_endpoints["deployments"]
  key_vault_id                  = module.key_vault.id

  application_insights_connection_string = module.monitoring.connection_string

  app_settings = merge({
    "KEY_VAULT_URI" = module.key_vault.uri
    # Model selection, read by functions/src/lib/model/config.ts. A fallback
    # would add the same keys prefixed MODEL_FALLBACK_.
    "MODEL_PROVIDER"   = "azure-openai"
    "MODEL_ENDPOINT"   = module.openai.endpoint
    "MODEL_NAME"       = module.openai.deployment_name
    "CONFIG_BLOB_URL"  = module.config_blob.url
    "RESUME_CACHE_URL" = module.storage.container_endpoints["resume-cache"]
    # seenmessages, seenjobs and applications (#22).
    "TABLES_URL" = module.storage.table_endpoint
    # Private; reports are read through user delegation SAS links (#19).
    "REPORTS_URL" = module.storage.container_endpoints["reports"]
    # Jev, read by functions/src/lib/decision/config.ts. The model is pinned:
    # confidence thresholds are tuned against one version.
    "JEV_MODEL" = "jev-1.13.0"
  }, local.secret_references)
}
