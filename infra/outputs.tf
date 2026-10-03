output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "function_app_name" {
  value = module.function_app.name
}

output "function_app_hostname" {
  value = module.function_app.default_hostname
}

output "storage_account_name" {
  value = module.storage.name
}

output "key_vault_uri" {
  value = module.key_vault.uri
}
