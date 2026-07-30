import fs from "node:fs"

const tag = process.argv[2]
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)
const expectedTag = `v${packageJson.version}`

if (!tag) {
  console.error("缺少版本标签")
  process.exit(1)
}

if (tag !== expectedTag) {
  console.error(`版本标签 ${tag} 与 package.json ${packageJson.version} 不一致`)
  process.exit(1)
}

console.log(`发布版本校验通过：${packageJson.name}@${packageJson.version}`)
