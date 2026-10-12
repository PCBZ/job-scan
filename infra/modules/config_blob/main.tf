# Shared keys are off, so Terraform writes the blob through the data plane, as
# whoever applies; infra/bootstrap grants that role on the resource group.
# content_md5 makes an edit to the secret show up in the plan.
resource "azurerm_storage_blob" "this" {
  name                 = "config.toml"
  storage_container_id = var.container_id
  type                 = "Block"
  source_content       = var.content
  content_md5          = md5(var.content)
  content_type         = "application/toml"
}
