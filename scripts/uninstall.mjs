import {spawnSync} from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {SERVICE_DEFINITIONS} from "./platform-services.mjs"

const ROUTE_KEYS = {
  "/legacy/commit": "commit_endpoint",
  "/legacy/checkpoint": "checkpoint_endpoint",
  "/legacy/token-usage": "token_usage_endpoint",
  "/prompt-duration": "prompt_duration_endpoint",
  "/commit": "commit_endpoint_v2",
  "/checkpoint": "checkpoint_endpoint_v2",
  "/token-usage": "token_usage_endpoint_v2",
  "/skill-usage": "skill_usage_endpoint_v2",
  "/agent-usage": "agent_usage_endpoint_v2",
  "/prompt-report": "prompt_report_endpoint_v2",
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  })
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  )
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600})
  fs.renameSync(temporaryPath, filePath)
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o600)
  }
}

function removeServices(platform) {
  if (platform === "darwin") {
    const domain = `gui/${process.getuid()}`
    for (const service of SERVICE_DEFINITIONS) {
      run("launchctl", ["bootout", `${domain}/${service.macLabel}`])
      fs.rmSync(
        path.join(os.homedir(), "Library", "LaunchAgents", `${service.macLabel}.plist`),
        {force: true},
      )
    }
  } else if (platform === "linux") {
    for (const service of SERVICE_DEFINITIONS) {
      run("systemctl", ["--user", "disable", "--now", service.linuxUnit])
      fs.rmSync(
        path.join(os.homedir(), ".config", "systemd", "user", service.linuxUnit),
        {force: true},
      )
    }
    run("systemctl", ["--user", "daemon-reload"])
  } else if (platform === "win32") {
    for (const service of SERVICE_DEFINITIONS) {
      run("schtasks.exe", ["/End", "/TN", service.windowsTask])
      run("schtasks.exe", ["/Delete", "/F", "/TN", service.windowsTask])
    }
  } else {
    throw new Error(`git-ai-control 不支持当前操作系统：${platform}`)
  }
}

export async function uninstall(options = {}) {
  const platform = options.platform ?? process.platform
  const defaultRoot = path.resolve(path.join(os.homedir(), ".git-ai"))
  const gitAiRoot = path.resolve(
    options.gitAiRoot ?? process.env.GIT_AI_ROOT ?? defaultRoot,
  )
  if (gitAiRoot !== defaultRoot && !options.allowCustomRoot) {
    throw new Error(`拒绝卸载非默认目录：${gitAiRoot}`)
  }

  removeServices(platform)

  const controlPanelDir = path.join(gitAiRoot, "control-panel")
  const markerPath = path.join(controlPanelDir, ".custom-metrics-managed")
  const metricsPath = path.join(gitAiRoot, "custom_metrics.json")
  const upstreamsPath = path.join(gitAiRoot, "upstream_metrics.json")
  if (fs.existsSync(markerPath) && fs.existsSync(metricsPath)) {
    if (!fs.existsSync(upstreamsPath)) {
      throw new Error("缺少原上报端点备份，已停止卸载以避免留下无效配置")
    }
    const config = readJson(metricsPath)
    const saved = readJson(upstreamsPath)
    const routes = saved.routes ?? saved
    for (const [route, key] of Object.entries(ROUTE_KEYS)) {
      if (typeof routes[route] === "string" && routes[route]) {
        config[key] = routes[route]
      }
    }
    writeJsonAtomic(metricsPath, config)
  }

  fs.rmSync(path.join(gitAiRoot, "filters", "plugin_filter_runtime.py"), {
    force: true,
  })
  fs.rmSync(controlPanelDir, {recursive: true, force: true})
  fs.rmSync(path.join(gitAiRoot, "services"), {recursive: true, force: true})

  console.log("卸载完成。保留了以下用户数据：")
  console.log(`  ${path.join(gitAiRoot, "config.json")}`)
  console.log(`  ${path.join(gitAiRoot, "filter_plugins.json")}`)
  console.log(`  ${path.join(gitAiRoot, "upstream_metrics.json")}`)
  console.log(`  ${path.join(gitAiRoot, "filters")} 下的日志`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  uninstall().catch((error) => {
    console.error(`卸载失败：${error.message}`)
    process.exitCode = 1
  })
}
