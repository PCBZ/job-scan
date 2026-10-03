locals {
  principal_id = azurerm_function_app_flex_consumption.this.identity[0].principal_id

  storage_roles = toset([
    "Storage Blob Data Owner",        # timer leases, deployment package, reports, caches
    "Storage Table Data Contributor", # seen messages, seen jobs, application records
    "Storage Queue Data Contributor", # used internally by identity-based host storage
  ])
}

resource "azurerm_role_assignment" "storage" {
  for_each             = local.storage_roles
  scope                = var.storage_account_id
  role_definition_name = each.key
  principal_id         = local.principal_id
}

resource "azurerm_role_assignment" "key_vault" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.principal_id
}
