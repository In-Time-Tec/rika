import { $ } from "bun"
import { homedir } from "node:os"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const source = `dist/release/${artifactName}`
const installDir = Bun.env.RIKA_INSTALL_DIR ?? `${homedir()}/.local/bin`
const shareDir = Bun.env.RIKA_SHARE_DIR ?? `${installDir}/../share/rika/drizzle`
const target = `${installDir}/rika${process.platform === "win32" ? ".exe" : ""}`
const tempTarget = `${target}.tmp-${process.pid}`

await $`bun run package`
await $`mkdir -p ${installDir}`
await $`cp ${source} ${tempTarget}`
await $`chmod +x ${tempTarget}`
await $`mv ${tempTarget} ${target}`
await $`rm -rf ${shareDir}`
await $`mkdir -p ${shareDir}`
await $`cp -R dist/share/rika/drizzle/. ${shareDir}`

console.log(JSON.stringify({ installed: target, migrations: shareDir, source }))
