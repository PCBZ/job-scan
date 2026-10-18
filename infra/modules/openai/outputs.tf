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

# The extraction deployment, null without one (#148).
output "extract_deployment_name" {
  value = one(azurerm_cognitive_deployment.extract[*].name)
}

output "extract_tokens_per_minute" {
  value = one([for d in azurerm_cognitive_deployment.extract : d.sku[0].capacity * 1000])
}

# The project's endpoints; the Foundry SDK takes the "AI Foundry API" one.
output "project_endpoints" {
  value = azurerm_cognitive_account_project.eval.endpoints
}
