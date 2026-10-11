# config.toml lives in Key Vault (secret config-toml), so a CD run has it too;
# Terraform copies it to the blob the app reads. It carries no credentials by
# design, and the value passes through state.
data "azurerm_key_vault_secret" "config" {
  name         = "config-toml"
  key_vault_id = module.key_vault.id
}

module "config_blob" {
  source       = "./modules/config_blob"
  container_id = module.storage.container_ids["config"]
  content      = data.azurerm_key_vault_secret.config.value
  writer_principal_ids = {
    operator = var.operator_principal_id
    deployer = module.github_oidc.principal_id
  }
}

# The operator's writer role was a single resource before CD also wrote it.
moved {
  from = module.config_blob.azurerm_role_assignment.operator
  to   = module.config_blob.azurerm_role_assignment.writer["operator"]
}
