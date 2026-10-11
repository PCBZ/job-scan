# Shared keys are off, so Terraform writes the blob through the data plane as
# whoever runs it. Owner doesn't include data actions; grant them on this
# container only.
resource "azurerm_role_assignment" "writer" {
  for_each             = var.writer_principal_ids
  scope                = var.container_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

# content_md5 makes an edit to the secret show up in the plan.
resource "azurerm_storage_blob" "this" {
  name                 = "config.toml"
  storage_container_id = var.container_id
  type                 = "Block"
  source_content       = var.content
  content_md5          = md5(var.content)
  content_type         = "application/toml"

  depends_on = [azurerm_role_assignment.writer]
}
