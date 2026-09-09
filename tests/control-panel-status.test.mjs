import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {createServer} from "node:http"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  controlPanelIsRunning,
  controlPanelNeedsUpdate,
  controlPanelStatus,
} from "../scripts/install.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

test("仅复用可识别的配置中心服务", async (t) => {
  const server = createServer((request, response) => {
    const payload = request.url === "/api/status"
      ? {distribution: "custom-metrics", gitAiStatus: "enabled"}
      : {ok: true}
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(payload))
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  assert.equal(
    await controlPanelIsRunning(`http://127.0.0.1:${port}/api/status`),
    true,
  )
  assert.deepEqual(
    await controlPanelStatus(`http://127.0.0.1:${port}/api/status`),
    {distribution: "custom-metrics", gitAiStatus: "enabled"},
  )
  assert.equal(await controlPanelIsRunning(`http://127.0.0.1:${port}/other`), false)
})

test("仅在可用版本高于已安装版本时升级", () => {
  assert.equal(controlPanelNeedsUpdate(undefined, "0.4.14"), true)
  assert.equal(controlPanelNeedsUpdate("0.4.13", "0.4.14"), true)
  assert.equal(controlPanelNeedsUpdate("0.4.14", "0.4.14"), false)
  assert.equal(controlPanelNeedsUpdate("0.4.15", "0.4.14"), false)
  assert.equal(controlPanelNeedsUpdate("0.5.0", "0.4.14"), false)
})

test("不再支持 start 子命令", () => {
  const result = spawnSync(process.execPath, ["bin/git-ai-control.js", "start"], {
    cwd: projectRoot,
    encoding: "utf8",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知命令：start/)
})
