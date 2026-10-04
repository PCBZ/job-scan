# Entra ID only: no API keys exist to leak.
resource "azurerm_cognitive_account" "this" {
  name                  = var.name
  resource_group_name   = var.resource_group_name
  location              = var.location
  kind                  = "OpenAI"
  sku_name              = "S0"
  custom_subdomain_name = var.name # required for Entra ID auth
  local_auth_enabled    = false
  tags                  = var.tags
}

resource "azurerm_cognitive_deployment" "this" {
  name                 = var.model_name
  cognitive_account_id = azurerm_cognitive_account.this.id

  model {
    format  = "OpenAI"
    name    = var.model_name
    version = var.model_version
  }

  # Global Standard: data at rest stays in the account's region; requests may
  # be processed in any Azure region.
  sku {
    name     = "GlobalStandard"
    capacity = var.capacity_k_tpm
  }

  # Stay on the pinned version until it is retired.
  version_upgrade_option = "OnceCurrentVersionExpired"
}

resource "azurerm_role_assignment" "user" {
  for_each             = var.user_principal_ids
  scope                = azurerm_cognitive_account.this.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = each.value
}
