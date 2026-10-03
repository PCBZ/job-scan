output "name" {
  value = azurerm_function_app_flex_consumption.this.name
}

output "default_hostname" {
  value = azurerm_function_app_flex_consumption.this.default_hostname
}

output "principal_id" {
  value = azurerm_function_app_flex_consumption.this.identity[0].principal_id
}
