# The app, built by CD from an empty resource group. infra/bootstrap creates the
# group, the Key Vault, the identities and every role assignment, so this
# stack holds none: CD's Contributor is enough.

# Storage accounts, OpenAI accounts and Function Apps need globally unique names.
resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  suffix = random_string.suffix.result

  # How the Node app calls the model (functions/src/lib/model/config.ts, #200).
  model_tuning = {
    # gpt-6-luna and gpt-5.6 write the prompt cache where the last message ends
    # unless told where the shared prefix does (#160); earlier models answer 400.
    "MODEL_PROMPT_CACHE" = "explicit"
    # They reason at medium by default, and gpt-5.6-luna's reasoning tokens were
    # 82% of the judge's output on 2026-10-28 (#166). The default 2024-10-21 API
    # version honours "none" (checked on both).
    "MODEL_REASONING_EFFORT" = "none"
  }
}

data "azurerm_resource_group" "main" {
  name = var.platform.resource_group_name
}
