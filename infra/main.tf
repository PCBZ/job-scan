data "azurerm_client_config" "current" {}

# Storage accounts, Key Vaults and Function Apps need globally unique names.
resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  compact_name = replace(var.name, "-", "")
  suffix       = random_string.suffix.result
}

resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = var.tags
}
