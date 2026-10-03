resource "azurerm_service_plan" "main" {
  name                = "${var.name}-plan"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = var.tags
}

resource "azurerm_function_app_flex_consumption" "main" {
  name                = "${var.name}-func-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.main.id

  # Node 24 is the newest runtime Flex Consumption offers.
  runtime_name    = "node"
  runtime_version = "24"

  storage_container_type      = "blobContainer"
  storage_container_endpoint  = "${azurerm_storage_account.main.primary_blob_endpoint}${azurerm_storage_container.deployments.name}"
  storage_authentication_type = "SystemAssignedIdentity"

  # One daily run and an occasional webhook: keep it small.
  instance_memory_in_mb  = 512
  maximum_instance_count = 1
  https_only             = true

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_insights_connection_string = azurerm_application_insights.main.connection_string
  }

  app_settings = {
    # Host storage over managed identity instead of a connection string.
    "AzureWebJobsStorage__accountName" = azurerm_storage_account.main.name
    "KEY_VAULT_URI"                    = azurerm_key_vault.main.vault_uri
  }

  tags = var.tags
}

locals {
  function_principal_id = azurerm_function_app_flex_consumption.main.identity[0].principal_id
}

# Host storage (timer leases), deployment package, reports and caches.
resource "azurerm_role_assignment" "func_blob_owner" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = local.function_principal_id
}

# Seen messages, seen jobs, application records.
resource "azurerm_role_assignment" "func_table_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = local.function_principal_id
}

# The Functions host uses queues internally when storage is identity-based.
resource "azurerm_role_assignment" "func_queue_contributor" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = local.function_principal_id
}

resource "azurerm_role_assignment" "func_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.function_principal_id
}
