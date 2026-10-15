# Shared keys are off: everything authenticates with Entra ID.
resource "azurerm_storage_account" "this" {
  name                            = var.name
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_storage_container" "this" {
  for_each              = var.containers
  name                  = each.key
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_storage_queue" "this" {
  for_each           = var.queues
  name               = each.key
  storage_account_id = azurerm_storage_account.this.id
}

resource "azurerm_storage_table" "this" {
  for_each           = var.tables
  name               = each.key
  storage_account_id = azurerm_storage_account.this.id
}

# One policy per account; a rule per expiring container.
resource "azurerm_storage_management_policy" "this" {
  count              = length(var.expire_after_days) > 0 ? 1 : 0
  storage_account_id = azurerm_storage_account.this.id

  dynamic "rule" {
    for_each = var.expire_after_days
    content {
      name    = "expire-${rule.key}"
      enabled = true
      filters {
        blob_types   = ["blockBlob"]
        prefix_match = ["${azurerm_storage_container.this[rule.key].name}/"]
      }
      actions {
        base_blob {
          delete_after_days_since_modification_greater_than = rule.value
        }
      }
    }
  }
}
