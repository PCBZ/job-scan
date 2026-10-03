terraform {
  required_version = ">= 1.13"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

provider "azurerm" {
  features {}
  storage_use_azuread = true

  # azurerm 5.x registers no resource providers by default.
  resource_providers_to_register = ["Microsoft.Storage"]
}
