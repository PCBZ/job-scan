output "backend_hcl" {
  description = "Paste into infra/backend.hcl."
  value       = <<-EOT
    resource_group_name  = "${azurerm_resource_group.tfstate.name}"
    storage_account_name = "${azurerm_storage_account.tfstate.name}"
    container_name       = "${azurerm_storage_container.tfstate.name}"
    key                  = "job-scan.tfstate"
    use_azuread_auth     = true
  EOT
}
