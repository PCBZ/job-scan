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

# Reads config-toml during apply. Its rights over the resource group and the
# state are granted in infra/bootstrap, so a CD run can't change them.
resource "azurerm_role_assignment" "config_reader" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}
