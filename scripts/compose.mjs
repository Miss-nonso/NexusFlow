import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
let context = [];
if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  if (
    spawnSync("docker", ["--context", "default", "info"], { stdio: "ignore" })
      .status !== 0
  ) {
    console.error("Start Docker Engine or Docker Desktop, then retry.");
    process.exit(1);
  }
  context = ["--context", "default"];
}
const args = process.argv.slice(2);
const setup = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./setup.mjs", import.meta.url))],
  { cwd, stdio: "inherit" },
);
if (setup.status !== 0) process.exit(setup.status || 1);
const result = spawnSync("docker", [...context, "compose", ...args], {
  cwd,
  stdio: "inherit",
});
process.exit(result.status || 0);
