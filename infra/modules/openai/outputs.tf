output "endpoint" {
  value = azurerm_cognitive_account.this.endpoint
}

output "deployment_name" {
  value = azurerm_cognitive_deployment.this.name
}
