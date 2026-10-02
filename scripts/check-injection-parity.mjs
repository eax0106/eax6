import { spawnSync } from "node:child_process";

const result = spawnSync("uv", ["run", "--frozen", "pytest", "-q", "tests/test_injection_parity.py"], {
  cwd: "apps/verification-service", env: { ...process.env }, stdio: "inherit", timeout: 120_000,
});
if (result.error || result.status !== 0) process.exit(result.status || 1);
console.log("injection-parity-passed");
