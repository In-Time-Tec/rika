import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { checkManifests, readWorkspaceManifests, type PolicyDiagnostic } from "./package-boundary-policy"

const formatDiagnostic = (item: PolicyDiagnostic) =>
  `${item.severity}: ${item.path}: ${item.rule}: ${item.message}. Remediation: ${item.remediation}`

const run = async () => {
  const manifests = await readWorkspaceManifests()
  const diagnostics = checkManifests(manifests)
  const waiverPath = "tooling/repository-policy/migration-waivers.json"
  const waivers = JSON.parse(await readFile(waiverPath, "utf8")) as unknown
  if (!Array.isArray(waivers)) throw new Error(`${waiverPath}: expected an array of named migration waivers`)
  const errors = diagnostics.filter((item) => item.severity === "error")
  if (errors.length > 0) throw new Error(errors.map(formatDiagnostic).join("\n"))
  process.stdout.write(
    `repository policy passed: ${manifests.length} manifests, ${diagnostics.length} diagnostics, ${waivers.length} waivers\n`,
  )
}

if (import.meta.main) {
  process.chdir(resolve(import.meta.dirname, "../../.."))
  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
