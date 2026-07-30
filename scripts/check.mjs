import {spawnSync} from "node:child_process"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  })
  if (result.error || result.status !== 0) {
    return false
  }
  return true
}

const pythonCandidates = process.platform === "win32"
  ? [["py", ["-3"]], ["python", []], ["python3", []]]
  : [["python3", []], ["python", []]]
const pythonCommand = pythonCandidates.find(([command, prefix]) =>
  run(command, [...prefix, "--version"], {capture: true}),
)

if (!pythonCommand) {
  console.error("检查失败：未找到 Python 3")
  process.exit(1)
}

const [python, prefix] = pythonCommand
if (
  !run(python, [
    ...prefix,
    "-m",
    "py_compile",
    "server.py",
    "plugins/upload-filter/plugin_filter_runtime.py",
  ])
) {
  process.exit(1)
}

for (const file of [
  "bin/git-ai-control.js",
  "scripts/check.mjs",
  "scripts/install.mjs",
  "scripts/platform-services.mjs",
  "scripts/uninstall.mjs",
  "scripts/verify-release.mjs",
]) {
  if (!run(process.execPath, ["--check", file])) {
    process.exit(1)
  }
}

if (process.platform !== "win32") {
  if (!run("/bin/sh", ["-n", "scripts/install.sh", "scripts/uninstall.sh"])) {
    process.exit(1)
  }
}
