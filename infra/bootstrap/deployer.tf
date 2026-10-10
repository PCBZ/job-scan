# What the CD identity needs to run `terraform apply` on the main stack.

data "azurerm_resource_group" "main" {
  count = var.deployer == null ? 0 : 1
  name  = var.deployer.resource_group_name
}

# The roles the main stack assigns. CD may grant only these, so it can't hand
# out Owner or more RBAC rights, its own included.
data "azurerm_role_definition" "assignable" {
  for_each = var.deployer == null ? toset([]) : toset([
    "Cognitive Services OpenAI User",
    "Key Vault Secrets Officer",
    "Key Vault Secrets User",
    "Storage Blob Data Contributor",
    "Storage Blob Data Owner",
    "Storage Queue Data Contributor",
    "Storage Table Data Contributor",
  ])
  name = each.key
}

locals {
  assignable = join(", ", sort([for r in data.azurerm_role_definition.assignable : r.role_definition_id]))
}

resource "azurerm_role_assignment" "deployer_contributor" {
  count                = var.deployer == null ? 0 : 1
  scope                = data.azurerm_resource_group.main[0].id
  role_definition_name = "Contributor"
  principal_id         = var.deployer.principal_id
}

# Writes and deletes only assignments of the roles above:
# https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-examples
resource "azurerm_role_assignment" "deployer_rbac" {
  count                = var.deployer == null ? 0 : 1
  scope                = data.azurerm_resource_group.main[0].id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = var.deployer.principal_id
  condition_version    = "2.0"
  condition            = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable}}
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable}}
     )
    )
  EOT
}

# The backend authenticates with Entra ID: read and write the state.
resource "azurerm_role_assignment" "deployer_state" {
  count                = var.deployer == null ? 0 : 1
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.deployer.principal_id
}
