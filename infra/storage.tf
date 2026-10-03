module "storage" {
  source              = "./modules/storage"
  name                = "${replace(var.name, "-", "")}${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = var.tags

  containers = [
    "deployments",  # Flex Consumption deployment package
    "reports",      # HTML reports, read through user delegation SAS links
    "resume-cache", # extracted resume text, keyed by content hash
    "config",       # config.toml for the cloud run
  ]

  tables = [
    "seenmessages", # Message-IDs already fetched, per account
    "seenjobs",     # posting fingerprints already recommended
    "applications", # pending / approved / skipped / archived per posting
  ]
}
