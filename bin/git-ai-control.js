#!/usr/bin/env node

import {spawnSync} from "node:child_process"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {browserCommand} from "../scripts/platform-services.mjs"
import {controlPanelIsRunning} from "../scripts/install.mjs"

const command = process.argv[2]
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const controlPanelUrl = "http://127.0.0.1:38742"

function printHelp() {
  console.log(`Git AI Control Panel

用法：
  git-ai-control          首次安装服务；已运行时复用现有进程并打开配置页面
  git-ai-control uninstall 卸载本机服务并恢复上报端点
  git-ai-control --help   显示帮助`)
}

if (command === "--help" || command === "-h") {
  printHelp()
  process.exit(0)
}

if (command && command !== "uninstall") {
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
  const reused = await controlPanelIsRunning()
  if (!reused) {
    const {install} = await import("../scripts/install.mjs")
    await install()
  } else {
    console.log("检测到已运行的 Git AI 配置中心，复用现有进程")
  }
} catch (error) {
  console.error(`${command === "uninstall" ? "卸载" : "启动"}失败：${error.message}`)
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
