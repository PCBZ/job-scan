output "id" {
  value = azurerm_storage_account.this.id
}

output "name" {
  value = azurerm_storage_account.this.name
}

# Built from the container resources, so consumers wait for the containers.
output "container_endpoints" {
  value = {
    for key, c in azurerm_storage_container.this :
    key => "${azurerm_storage_account.this.primary_blob_endpoint}${c.name}"
  }
}

output "container_ids" {
  value = { for key, c in azurerm_storage_container.this : key => c.id }
}

# The account's table endpoint, after the tables exist so consumers wait.
output "table_endpoint" {
  value      = azurerm_storage_account.this.primary_table_endpoint
  depends_on = [azurerm_storage_table.this]
}
