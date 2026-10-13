output "endpoint" {
  value = azurerm_cognitive_account.this.endpoint
}

output "deployment_name" {
  value = azurerm_cognitive_deployment.this.name
}

# Tokens per minute the deployment allows; the app paces its calls to it.
output "tokens_per_minute" {
  value = azurerm_cognitive_deployment.this.sku[0].capacity * 1000
}

# The project's endpoints; the Foundry SDK takes the "AI Foundry API" one.
output "project_endpoints" {
  value = azurerm_cognitive_account_project.eval.endpoints
}
