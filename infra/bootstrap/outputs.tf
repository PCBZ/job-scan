output "backend_hcl" {
  description = "Paste into infra/backend.hcl."
  value       = <<-EOT
    resource_group_name  = "${azurerm_resource_group.tfstate.name}"
    storage_account_name = "${azurerm_storage_account.tfstate.name}"
    container_name       = "${azurerm_storage_container.tfstate.name}"
    key                  = "job-scan.tfstate"
    use_azuread_auth     = true
  EOT
}

locals {
  # What the main stack builds on: identifiers and names, no secrets.
  platform = {
    resource_group_name = azurerm_resource_group.main.name
    key_vault_id        = module.key_vault.id
    key_vault_uri       = module.key_vault.uri
    app_identity_id     = azurerm_user_assigned_identity.app.id
    app_client_id       = azurerm_user_assigned_identity.app.client_id
    secret_settings     = local.secret_settings
    # The judge's answers (#150): names, no keys, as Cosmos has local auth off.
    cosmos_endpoint  = azurerm_cosmosdb_account.judgements.endpoint
    cosmos_database  = azurerm_cosmosdb_sql_database.job_scan.name
    cosmos_container = azurerm_cosmosdb_sql_container.judgements.name
  }
}

output "key_vault_uri" {
  value = module.key_vault.uri
}

# For a local apply of the main stack:
#   terraform output -json main_tfvars > ../platform.auto.tfvars.json
output "main_tfvars" {
  value = { platform = local.platform }
}

# Repository variables for .github/workflows/cd.yml, set by
# infra/set-github-vars.sh. Identifiers, not secrets.
output "github_variables" {
  value = {
    AZURE_CLIENT_ID         = module.github_oidc.client_id
    AZURE_TENANT_ID         = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID   = data.azurerm_client_config.current.subscription_id
    TFSTATE_RESOURCE_GROUP  = azurerm_resource_group.tfstate.name
    TFSTATE_STORAGE_ACCOUNT = azurerm_storage_account.tfstate.name
    TFSTATE_CONTAINER       = azurerm_storage_container.tfstate.name
    TFSTATE_KEY             = "job-scan.tfstate"
    TF_VAR_platform         = jsonencode(local.platform)
  }
}

# The repository's OIDC subject template: repo, then the claims the CD
# identity trusts, in order. infra/set-github-vars.sh applies it.
output "github_oidc_claim_keys" {
  value = concat(["repo"], [for c in local.github_subject_claims : c.key])
}
