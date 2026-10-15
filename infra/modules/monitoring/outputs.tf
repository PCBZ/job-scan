output "connection_string" {
  value     = azurerm_application_insights.this.connection_string
  sensitive = true
}

# The workspace's id (a GUID), which Log Analytics queries name (#130).
output "workspace_id" {
  value = azurerm_log_analytics_workspace.this.workspace_id
}
