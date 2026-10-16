import { resolve } from "node:path";
import { Image } from "@daytona/sdk";
import { REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";

async function main() {
  const name = process.env.HARDWARE_SNAPSHOT_NAME ?? "hollow-purple-hardware-v1";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error("Invalid snapshot name.");
  console.log(`Building Daytona snapshot ${name}`);
  const snapshot = await daytona().snapshot.create({
    name,
    image: Image.fromDockerfile(resolve(REPO_ROOT, "lab/Dockerfile")),
    resources: { cpu: 2, memory: 4, disk: 8 },
  }, { timeout: 900, onLogs: (chunk) => process.stdout.write(chunk) });
  console.log(`\nSnapshot ${snapshot.name}: ${snapshot.state}\nSet PROD_SNAPSHOT=${snapshot.name} in .env`);
}
void main().catch((error: unknown) => {
  const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
  const http = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : "";
  console.error(`Daytona snapshot build failed${http}. Check snapshot-create permissions and provider status. Alternatively set PROD_SNAPSHOT=daytona-medium; the lab installs its toolchain inside each sandbox.`);
  process.exitCode = 1;
});
