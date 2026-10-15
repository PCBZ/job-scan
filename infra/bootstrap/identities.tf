# Every role assignment the deployment needs, so CD never grants one. Roles on
# the main resource group reach whatever CD creates in it.

locals {
  operator = data.azurerm_client_config.current.object_id
}

# The Function App's identity. User-assigned, so it and its roles exist before
# the app does, and survive a rebuild.
resource "azurerm_user_assigned_identity" "app" {
  name                = "${var.name}-app"
  resource_group_name = azurerm_resource_group.platform.name
  location            = azurerm_resource_group.platform.location
  tags                = var.tags
}

locals {
  app_roles = toset([
    "Storage Blob Data Owner",        # timer leases, deployment package, reports, caches
    "Storage Table Data Contributor", # seen messages, seen jobs
    "Storage Queue Data Contributor", # used internally by identity-based host storage
    "Cognitive Services OpenAI User", # the model
    "Log Analytics Reader",           # evalReport reads each run's latency (#130)
  ])
}

resource "azurerm_role_assignment" "app" {
  for_each             = local.app_roles
  scope                = azurerm_resource_group.main.id
  role_definition_name = each.key
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_secrets" {
  scope                = module.key_vault.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# CD's identity, trusted for a run of a workflow named CD on any tag of this
# repository: GitHub puts the workflow's name and the ref type in the subject
# (set by infra/set-github-vars.sh from github_oidc_claim_keys), so a branch run
# gets ref_type:branch and no token. Which tag, and what the workflow file
# says, isn't part of the subject: v* and "on main" are checked by cd.yml,
# which whoever creates the tag controls. So creating tags is the boundary,
# limited to admins by the tag ruleset set-github-vars.sh applies.
locals {
  github_subject_claims = [
    { key = "workflow", value = var.github_workflow },
    { key = "ref_type", value = "tag" },
  ]
}

module "github_oidc" {
  source              = "../modules/github_oidc"
  name                = "${var.name}-github-deploy"
  resource_group_name = azurerm_resource_group.platform.name
  location            = azurerm_resource_group.platform.location
  repository          = var.github_repository
  subject_claims      = local.github_subject_claims
  tags                = var.tags
}

# Contributor builds everything in the group but can't assign roles; the blob
# role writes the config blob; the queue role runs the post-deploy smoke test
# (#134); the secret role reads config-toml.
resource "azurerm_role_assignment" "deployer" {
  for_each             = toset(["Contributor", "Storage Blob Data Contributor", "Storage Queue Data Contributor"])
  scope                = azurerm_resource_group.main.id
  role_definition_name = each.key
  principal_id         = module.github_oidc.principal_id
}

resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = module.key_vault.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = module.github_oidc.principal_id
}

# data.azurerm_key_vault_secret reads the vault over ARM first, for its URL; the
# data-plane role above doesn't cover that (#85). Reader on this vault only: its
# properties, never a secret's value, and no writes.
resource "azurerm_role_assignment" "deployer_vault_reader" {
  scope                = module.key_vault.id
  role_definition_name = "Reader"
  principal_id         = module.github_oidc.principal_id
}

# Attaching the app's identity to the Function App needs assign on the identity
# itself, a linked check across resource groups (#85). Managed Identity Operator
# on that one identity: read and assign it, never change or delete it.
resource "azurerm_role_assignment" "deployer_app_identity" {
  scope                = azurerm_user_assigned_identity.app.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = module.github_oidc.principal_id
}

# The backend authenticates with Entra ID: read and write the state.
resource "azurerm_role_assignment" "deployer_state" {
  scope                = azurerm_storage_container.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.github_oidc.principal_id
}

# The operator: a local apply writes the config blob, the live evals call the
# model, and Foundry evaluations run in the project (Foundry User, formerly
# Azure AI User; #96). The vault's Secrets Officer comes with the key_vault
# module.
resource "azurerm_role_assignment" "operator" {
  for_each             = toset(["Storage Blob Data Contributor", "Cognitive Services OpenAI User", "Foundry User"])
  scope                = azurerm_resource_group.main.id
  role_definition_name = each.key
  principal_id         = local.operator
}
