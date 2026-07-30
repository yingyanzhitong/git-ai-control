import {spawnSync} from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {
  SERVICE_DEFINITIONS,
  gitAiBinaryCandidates,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsWrapper,
  windowsTaskCommand,
} from "./platform-services.mjs"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOCAL_ENDPOINTS = {
  enable: true,
  commit_endpoint: "http://127.0.0.1:38741/legacy/commit",
  checkpoint_endpoint: "http://127.0.0.1:38741/legacy/checkpoint",
  token_usage_endpoint: "http://127.0.0.1:38741/legacy/token-usage",
  prompt_duration_endpoint: "http://127.0.0.1:38741/prompt-duration",
  commit_endpoint_v2: "http://127.0.0.1:38741/commit",
  checkpoint_endpoint_v2: "http://127.0.0.1:38741/checkpoint",
  token_usage_endpoint_v2: "http://127.0.0.1:38741/token-usage",
  skill_usage_endpoint_v2: "http://127.0.0.1:38741/skill-usage",
  agent_usage_endpoint_v2: "http://127.0.0.1:38741/agent-usage",
  prompt_report_endpoint_v2: "http://127.0.0.1:38741/prompt-report",
}
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
const CONTROL_PANEL_STATUS_URL = "http://127.0.0.1:38742/api/status"

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  })
  if (result.error && !options.allowFailure) {
    throw new Error(`${command} 执行失败：${result.error.message}`)
  }
  if (result.status !== 0 && !options.allowFailure) {
    const details = String(result.stderr || result.stdout || "").trim()
    throw new Error(`${command} 执行失败${details ? `：${details}` : ""}`)
  }
  return result
}

function commandExists(command, args = ["--version"]) {
  const result = run(command, args, {allowFailure: true, capture: true})
  return !result.error && result.status === 0
}

function resolveExecutable(command, platform) {
  if (path.isAbsolute(command)) {
    return command
  }
  if (platform === "win32") {
    const result = run("where.exe", [command], {allowFailure: true, capture: true})
    const match = String(result.stdout || "")
      .split(/\r?\n/)
      .find(Boolean)
    return match || command
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) {
      continue
    }
    const candidate = path.join(directory, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // 继续检查 PATH 中的下一个目录。
    }
  }
  return command
}

function findPython(platform) {
  const candidates = platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]]
  for (const [command, prefix] of candidates) {
    if (commandExists(command, [...prefix, "--version"])) {
      return [resolveExecutable(command, platform), ...prefix]
    }
  }
  throw new Error("未找到 Python 3，请先安装 Python 3 并加入 PATH")
}

function isExternalHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    )
  } catch {
    return false
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback
    }
    throw error
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
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

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少安装文件：${filePath}`)
  }
}

function extractLegacyRoutes(runtimePath) {
  if (!fs.existsSync(runtimePath)) {
    return {}
  }
  const source = fs.readFileSync(runtimePath, "utf8")
  const assignment = source.match(/^\s*UPSTREAMS\s*=\s*\{([\s\S]*?)^\}/m)
  if (!assignment) {
    return {}
  }
  const routes = {}
  const entryPattern = /["']([^"']+)["']\s*:\s*["'](https?:\/\/[^"']+)["']/g
  for (const match of assignment[1].matchAll(entryPattern)) {
    if (isExternalHttpUrl(match[2])) {
      routes[match[1]] = match[2]
    }
  }
  return routes
}

function configureCustomMetrics(gitAiRoot) {
  const metricsPath = path.join(gitAiRoot, "custom_metrics.json")
  const upstreamsPath = path.join(gitAiRoot, "upstream_metrics.json")
  const installedRuntime = path.join(gitAiRoot, "filters", "plugin_filter_runtime.py")
  const config = readJson(metricsPath, {})
  let routes = {}

  if (fs.existsSync(upstreamsPath)) {
    const saved = readJson(upstreamsPath, {})
    const candidate = saved.routes ?? saved
    if (
      typeof candidate !== "object" ||
      !Object.values(candidate).some(isExternalHttpUrl)
    ) {
      throw new Error("原上报端点备份无效，已停止安装")
    }
    routes = candidate
    if (process.platform !== "win32") {
      fs.chmodSync(upstreamsPath, 0o600)
    }
  } else {
    for (const [route, key] of Object.entries(ROUTE_KEYS)) {
      if (isExternalHttpUrl(config[key])) {
        routes[route] = config[key]
      }
    }
    const tokenUrl = routes["/token-usage"]
    if (tokenUrl) {
      routes["/token-usage/batch"] = `${tokenUrl.replace(/\/+$/, "")}/batch`
      routes["/token-usage/stats"] = `${tokenUrl.replace(/\/+$/, "")}/stats`
    }
    if (Object.keys(routes).length === 0) {
      routes = extractLegacyRoutes(installedRuntime)
    }
    if (Object.keys(routes).length === 0) {
      throw new Error(
        "无法从 custom_metrics.json 识别原上报端点；为避免丢失或回环请求，已停止安装",
      )
    }
    writeJsonAtomic(upstreamsPath, {version: 1, routes})
  }

  writeJsonAtomic(metricsPath, {...config, ...LOCAL_ENDPOINTS})
}

function copyRuntime(gitAiRoot) {
  const controlPanelDir = path.join(gitAiRoot, "control-panel")
  const filterDir = path.join(gitAiRoot, "filters")
  fs.mkdirSync(controlPanelDir, {recursive: true})
  fs.mkdirSync(filterDir, {recursive: true})
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "server.py"),
    path.join(controlPanelDir, "server.py"),
  )
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "plugins", "upload-filter", "plugin_filter_runtime.py"),
    path.join(filterDir, "plugin_filter_runtime.py"),
  )
  fs.rmSync(path.join(controlPanelDir, "static"), {recursive: true, force: true})
  fs.cpSync(path.join(PROJECT_ROOT, "static"), path.join(controlPanelDir, "static"), {
    recursive: true,
  })
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(controlPanelDir, "server.py"), 0o700)
    fs.chmodSync(path.join(filterDir, "plugin_filter_runtime.py"), 0o700)
  }
}

function removeLegacyUsageDashboard(gitAiRoot, policyPath) {
  const policy = readJson(policyPath, {})
  if (policy && typeof policy === "object" && !Array.isArray(policy) && Object.hasOwn(policy, "usage_dashboard")) {
    const {usage_dashboard: _legacyUsageDashboard, ...nextPolicy} = policy
    writeJsonAtomic(policyPath, nextPolicy)
    console.log("已移除旧版本的本地用量看板配置")
  }

  const usageDataPath = path.join(gitAiRoot, "usage_dashboard.json")
  if (fs.existsSync(usageDataPath)) {
    fs.rmSync(usageDataPath)
    console.log("已删除旧版本的本地用量聚合数据")
  }
}

function writeServiceFiles(platform, gitAiRoot, pythonCommand) {
  if (platform === "darwin") {
    const directory = path.join(os.homedir(), "Library", "LaunchAgents")
    fs.mkdirSync(directory, {recursive: true})
    for (const service of SERVICE_DEFINITIONS) {
      const target = path.join(directory, `${service.macLabel}.plist`)
      fs.writeFileSync(target, renderLaunchAgent(service, gitAiRoot, pythonCommand), {
        mode: 0o600,
      })
    }
    return
  }
  if (platform === "linux") {
    const directory = path.join(os.homedir(), ".config", "systemd", "user")
    fs.mkdirSync(directory, {recursive: true})
    for (const service of SERVICE_DEFINITIONS) {
      fs.writeFileSync(
        path.join(directory, service.linuxUnit),
        renderSystemdUnit(service, gitAiRoot, pythonCommand),
      )
    }
    return
  }
  if (platform === "win32") {
    const directory = path.join(gitAiRoot, "services")
    fs.mkdirSync(directory, {recursive: true})
    for (const service of SERVICE_DEFINITIONS) {
      fs.writeFileSync(
        path.join(directory, `${service.key}.ps1`),
        renderWindowsWrapper(service, gitAiRoot, pythonCommand),
      )
    }
    return
  }
  throw new Error(`不支持当前操作系统：${platform}`)
}

function stopServices(platform) {
  if (platform === "darwin") {
    const domain = `gui/${process.getuid()}`
    for (const service of SERVICE_DEFINITIONS) {
      run("launchctl", ["bootout", `${domain}/${service.macLabel}`], {
        allowFailure: true,
        capture: true,
      })
    }
  } else if (platform === "linux") {
    for (const service of SERVICE_DEFINITIONS) {
      run("systemctl", ["--user", "stop", service.linuxUnit], {
        allowFailure: true,
        capture: true,
      })
    }
  } else if (platform === "win32") {
    for (const service of SERVICE_DEFINITIONS) {
      run("schtasks.exe", ["/End", "/TN", service.windowsTask], {
        allowFailure: true,
        capture: true,
      })
    }
  }
}

function startServices(platform, gitAiRoot) {
  if (platform === "darwin") {
    const domain = `gui/${process.getuid()}`
    for (const service of SERVICE_DEFINITIONS) {
      const plist = path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        `${service.macLabel}.plist`,
      )
      run("launchctl", ["bootstrap", domain, plist])
    }
    return
  }
  if (platform === "linux") {
    run("systemctl", ["--user", "daemon-reload"])
    for (const service of SERVICE_DEFINITIONS) {
      run("systemctl", ["--user", "enable", "--now", service.linuxUnit])
    }
    return
  }
  if (platform === "win32") {
    for (const service of SERVICE_DEFINITIONS) {
      const wrapper = path.join(gitAiRoot, "services", `${service.key}.ps1`)
      run("schtasks.exe", [
        "/Create",
        "/F",
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/TN",
        service.windowsTask,
        "/TR",
        windowsTaskCommand(wrapper),
      ])
      run("schtasks.exe", ["/Run", "/TN", service.windowsTask])
    }
    return
  }
  throw new Error(`不支持当前操作系统：${platform}`)
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(false))
    server.listen({host: "127.0.0.1", port}, () => {
      server.close(() => resolve(true))
    })
  })
}

async function waitForPortRelease(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await portIsFree(port)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`端口 ${port} 仍被占用，停止安装`)
}

async function waitForHttp(url, label) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label}启动失败：${url}`)
}

