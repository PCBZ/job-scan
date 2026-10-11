# Trusts a run of a workflow named CD on any tag of this repository: GitHub
# puts the workflow's name and the ref type in the subject (set by
# infra/set-github-vars.sh from github_oidc_claim_keys), so a branch run gets
# ref_type:branch and no token. Which tag, and what the workflow file says,
# isn't part of the subject: v* and "on main" are checked by cd.yml, which
# whoever creates the tag controls. So creating tags is the boundary, limited
# to admins by the tag ruleset set-github-vars.sh applies.
locals {
  github_subject_claims = [
    { key = "workflow", value = var.github_workflow },
    { key = "ref_type", value = "tag" },
  ]
}

module "github_oidc" {
  source              = "./modules/github_oidc"
  name                = "${var.name}-github-deploy"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  repository          = var.github_repository
  subject_claims      = local.github_subject_claims
  key_vault_id        = module.key_vault.id
  tags                = var.tags
}
