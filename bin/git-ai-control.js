#!/usr/bin/env node

import {spawnSync} from "node:child_process"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {browserCommand} from "../scripts/platform-services.mjs"

const command = process.argv[2]
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const controlPanelUrl = "http://127.0.0.1:38742"

function printHelp() {
  console.log(`Git AI Control Panel

用法：
  git-ai-control start    安装或更新本机服务，并打开配置页面
  git-ai-control uninstall 卸载本机服务并恢复上报端点
  git-ai-control --help   显示帮助`)
}

if (command === "--help" || command === "-h" || !command) {
  printHelp()
  process.exit(0)
}

if (!["start", "uninstall"].includes(command)) {
  console.error(`未知命令：${command}`)
  printHelp()
  process.exit(1)
}

try {
  if (command === "uninstall") {
    const {uninstall} = await import("../scripts/uninstall.mjs")
    await uninstall()
    process.exit(0)
  }
  const {install} = await import("../scripts/install.mjs")
  await install()
} catch (error) {
  console.error(`${command === "start" ? "安装" : "卸载"}失败：${error.message}`)
  process.exit(1)
}

const opener = browserCommand(process.platform, controlPanelUrl)
const openResult = opener && spawnSync(opener.command, opener.args, {
  stdio: "ignore",
})
if (!openResult || openResult.error || openResult.status !== 0) {
  console.error(`服务已启动，请手动访问 ${controlPanelUrl}`)
  process.exit(0)
}

console.log(`已打开 Git AI 配置中心：${controlPanelUrl}`)
