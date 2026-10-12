module "function_app" {
  source              = "./modules/function_app"
  name                = "${var.name}-func-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags

  storage_account_name          = module.storage.name
  deployment_container_endpoint = module.storage.container_endpoints["deployments"]
  identity_id                   = var.platform.app_identity_id
  identity_client_id            = var.platform.app_client_id
  app_package                   = var.app_package

  application_insights_connection_string = module.monitoring.connection_string

  app_settings = {
    # Secrets, read by the app at start (functions/src/lib/run/secrets.ts):
    # each listed setting from the secret named after it. Flex Consumption
    # can't resolve Key Vault references as a user-assigned identity.
    "KEY_VAULT_URI"     = var.platform.key_vault_uri
    "KEY_VAULT_SECRETS" = join(",", var.platform.secret_settings)
    # Model selection, read by functions/src/lib/model/config.ts. A fallback
    # would add the same keys prefixed MODEL_FALLBACK_.
    "MODEL_PROVIDER"   = "azure-openai"
    "MODEL_ENDPOINT"   = module.openai.endpoint
    "MODEL_NAME"       = module.openai.deployment_name
    "CONFIG_BLOB_URL"  = module.config_blob.url
    "RESUME_CACHE_URL" = module.storage.container_endpoints["resume-cache"]
    # seenmessages and seenjobs (#9, #15).
    "TABLES_URL" = module.storage.table_endpoint
    # Private; reports are read through user delegation SAS links (#19).
    "REPORTS_URL" = module.storage.container_endpoints["reports"]
    # Jev, read by functions/src/lib/decision/config.ts. The model is pinned:
    # confidence thresholds are tuned against one version.
    "JEV_MODEL" = "jev-1.13.0"
  }
}
