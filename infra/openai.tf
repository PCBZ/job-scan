module "openai" {
  source              = "./modules/openai"
  name                = "${var.name}-openai-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags
  project_name        = "${var.name}-eval"

  # One deployment for every call: extraction, judge and explain, on gpt-6-luna,
  # which Retail Prices lists at half gpt-5.6-luna's price per token. It takes
  # reasoning_effort "none" and the explicit prompt cache, checked on the
  # deployment (#169). gpt-5-mini has no Global Standard in Canada Central (#156).
  model_name = "gpt-6-luna"
  # The first run's backlog hit 50K TPM's 429s (#91). The subscription's quota
  # is 1000K; capacity is a ceiling on that quota, and billing stays per token.
  # It carries what the two deployments did before: 250K for the judge, 150K for
  # extraction.
  capacity_k_tpm = 400
}

# Foundry's Traces view reads the traces both apps already send to Application
# Insights; it stores none of its own (#207). On the account, as azurerm has no
# project-level connection; account connections are shared with its projects.
resource "azurerm_cognitive_account_connection_api_key" "app_insights" {
  name                 = "${var.name}-insights"
  cognitive_account_id = module.openai.account_id
  category             = "AppInsights"
  target               = module.monitoring.app_insights_id
  api_key              = module.monitoring.connection_string
  # Required for this category: without it the service answers 400,
  # "Required metadata property ResourceId is missing" (v0.2.5's apply).
  metadata = {
    ResourceId = module.monitoring.app_insights_id
  }
}
