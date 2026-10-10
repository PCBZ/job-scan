# Identity that GitHub Actions assumes through OIDC: no stored secret.
resource "azurerm_user_assigned_identity" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# Trusts only workflow runs whose subject carries these claims. The repository's
# subject template must list the same keys, in the same order:
# https://docs.github.com/en/actions/reference/security/oidc
resource "azurerm_federated_identity_credential" "this" {
  name                      = lower("github-${join("-", [for c in var.subject_claims : c.value])}")
  user_assigned_identity_id = azurerm_user_assigned_identity.this.id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = join(":", concat(["repo", var.repository], flatten([for c in var.subject_claims : [c.key, c.value]])))
}

# Enough to deploy code to the Function App, nothing else.
resource "azurerm_role_assignment" "deploy" {
  scope                = var.function_app_id
  role_definition_name = "Website Contributor"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}
