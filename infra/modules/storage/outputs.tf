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
