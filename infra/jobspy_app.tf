# The Python scanner (jobspy-scanner/): its own Function App, since one Flex
# Consumption app runs one language. It runs as the same identity as the main
# app, whose roles bootstrap grants on the resource group; it uses the blob and
# queue writes. It reads its config from the same blob as the main app, and
# calls no model: collect reads its postings (#203, #204).
module "jobspy_app" {
  source              = "./modules/function_app"
  name                = "${var.name}-jobspy-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags

  runtime_name          = "python"
  runtime_version       = "3.13"
  instance_memory_in_mb = 2048

  storage_account_name          = module.storage.name
  deployment_container_endpoint = module.storage.container_endpoints["jobspy-deployments"]
  identity_id                   = var.platform.app_identity_id
  identity_client_id            = var.platform.app_client_id

  application_insights_connection_string = module.monitoring.connection_string

  app_settings = {
    "CONFIG_BLOB_URL"    = module.config_blob.url
    "POSTINGS_URL"       = module.storage.container_endpoints["postings"]
    "POSTINGS_QUEUE_URL" = module.storage.queue_urls["postings-ready"]
    "APP_VERSION"        = var.app_version
  }
}
