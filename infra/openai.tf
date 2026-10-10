module "openai" {
  source              = "./modules/openai"
  name                = "${var.name}-openai-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = var.tags

  # Option A from the plan (#1). gpt-5.4-mini is on Global Standard in Canada Central.
  model_name     = "gpt-5.4-mini"
  model_version  = "2026-03-17"
  capacity_k_tpm = 50

  user_principal_ids = {
    function = module.function_app.principal_id
    operator = var.operator_principal_id
  }
}
