# What the CD identity needs to run `terraform apply` on the main stack.
#
# Contributor reads role assignments but can't write them, so CD applies only
# while the stack's role assignments are unchanged. A change to them is applied
# locally by the operator first; CD then fails on it instead of granting rights.

data "azurerm_resource_group" "main" {
  count = var.deployer == null ? 0 : 1
  name  = var.deployer.resource_group_name
}

resource "azurerm_role_assignment" "deployer_contributor" {
  count                = var.deployer == null ? 0 : 1
  scope                = data.azurerm_resource_group.main[0].id
  role_definition_name = "Contributor"
  principal_id         = var.deployer.principal_id
}

# The backend authenticates with Entra ID: read and write the state.
resource "azurerm_role_assignment" "deployer_state" {
  count                = var.deployer == null ? 0 : 1
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.deployer.principal_id
}
