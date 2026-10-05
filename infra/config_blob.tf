module "config_blob" {
  source                = "./modules/config_blob"
  container_id          = module.storage.container_ids["config"]
  source_path           = coalesce(var.config_toml_path, "${path.root}/../config.toml")
  operator_principal_id = data.azurerm_client_config.current.object_id
}
