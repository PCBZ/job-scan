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

  app_settings = {
    "KEY_VAULT_URI" = module.key_vault.uri
    # Model selection, read by functions/src/lib/model/config.ts. A fallback
    # would add the same keys prefixed MODEL_FALLBACK_.
    "MODEL_PROVIDER"   = "azure-openai"
    "MODEL_ENDPOINT"   = module.openai.endpoint
    "MODEL_NAME"       = module.openai.deployment_name
    "CONFIG_BLOB_URL"  = module.config_blob.url
    "RESUME_CACHE_URL" = module.storage.container_endpoints["resume-cache"]
  }
}
