resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name}-logs"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.retention_in_days
  tags                = var.tags
}

resource "azurerm_application_insights" "this" {
  name                = "${var.name}-insights"
  resource_group_name = var.resource_group_name
  location            = var.location
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = "Node.JS"
  tags                = var.tags
}
