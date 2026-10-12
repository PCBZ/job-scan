# config.toml lives in Key Vault (secret config-toml), so a CD run has it too;
# Terraform copies it to the blob the app reads. It carries no credentials by
# design, and the value passes through state. Whoever applies writes the blob
# with the data role infra/bootstrap grants on the resource group.
data "azurerm_key_vault_secret" "config" {
  name         = "config-toml"
  key_vault_id = var.platform.key_vault_id
}

module "config_blob" {
  source       = "./modules/config_blob"
  container_id = module.storage.container_ids["config"]
  content      = data.azurerm_key_vault_secret.config.value
}
