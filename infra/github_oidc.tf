# Only tag pushes of the CD workflow may deploy: GitHub puts the workflow's
# name and the ref type in the subject (set by infra/set-github-vars.sh from
# github_oidc_claim_keys), so a branch run gets ref_type:branch and no token.
# The workflow itself checks that the tag is v* and on main.
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
