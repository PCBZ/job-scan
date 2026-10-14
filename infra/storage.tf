module "storage" {
  source              = "./modules/storage"
  name                = "${replace(var.name, "-", "")}${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags

  containers = [
    "deployments",  # Flex Consumption deployment package
    "reports",      # HTML reports, read through user delegation SAS links
    "resume-cache", # extracted resume text, keyed by content hash
    "config",       # config.toml for the cloud run
    "run-records",  # each run's postings, filters, picks and metrics (#97)
  ]

  # Run records hold real mail and resume text: keep them 90 days only.
  expire_after_days = {
    "run-records" = 90
  }

  queues = [
    "eval-reports", # one message per run, for its evaluation report (#127)
  ]

  tables = [
    "seenmessages", # Message-IDs already fetched, per account
    "seenjobs",     # posting fingerprints already recommended
  ]
}
