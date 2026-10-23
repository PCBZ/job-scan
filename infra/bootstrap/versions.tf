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

  # azurerm 5.x registers no resource providers by default. Registering needs
  # subscription rights, which CD doesn't have, so this registers the main
  # stack's providers too.
  resource_providers_to_register = [
    "Microsoft.Web",                 # Function App, plan
    "Microsoft.Storage",             # storage accounts, containers, tables
    "Microsoft.KeyVault",            # Key Vault
    "Microsoft.ManagedIdentity",     # the app's and CD's identities
    "Microsoft.Insights",            # Application Insights
    "Microsoft.AlertsManagement",    # Application Insights
    "Microsoft.OperationalInsights", # Log Analytics
    "Microsoft.CognitiveServices",   # Azure OpenAI
    "Microsoft.DocumentDB",          # Cosmos DB, for the judge's answers (#150)
  ]
}
