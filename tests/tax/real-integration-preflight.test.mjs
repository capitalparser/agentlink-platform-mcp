import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(directory));
const integrationTest = join(directory, "real-integration.test.mjs");

function runRequiredIntegration(scratch) {
  const registry = join(scratch, "source-registry.json");
  const marker = join(scratch, "python-started.txt");
  const python = join(scratch, "fake-python");
  const upperEntry = join(scratch, "fake-upper.js");
  writeFileSync(registry, "{}\n", "utf8");
  writeFileSync(python,
    `#!/bin/sh\nprintf 'not-json\\n'\nprintf '%s' "$AGENTLINK_TAX_REGISTRY" > '${marker}'\n`, "utf8");
  chmodSync(python, 0o755);
  writeFileSync(upperEntry, "console.log('not-json');\nprocess.exit(0);\n", "utf8");

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_TEST_TAX_PYTHON: python,
    AGENTLINK_TEST_TAX_REGISTRY: registry,
    AGENTLINK_TEST_UPPER_ENTRY: upperEntry,
  };
  env.AGENTLINK_REQUIRE_TAX_INTEGRATION = "1";
  const result = spawnSync(process.execPath, ["--test", integrationTest], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
  return { result, registry, marker };
}

test("required installed integration rejects a registry override before starting Python", () => {
  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-required-preflight-"));
  try {
    const { result, marker } = runRequiredIntegration(scratch);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.error?.code === "ETIMEDOUT") {
      assert.equal(existsSync(marker), false,
        "required mode must reject before spawning the Python child");
    }
    assert.equal(result.error, undefined, `integration preflight did not exit promptly: ${result.error}`);
    assert.notEqual(result.status, 0, "required mode must reject an explicit registry override");
    assert.match(output, /AGENTLINK_REQUIRE_TAX_INTEGRATION=1 forbids AGENTLINK_TEST_TAX_REGISTRY/);
    assert.equal(existsSync(marker), false, "the child Python command must not start before the rejection");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
