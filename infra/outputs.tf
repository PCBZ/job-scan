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
    AZURE_CLIENT_ID       = module.github_oidc.client_id
    AZURE_TENANT_ID       = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = data.azurerm_client_config.current.subscription_id
    # Terraform's inputs in CD: identifiers and names, no values.
    TF_VAR_operator_principal_id = var.operator_principal_id
    TF_VAR_mail_credential_envs  = jsonencode(var.mail_credential_envs)
  }
}

# For infra/bootstrap: the CD identity, and the resource group it manages.
output "deployer" {
  value = {
    principal_id        = module.github_oidc.principal_id
    resource_group_name = azurerm_resource_group.main.name
  }
}

# The repository's OIDC subject template: repo, then the claims the deploy
# identity trusts, in order. infra/set-github-vars.sh applies it.
output "github_oidc_claim_keys" {
  value = concat(["repo"], [for c in local.github_subject_claims : c.key])
}
