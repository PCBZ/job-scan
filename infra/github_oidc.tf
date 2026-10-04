module "github_oidc" {
  source              = "./modules/github_oidc"
  name                = "${var.name}-github-deploy"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  repository          = var.github_repository
  branch              = var.github_branch
  function_app_id     = module.function_app.id
  tags                = var.tags
}
