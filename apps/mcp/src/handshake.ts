import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Launches the server exactly as .mcp.json does and exercises the read-only tools.
const transport = new StdioClientTransport({ command: "pnpm", args: ["--silent", "--dir", "apps/mcp", "start"], cwd: process.argv[2] ?? process.cwd(), stderr: "inherit" });
const client = new Client({ name: "handshake", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
console.log("\n# lab_status\n" + text(await client.callTool({ name: "lab_status", arguments: {} })).slice(0, 600));
console.log("\n# agent_lab_status\n" + text(await client.callTool({ name: "agent_lab_status", arguments: {} })).slice(0, 1200));
const agentRunId = process.argv[3] === "--agent" ? process.argv[4] : undefined;
if (agentRunId) {
  for (const name of ["watch_agent_run", "get_agent_failures", "get_agent_repair", "get_agent_result"]) {
    const result = await client.callTool({ name, arguments: { run_id: agentRunId, ...(name === "watch_agent_run" ? { wait_seconds: 0 } : {}) } });
    if (result.isError) throw new Error(text(result));
    console.log(`\n# ${name}\n${text(result).slice(0, 1800)}`);
  }
}
const runId = agentRunId ? undefined : process.argv[3];
if (runId) {
  console.log("\n# watch_run (wait 0)\n" + text(await client.callTool({ name: "watch_run", arguments: { run_id: runId, wait_seconds: 0 } })).slice(0, 2600));
  console.log("\n# get_run\n" + text(await client.callTool({ name: "get_run", arguments: { run_id: runId } })).slice(0, 900));
}
await client.close();
