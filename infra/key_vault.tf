module "key_vault" {
  source                       = "./modules/key_vault"
  name                         = "${var.name}-kv-${local.suffix}"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  tenant_id                    = data.azurerm_client_config.current.tenant_id
  secrets_officer_principal_id = var.operator_principal_id
  tags                         = var.tags
}
