# The judge's answers, kept for 14 days so a posting seen again isn't judged
# again (#150). Here, not in the main stack, because Cosmos's data-plane roles
# are children of the account (sqlRoleAssignments), so the role can only exist
# once the account does, and every role assignment is bootstrap's. Beside the
# Key Vault, it survives a destroy of the main stack.
#
# In its own region (var.cosmos_location): Canada Central had no Cosmos DB
# capacity for this subscription. Serverless only, billed per request unit and
# GB stored: about half a cent a month. Provisioned throughput bills a 400 RU/s minimum, about $26 a month,
# and is what an account is created with unless it says otherwise.
resource "azurerm_cosmosdb_account" "judgements" {
  name                = "${var.name}-cosmos-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.cosmos_location
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"
  minimal_tls_version = "Tls12"
  tags                = var.tags

  # Entra ID only: the app signs in as its identity, so no key exists to leak.
  # The portal's Data Explorer needs a key, so it won't open this account.
  local_authentication_enabled = false

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.cosmos_location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "job_scan" {
  name                = var.name
  resource_group_name = azurerm_resource_group.platform.name
  account_name        = azurerm_cosmosdb_account.judgements.name
}

# One item per judged request: its `id` is the sha256 the app computes
# (functions/src/lib/judge/cache.ts), and so is its partition key. Read by id
# alone, so nothing is indexed: a write costs fewer RU. Items expire 14 days
# after their last write.
resource "azurerm_cosmosdb_sql_container" "judgements" {
  name                = "judgements"
  resource_group_name = azurerm_resource_group.platform.name
  account_name        = azurerm_cosmosdb_account.judgements.name
  database_name       = azurerm_cosmosdb_sql_database.job_scan.name
  partition_key_paths = ["/id"]
  default_ttl         = 14 * 24 * 60 * 60

  indexing_policy {
    indexing_mode = "consistent"

    excluded_path {
      path = "/*"
    }
  }
}

# "Cosmos DB Built-in Data Contributor", over this container only: the app reads
# and writes its items, and nothing else in any account.
resource "azurerm_cosmosdb_sql_role_assignment" "app" {
  resource_group_name = azurerm_resource_group.platform.name
  account_name        = azurerm_cosmosdb_account.judgements.name
  role_definition_id  = "${azurerm_cosmosdb_account.judgements.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_user_assigned_identity.app.principal_id
  scope               = "${azurerm_cosmosdb_account.judgements.id}/dbs/${azurerm_cosmosdb_sql_database.job_scan.name}/colls/${azurerm_cosmosdb_sql_container.judgements.name}"
}
