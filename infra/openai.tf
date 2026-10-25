module "openai" {
  source              = "./modules/openai"
  name                = "${var.name}-openai-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags
  project_name        = "${var.name}-eval"

  # Judge and explain on gpt-5.6-luna (#158), at its default reasoning effort and
  # version, to see what it does before tuning either. gpt-5-mini has no Global
  # Standard in Canada Central (#156).
  model_name = "gpt-5.6-luna"
  # The first run's backlog hit 50K TPM's 429s (#91). The subscription's quota
  # is 1000K; capacity is a ceiling on that quota, and billing stays per token.
  capacity_k_tpm = 250

  # Extraction on gpt-5.4-nano (#148): about a quarter of mini's price, on its
  # own TPM; a run's extraction is about 96K tokens. It follows the default
  # version, since code checks every row it extracts; judge stays pinned above,
  # as its levels move the ranking.
  extract_model = {
    name           = "gpt-5.4-nano"
    capacity_k_tpm = 150
  }
}
