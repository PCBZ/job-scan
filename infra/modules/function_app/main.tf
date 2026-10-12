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

  storage_container_type            = "blobContainer"
  storage_container_endpoint        = var.deployment_container_endpoint
  storage_authentication_type       = "UserAssignedIdentity"
  storage_user_assigned_identity_id = var.identity_id

  # Code isn't deployed here: azurerm's zip_deploy_file uses Kudu's zipdeploy,
  # which Flex Consumption doesn't support (hashicorp/terraform-provider-azurerm#29630).
  # CD deploys it with Azure/functions-action (OneDeploy) over Entra ID, so no
  # basic-auth publishing credentials are needed (#88).
  webdeploy_publish_basic_authentication_enabled = false

  instance_memory_in_mb  = var.instance_memory_in_mb
  maximum_instance_count = var.maximum_instance_count
  https_only             = true

  # User-assigned, from infra/bootstrap, which also grants its roles: this
  # stack can't, and they must exist before the app starts.
  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  site_config {
    application_insights_connection_string = var.application_insights_connection_string
  }

  # Host storage over the user-assigned identity. azurerm always writes
  # AzureWebJobsStorage as a connection string, with an empty AccountKey under
  # identity auth; the host would prefer it and fail. Blanking it (user values
  # override the provider's) makes the host use the __ settings instead:
  # https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity
  # AZURE_CLIENT_ID makes the app's DefaultAzureCredential pick the same identity.
  app_settings = merge(
    {
      "AzureWebJobsStorage"              = ""
      "AzureWebJobsStorage__accountName" = var.storage_account_name
      "AzureWebJobsStorage__credential"  = "managedidentity"
      "AzureWebJobsStorage__clientId"    = var.identity_client_id
      "AZURE_CLIENT_ID"                  = var.identity_client_id
    },
    var.app_settings,
  )

  tags = var.tags
}
