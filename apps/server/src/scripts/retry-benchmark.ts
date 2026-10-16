import { runRetryBenchmark } from "../benchmarks/retries.js";
const index = process.argv.indexOf("--repeats");
const result = await runRetryBenchmark(index >= 0 ? Number(process.argv[index + 1]) : 3);
if (result.status !== "completed") process.exitCode = 1;
