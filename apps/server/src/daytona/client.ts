import { Daytona } from "@daytona/sdk";
import { config, requireConfig } from "../config.js";

let client: Daytona | undefined;

export function daytona(): Daytona {
  client ??= new Daytona({
    apiKey: requireConfig("DAYTONA_API_KEY", "Create a key at https://app.daytona.io/dashboard/keys and add it to .env."),
    apiUrl: config.DAYTONA_API_URL,
    target: config.DAYTONA_TARGET,
  });
  return client;
}
