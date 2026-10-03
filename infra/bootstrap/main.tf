# One-time setup of the remote state backend for infra/. Run once, by hand:
#
#   terraform init && terraform apply
#
# Its own state stays local (gitignored). It holds three resources and can be
# re-imported if lost.

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "tfstate" {
  name     = "job-scan-tfstate-rg"
  location = var.location
  tags     = { project = "job-scan" }
}

resource "azurerm_storage_account" "tfstate" {
  name                            = "jobscantfstate${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.tfstate.name
  location                        = azurerm_resource_group.tfstate.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  tags                            = { project = "job-scan" }

  # Recover an overwritten or deleted state file.
  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

# The backend authenticates with Entra ID, so the operator needs data access.
resource "azurerm_role_assignment" "operator_blob_contributor" {
  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
