# One account for the Functions host, the deployment package and app data.
# Shared keys are off: everything authenticates with Entra ID.
resource "azurerm_storage_account" "main" {
  name                            = "${local.compact_name}${local.suffix}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

# The Flex Consumption deployment package.
resource "azurerm_storage_container" "deployments" {
  name                  = "deployments"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# HTML reports, read through short-lived user delegation SAS links.
resource "azurerm_storage_container" "reports" {
  name                  = "reports"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Extracted resume text, keyed by content hash.
resource "azurerm_storage_container" "resume_cache" {
  name                  = "resume-cache"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# config.toml for the cloud run.
resource "azurerm_storage_container" "config" {
  name                  = "config"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Message-IDs already fetched, per account.
resource "azurerm_storage_table" "seen_messages" {
  name               = "seenmessages"
  storage_account_id = azurerm_storage_account.main.id
}

# Posting fingerprints already recommended.
resource "azurerm_storage_table" "seen_jobs" {
  name               = "seenjobs"
  storage_account_id = azurerm_storage_account.main.id
}

# One row per recommended posting: pending / approved / skipped / archived.
resource "azurerm_storage_table" "applications" {
  name               = "applications"
  storage_account_id = azurerm_storage_account.main.id
}
