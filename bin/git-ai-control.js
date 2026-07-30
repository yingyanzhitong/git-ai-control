#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const command = process.argv[2]
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const controlPanelUrl = "http://127.0.0.1:38742"

function printHelp() {
  console.log(`Git AI Control Panel

用法：
  git-ai-control start    安装或更新本机服务，并打开配置页面
  git-ai-control --help   显示帮助`)
}

if (command === "--help" || command === "-h" || !command) {
  printHelp()
  process.exit(0)
}

if (command !== "start") {
  console.error(`未知命令：${command}`)
  printHelp()
  process.exit(1)
}

if (process.platform !== "darwin") {
  console.error("git-ai-control 目前仅支持 macOS")
  process.exit(1)
}

const installResult = spawnSync("/bin/sh", [path.join(packageRoot, "scripts/install.sh")], {
  cwd: packageRoot,
  env: process.env,
  stdio: "inherit",
})

if (installResult.error) {
  console.error(`安装失败：${installResult.error.message}`)
  process.exit(1)
}
if (installResult.status !== 0) {
  process.exit(installResult.status ?? 1)
}

const openResult = spawnSync("/usr/bin/open", [controlPanelUrl], {
  stdio: "ignore",
})
if (openResult.error || openResult.status !== 0) {
  console.error(`服务已启动，请手动访问 ${controlPanelUrl}`)
  process.exit(1)
}

console.log(`已打开 Git AI 配置中心：${controlPanelUrl}`)
