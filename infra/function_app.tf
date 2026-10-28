module "function_app" {
  source              = "./modules/function_app"
  name                = "${var.name}-func-${local.suffix}"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  tags                = var.tags

  storage_account_name          = module.storage.name
  deployment_container_endpoint = module.storage.container_endpoints["deployments"]
  identity_id                   = var.platform.app_identity_id
  identity_client_id            = var.platform.app_client_id

  application_insights_connection_string = module.monitoring.connection_string

  app_settings = merge({
    # Secrets, read by the app at start (functions/src/lib/run/secrets.ts):
    # each listed setting from the secret named after it. Flex Consumption
    # can't resolve Key Vault references as a user-assigned identity.
    "KEY_VAULT_URI"     = var.platform.key_vault_uri
    "KEY_VAULT_SECRETS" = join(",", var.platform.secret_settings)
    # Model selection, read by functions/src/lib/model/config.ts. A fallback
    # would add the same keys prefixed MODEL_FALLBACK_.
    "MODEL_PROVIDER" = "azure-openai"
    "MODEL_ENDPOINT" = module.openai.endpoint
    "MODEL_NAME"     = module.openai.deployment_name
    # Calls are paced to the deployment's TPM (functions/src/lib/model/rate-limit.ts, #93).
    "MODEL_TPM" = tostring(module.openai.tokens_per_minute)
    # gpt-5.6 writes the prompt cache where the last message ends unless told
    # where the shared prefix does (#160); earlier models answer 400, so the
    # extract deployment never gets this.
    "MODEL_PROMPT_CACHE" = "explicit"
    # gpt-5.6 reasons at medium by default, and its reasoning tokens were 82% of
    # the judge's output on 2026-10-28 (#166); the extract deployment never gets
    # this. The default 2024-10-21 API version honours it (checked on luna: none
    # spent 0 reasoning tokens, medium 486).
    "MODEL_REASONING_EFFORT" = "none"
    # Extraction's own deployment (#148); the other MODEL_ keys are shared.
    "MODEL_EXTRACT_NAME" = module.openai.extract_deployment_name
    "MODEL_EXTRACT_TPM"  = tostring(module.openai.extract_tokens_per_minute)
    "CONFIG_BLOB_URL"    = module.config_blob.url
    "RESUME_CACHE_URL"   = module.storage.container_endpoints["resume-cache"]
    # seenmessages and seenjobs (#9, #15).
    "TABLES_URL" = module.storage.table_endpoint
    # Private; reports are read through user delegation SAS links (#19).
    "REPORTS_URL" = module.storage.container_endpoints["reports"]
    # Private; one JSONL file per run, for offline evaluation (#97).
    "RUN_RECORDS_URL" = module.storage.container_endpoints["run-records"]
    # Private; the daily run queues each run's evaluation report here (#128).
    "EVAL_QUEUE_URL" = module.storage.queue_urls["eval-reports"]
    # evalReport's queue trigger (#129) connects as the app's identity.
    "EvalQueue__queueServiceUri" = module.storage.queue_endpoint
    "EvalQueue__credential"      = "managedidentity"
    "EvalQueue__clientId"        = var.platform.app_client_id
    # evalReport reads each run's model-call latency from here (#130).
    "LOG_ANALYTICS_WORKSPACE_ID" = module.monitoring.workspace_id
    # evalReport posts the post-deploy smoke test's outcome here (#134).
    "EVAL_SMOKE_URL" = module.storage.queue_urls["eval-smoke"]
    # The release CD deployed, written into each run record.
    "APP_VERSION" = var.app_version
    # Jev, read by functions/src/lib/decision/config.ts. The model is pinned:
    # confidence thresholds are tuned against one version.
    "JEV_MODEL" = "jev-1.13.0"
    },
    # The judge's answers, in the bootstrap's Cosmos account (#150). Unset until
    # bootstrap has been applied and infra/set-github-vars.sh run again: the app
    # then judges everything, as before.
    var.platform.cosmos_endpoint == null ? {} : {
      "COSMOS_ENDPOINT"  = var.platform.cosmos_endpoint
      "COSMOS_DATABASE"  = var.platform.cosmos_database
      "COSMOS_CONTAINER" = var.platform.cosmos_container
    },
  )
}
