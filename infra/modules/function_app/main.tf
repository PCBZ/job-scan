resource "azurerm_service_plan" "this" {
  name                = "${var.name}-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = var.tags
}

resource "azurerm_function_app_flex_consumption" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  service_plan_id     = azurerm_service_plan.this.id

  runtime_name    = "node"
  runtime_version = var.node_version

  storage_container_type      = "blobContainer"
  storage_container_endpoint  = var.deployment_container_endpoint
  storage_authentication_type = "SystemAssignedIdentity"

  instance_memory_in_mb  = var.instance_memory_in_mb
  maximum_instance_count = var.maximum_instance_count
  https_only             = true

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_insights_connection_string = var.application_insights_connection_string
  }

  # Host storage over managed identity. azurerm always writes
  # AzureWebJobsStorage as a connection string, with an empty AccountKey under
  # identity auth; the host would prefer it and fail. Blanking it (user values
  # override the provider's) makes the host use __accountName instead.
  app_settings = merge(
    {
      "AzureWebJobsStorage"              = ""
      "AzureWebJobsStorage__accountName" = var.storage_account_name
    },
    var.app_settings,
  )

  tags = var.tags
}
