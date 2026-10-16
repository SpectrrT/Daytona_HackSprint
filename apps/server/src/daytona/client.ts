import { Daytona } from "@daytona/sdk";
import { config, ConfigError, requireConfig } from "../config.js";

let client: Daytona | undefined;

export function daytona(): Daytona {
  client ??= new Daytona({
    apiKey: requireConfig("DAYTONA_API_KEY", "Create a key at https://app.daytona.io/dashboard/keys and add it to .env."),
    apiUrl: config.DAYTONA_API_URL,
    target: config.DAYTONA_TARGET,
  });
  return client;
}

/** Check availability before spending model calls. Does not create resources. */
export async function requireHardwareSnapshot(
  name = config.PROD_SNAPSHOT,
  getSnapshot: (name: string) => Promise<{ state: string }> = (name) => daytona().snapshot.get(name),
): Promise<void> {
  let snapshot: { state: string };
  try { snapshot = await getSnapshot(name); }
  catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
    const detail = status === 404 ? "The configured snapshot is unavailable to this key. Set PROD_SNAPSHOT to an available image, such as daytona-medium."
      : status === 401 || status === 403 ? "The configured key cannot access this snapshot. Check its account and snapshot permissions."
      : "Daytona could not confirm the configured snapshot. Check provider availability and configuration.";
    throw new ConfigError(detail);
  }
  if (snapshot.state !== "active") throw new ConfigError("The configured Daytona snapshot is not active. Wait for it to become active or select another available image.");
}
