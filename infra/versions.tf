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

  # Partial config: the values live in backend.hcl (see backend.hcl.example),
  # created by infra/bootstrap.
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  # Shared keys are disabled on the storage account; use Entra ID for data-plane calls.
  storage_use_azuread = true

  # azurerm 5.x registers no resource providers by default.
  resource_providers_to_register = var.register_resource_providers ? [
    "Microsoft.Web",                 # Function App, plan
    "Microsoft.Storage",             # storage account, containers, tables
    "Microsoft.KeyVault",            # Key Vault
    "Microsoft.Insights",            # Application Insights
    "Microsoft.AlertsManagement",    # Application Insights
    "Microsoft.OperationalInsights", # Log Analytics
    "Microsoft.CognitiveServices",   # Azure OpenAI
  ] : []
}
