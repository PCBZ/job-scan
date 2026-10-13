module "openai" {
  source              = "./modules/openai"
  name                = "${var.name}-openai-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags
  project_name        = "${var.name}-eval"

  # Option A from the plan (#1). gpt-5.4-mini is on Global Standard in Canada Central.
  model_name    = "gpt-5.4-mini"
  model_version = "2026-03-17"
  # The first run's backlog hit 50K TPM's 429s (#91). The subscription's quota
  # is 1000K; capacity is a ceiling on that quota, and billing stays per token.
  capacity_k_tpm = 250
}
