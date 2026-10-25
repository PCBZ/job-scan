# Entra ID only: no API keys exist to leak.
#
# A Foundry resource (AIServices) rather than plain OpenAI, so it can hold a
# project for evaluations (#96). azurerm changes kind between OpenAI and
# AIServices in place: the deployment, endpoint and roles stay.
resource "azurerm_cognitive_account" "this" {
  name                       = var.name
  resource_group_name        = var.resource_group_name
  location                   = var.location
  kind                       = "AIServices"
  sku_name                   = "S0"
  custom_subdomain_name      = var.name # required for Entra ID auth
  local_auth_enabled         = false
  project_management_enabled = true
  tags                       = var.tags

  # Required with project_management_enabled.
  identity {
    type = "SystemAssigned"
  }
}

# Evaluations live in a project: evaluators, eval runs and their results.
# Free itself; runs bill per use.
resource "azurerm_cognitive_account_project" "eval" {
  name                 = var.project_name
  cognitive_account_id = azurerm_cognitive_account.this.id
  location             = var.location
  description          = "Offline evaluation of the daily run"
  tags                 = var.tags

  identity {
    type = "SystemAssigned"
  }
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

  # A pinned version stays until it is retired; without one, Azure assigns the
  # default version and upgrades it, so Terraform doesn't track it, and each
  # run records the version that answered.
  version_upgrade_option = var.model_version == null ? "OnceNewDefaultVersionAvailable" : "OnceCurrentVersionExpired"

  lifecycle {
    ignore_changes = [model[0].version]
  }
}

# A second deployment, for extraction alone (#148): it copies fields from
# short alert text, and code checks every row, so a smaller model serves it.
# It follows the model's default version: Azure assigns it and upgrades it, so
# Terraform doesn't track it, and each run records the version that answered.
resource "azurerm_cognitive_deployment" "extract" {
  count                = var.extract_model == null ? 0 : 1
  name                 = var.extract_model.name
  cognitive_account_id = azurerm_cognitive_account.this.id

  model {
    format = "OpenAI"
    name   = var.extract_model.name
  }

  sku {
    name     = "GlobalStandard"
    capacity = var.extract_model.capacity_k_tpm
  }

  version_upgrade_option = "OnceNewDefaultVersionAvailable"

  lifecycle {
    ignore_changes = [model[0].version]
  }

  # Azure changes one deployment of an account at a time.
  depends_on = [azurerm_cognitive_deployment.this]
}
