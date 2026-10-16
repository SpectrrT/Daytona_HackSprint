import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const session = "antibody-demo";
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const run = args => {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? "tmux failed.");
  return result.stdout.trim();
};
if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) throw new Error("Install tmux before running the four-panel demo.");
const exists = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
if (!exists) {
  // Bind every panel to runs created after this launch; never present an archive as live.
  const since = Date.now();
  const env = `env DATA_DIR=${quote(join(root, "data"))} PATH=${quote(join(root, "data/bin") + ":" + process.env.PATH)}`;
  const main = run(["new-session", "-d", "-s", session, "-c", root, "-x", "180", "-y", "56", "-P", "-F", "#{pane_id}", `${env} ${quote(process.execPath)} ${quote(join(root, "scripts/claude.mjs"))}`]);
  const watch = role => `${env} pnpm --silent --filter @antibody/server exec tsx src/scripts/demo-panels.ts ${role} --after ${since}`;
  try {
    const blue = run(["split-window", "-v", "-p", "45", "-t", main, "-c", root, "-P", "-F", "#{pane_id}", watch("blue")]);
    const red = run(["split-window", "-h", "-p", "66", "-t", blue, "-c", root, "-P", "-F", "#{pane_id}", watch("red")]);
    const verifier = run(["split-window", "-h", "-p", "50", "-t", red, "-c", root, "-P", "-F", "#{pane_id}", watch("verifier")]);
    for (const [pane, title] of [[main, "CLAUDE | Start and follow the run"], [blue, "BLUE | Repair"], [red, "RED | Attack"], [verifier, "VERIFIER | Evidence and result"]]) run(["set-option", "-p", "-t", pane, "@demo_title", title]);
    run(["set-option", "-w", "-t", session, "pane-border-status", "top"]);
    run(["set-option", "-w", "-t", session, "pane-border-format", " #{@demo_title} "]);
    run(["set-option", "-t", session, "status", "off"]);
    run(["select-pane", "-t", main]);
  } catch (error) { run(["kill-session", "-t", session]); throw error; }
}
if (process.argv.includes("--prepare")) console.log("Demo prepared. Run pnpm demo in a full-screen Terminal window to attach.");
else {
  const args = process.env.TMUX ? ["switch-client", "-t", session] : ["attach-session", "-t", session];
  const result = spawnSync("tmux", args, { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
