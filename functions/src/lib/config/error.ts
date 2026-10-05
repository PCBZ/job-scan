/** A missing or invalid config.toml. The run must stop; there are no defaults. */
export class ConfigError extends Error {
  override name = "ConfigError";
}
