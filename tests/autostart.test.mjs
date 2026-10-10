import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {ensureAutoStart} from "../scripts/install.mjs"
import {SERVICE_DEFINITIONS, renderLaunchAgent} from "../scripts/platform-services.mjs"

function fixture(t, platform, response) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "git-ai-autostart-"))
  t.after(() => fs.rmSync(home, {recursive: true, force: true}))
  const calls = []
  return {
    calls,
    options: {
      platform, home, uid: 123, gitAiRoot: path.join(home, ".git-ai"),
      pythonCommand: ["/usr/bin/python3"],
      run(command, args, options) {
        calls.push([command, args])
        return options?.allowFailure ? response(command, args) : {status: 0, stdout: ""}
      },
    },
  }
}

test("macOS 补齐缺失启动项，再次执行不修改或重载已运行服务", (t) => {
  let loaded = false
  const {options, calls} = fixture(t, "darwin", (_command, args) => ({
    status: args[0] === "print" && !loaded ? 1 : 0, stdout: "",
  }))
  assert.equal(ensureAutoStart(options), true)
  assert.equal(calls.filter(([, args]) => args[0] === "bootstrap").length, 2)
  for (const service of SERVICE_DEFINITIONS) {
    assert.match(fs.readFileSync(path.join(options.home, "Library", "LaunchAgents", `${service.macLabel}.plist`), "utf8"), /<key>RunAtLoad<\/key>\s*<true\/>/)
  }
  loaded = true
  calls.length = 0
  assert.equal(ensureAutoStart(options), false)
  assert.ok(calls.every(([, args]) => ["print-disabled", "print"].includes(args[0])))
})

for (const state of ["true", "disabled"]) {
  test(`macOS 自动重新启用被禁用的服务（${state}）`, (t) => {
    const {options, calls} = fixture(t, "darwin", () => ({
      status: 0, stdout: `"com.git-ai.control-panel" => ${state}`,
    }))
    const directory = path.join(options.home, "Library", "LaunchAgents")
    fs.mkdirSync(directory, {recursive: true})
    for (const service of SERVICE_DEFINITIONS) {
      fs.writeFileSync(path.join(directory, `${service.macLabel}.plist`), renderLaunchAgent(service, options.gitAiRoot, options.pythonCommand))
    }
    assert.equal(ensureAutoStart(options), true)
    assert.deepEqual(calls.filter(([, args]) => args[0] === "enable"), [
      ["launchctl", ["enable", "gui/123/com.git-ai.control-panel"]],
    ])
    assert.ok(!calls.some(([, args]) => args[0] === "bootstrap"))
  })
}

test("macOS 查询失败时报告错误", (t) => {
  const {options} = fixture(t, "darwin", () => ({status: 1, stdout: ""}))
  assert.throws(() => ensureAutoStart(options), /无法检查 macOS 自动启动状态/)
})

test("Linux 补齐 unit 并启用，重复执行不重载或重启服务", (t) => {
  let enabled = false
  const {options, calls} = fixture(t, "linux", () => ({status: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n"}))
  assert.equal(ensureAutoStart(options), true)
  assert.equal(calls.filter(([, args]) => args.includes("enable")).length, 2)
  assert.ok(!calls.some(([, args]) => args.includes("--now") || args.includes("restart")))
  enabled = true
  calls.length = 0
  assert.equal(ensureAutoStart(options), false)
  assert.ok(calls.every(([, args]) => args.includes("is-enabled")))
})

for (const xml of ["", "<Task><LogonTrigger/><Enabled>false</Enabled></Task>", "<Task><TimeTrigger/></Task>"]) {
  test(`Windows 修复缺失、禁用或非登录任务：${xml || "缺失"}`, (t) => {
    const {options, calls} = fixture(t, "win32", () => ({status: xml ? 0 : 1, stdout: xml}))
    assert.equal(ensureAutoStart(options), true)
    assert.equal(calls.filter(([, args]) => args.includes("/Create") && args.includes("ONLOGON")).length, 2)
    calls.length = 0
    options.run = (_command, args) => {
      calls.push(args)
      return {status: 0, stdout: "<Task><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Task>"}
    }
    assert.equal(ensureAutoStart(options), false)
    assert.ok(calls.every((args) => args.includes("/Query")))
  })
}