export async function controlPanelIsRunning(url = CONTROL_PANEL_STATUS_URL) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    const response = await fetch(url, {signal: controller.signal})
    if (!response.ok) {
      return false
    }
    const status = await response.json()
    return (
      status &&
      typeof status === "object" &&
      typeof status.distribution === "string" &&
      typeof status.gitAiStatus === "string"
    )
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export async function install(options = {}) {
  const platform = options.platform ?? process.platform
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`git-ai-control 不支持当前操作系统：${platform}`)
  }
  const gitAiRoot = path.resolve(
    options.gitAiRoot ?? process.env.GIT_AI_ROOT ?? path.join(os.homedir(), ".git-ai"),
  )
  const pythonCommand = options.pythonCommand ?? findPython(platform)
  const binary = gitAiBinaryCandidates(gitAiRoot, platform).find(fs.existsSync)
  if (!binary) {
    throw new Error(
      `未找到 Git AI，请确认已安装到 ${gitAiBinaryCandidates(gitAiRoot, platform).join(" 或 ")}`,
    )
  }

  for (const required of [
    "server.py",
    path.join("static", "index.html"),
    path.join("plugins", "upload-filter", "plugin_filter_runtime.py"),
    "policy.example.json",
  ]) {
    requireFile(path.join(PROJECT_ROOT, required))
  }

  const policyPath = path.join(gitAiRoot, "filter_plugins.json")
  fs.mkdirSync(path.join(gitAiRoot, "filters"), {recursive: true})
  fs.mkdirSync(path.join(gitAiRoot, "control-panel"), {recursive: true})
  if (!fs.existsSync(policyPath)) {
    fs.copyFileSync(path.join(PROJECT_ROOT, "policy.example.json"), policyPath)
    if (platform !== "win32") {
      fs.chmodSync(policyPath, 0o600)
    }
  }
  removeLegacyUsageDashboard(gitAiRoot, policyPath)

  const customMetricsSupported = fs
    .readFileSync(binary)
    .includes(Buffer.from("custom_metrics.json"))
  if (customMetricsSupported) {
    configureCustomMetrics(gitAiRoot)
    fs.writeFileSync(path.join(gitAiRoot, "control-panel", ".custom-metrics-managed"), "")
    console.log("检测到 custom_metrics 定制版：已启用细粒度上报过滤")
  } else {
    fs.rmSync(path.join(gitAiRoot, "control-panel", ".custom-metrics-managed"), {
      force: true,
    })
    console.log("检测到官方上游版：保留原生配置管理，不修改无效的 custom_metrics.json")
  }

  copyRuntime(gitAiRoot)
  run(pythonCommand[0], [
    ...pythonCommand.slice(1),
    "-m",
    "py_compile",
    path.join(gitAiRoot, "control-panel", "server.py"),
    path.join(gitAiRoot, "filters", "plugin_filter_runtime.py"),
  ])

  stopServices(platform)
  await Promise.all([waitForPortRelease(38741), waitForPortRelease(38742)])
  writeServiceFiles(platform, gitAiRoot, pythonCommand)
  startServices(platform, gitAiRoot)
  await waitForHttp("http://127.0.0.1:38741/health", "过滤服务")
  await waitForHttp(CONTROL_PANEL_STATUS_URL, "配置页面")

  console.log("安装完成：")
  console.log("  配置页面：http://127.0.0.1:38742")
  console.log("  过滤服务：http://127.0.0.1:38741/health")
  console.log(`  用户配置：${gitAiRoot}`)
  return {gitAiRoot, platform}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch((error) => {
    console.error(`安装失败：${error.message}`)
    process.exitCode = 1
  })
}
