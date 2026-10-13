output "resource_group_name" {
  value = data.azurerm_resource_group.main.name
}

output "function_app_name" {
  value = module.function_app.name
}

output "function_app_hostname" {
  value = module.function_app.default_hostname
}

output "storage_account_name" {
  value = module.storage.name
}

output "openai_endpoint" {
  value = module.openai.endpoint
}

output "openai_deployment" {
  value = module.openai.deployment_name
}

output "foundry_project_endpoints" {
  value = module.openai.project_endpoints
}
