import { resolve } from "node:path";
import { Image } from "@daytona/sdk";
import { REPO_ROOT } from "../config.js";
import { daytona } from "../daytona/client.js";

const name = process.env.HARDWARE_SNAPSHOT_NAME ?? "hollow-purple-hardware-v1";
console.log(`Building Daytona snapshot ${name}`);
const snapshot = await daytona().snapshot.create({
  name,
  image: Image.fromDockerfile(resolve(REPO_ROOT, "lab/Dockerfile")),
  resources: { cpu: 2, memory: 4, disk: 8 },
}, { timeout: 900, onLogs: (chunk) => process.stdout.write(chunk) });
console.log(`\nSnapshot ${snapshot.name}: ${snapshot.state}\nSet PROD_SNAPSHOT=${snapshot.name} in .env`);
