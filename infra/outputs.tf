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

output "openai_endpoint" {
  value = module.openai.endpoint
}

output "openai_deployment" {
  value = module.openai.deployment_name
}

# Repository variables for .github/workflows/cd.yml. Identifiers, not secrets.
output "github_variables" {
  value = {
    AZURE_CLIENT_ID        = module.github_oidc.client_id
    AZURE_TENANT_ID        = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID  = data.azurerm_client_config.current.subscription_id
    AZURE_FUNCTIONAPP_NAME = module.function_app.name
  }
}
