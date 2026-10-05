# Shared keys are off, so Terraform writes the blob through the data plane as
# the operator. Owner doesn't include data actions; grant them on this
# container only.
resource "azurerm_role_assignment" "operator" {
  scope                = var.container_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.operator_principal_id
}

# config.toml carries no credentials by design. content_md5 makes an edit to
# the local file show up in the plan.
resource "azurerm_storage_blob" "this" {
  name                 = "config.toml"
  storage_container_id = var.container_id
  type                 = "Block"
  source               = var.source_path
  content_md5          = filemd5(var.source_path)
  content_type         = "application/toml"

  depends_on = [azurerm_role_assignment.operator]
}
