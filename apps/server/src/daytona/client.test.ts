import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "../config.js";
import { requireHardwareSnapshot } from "./client.js";

test("hardware preflight requires an active snapshot before model calls", async () => {
  const requested: string[] = [];
  await requireHardwareSnapshot("available-image", async (name) => {
    requested.push(name);
    return { state: "active" };
  });
  assert.deepEqual(requested, ["available-image"]);
  for (const state of ["building", "inactive", "error"]) {
    await assert.rejects(requireHardwareSnapshot("image", async () => ({ state })),
      (error: unknown) => error instanceof ConfigError && /not active/.test(error.message));
  }
});

test("preflight explains missing or inaccessible snapshots without exposing provider errors", async () => {
  for (const statusCode of [404, 401, 403, 500]) {
    await assert.rejects(requireHardwareSnapshot("image", async () => {
      throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR key=SECRET_SENTINEL"), { statusCode });
    }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_ERROR|SECRET_SENTINEL/);
      if (statusCode === 404) assert.match(error.message, /unavailable.*daytona-medium/);
      if (statusCode === 401 || statusCode === 403) assert.match(error.message, /permissions/);
      return true;
    });
  }
});
