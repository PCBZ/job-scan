# Identity that GitHub Actions assumes through OIDC: no stored secret.
resource "azurerm_user_assigned_identity" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# Trusts only workflow runs on the given branch of the given repository.
resource "azurerm_federated_identity_credential" "this" {
  name                      = "github-${var.branch}"
  user_assigned_identity_id = azurerm_user_assigned_identity.this.id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = "repo:${var.repository}:ref:refs/heads/${var.branch}"
}

# Enough to deploy code to the Function App, nothing else.
resource "azurerm_role_assignment" "deploy" {
  scope                = var.function_app_id
  role_definition_name = "Website Contributor"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}
