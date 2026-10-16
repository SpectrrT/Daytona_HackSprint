import { daytona } from "../daytona/client.js";

const runId = process.argv.find((arg) => arg.startsWith("--run="))?.slice(6);
const labels: Record<string, string> = { app: "hollow-purple" };
if (runId) labels.run = runId;
const items = [];
for await (const sandbox of daytona().list({ labels })) items.push(sandbox);
if (!process.argv.includes("--delete")) {
  console.log(JSON.stringify(items.map(({ id, name, state }) => ({ id, name, state })), null, 2));
  console.log("Dry run. Use --delete to remove only these Hollow Purple sandboxes, optionally --run=<id>.");
} else {
  for (const sandbox of items) { await sandbox.delete(120); console.log(`Deleted ${sandbox.name}`); }
}
