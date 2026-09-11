import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

interface EngineCli {
  getEnginePath(): string
}

// The engine-cli package is a direct dependency inside the infra/rivet image and a rivetkit
// transitive dependency inside the repository workspace.
const loadEngineCli = (): EngineCli => {
  const localRequire = createRequire(import.meta.url)
  try {
    // SAFETY: the published CommonJS package exports exactly getEnginePath; the shape is pinned by
    // infra/rivet/package.json and exercised by the API's test fixtures.
    return localRequire("@rivetkit/engine-cli") as EngineCli
  } catch {
    const fromApi = createRequire(join(import.meta.dir, "../../apps/api/package.json"))
    const throughRivetkit = createRequire(fromApi.resolve("rivetkit"))
    // SAFETY: same published CommonJS export resolved through the rivetkit dependency boundary.
    return throughRivetkit("@rivetkit/engine-cli") as EngineCli
  }
}

const { getEnginePath } = loadEngineCli()

const guardHost = process.env.RIVET__GUARD__HOST ?? "::"
const guardPort = Number(process.env.RIVET__GUARD__PORT ?? "6420")
const peerHost = process.env.RIVET__API_PEER__HOST ?? "::"
const peerPort = Number(process.env.RIVET__API_PEER__PORT ?? "6421")
const metricsHost = process.env.RIVET__METRICS__HOST ?? "127.0.0.1"
const metricsPort = Number(process.env.RIVET__METRICS__PORT ?? "6422")
const publicUrl = process.env.RIVET_PUBLIC_URL ?? `http://[::1]:${guardPort}`
const dataPath = process.env.RIVET__FILE_SYSTEM__PATH ?? join(tmpdir(), "rivet-engine-data")

const directory = mkdtempSync(join(tmpdir(), "rika-rivet-engine-"))
const config = join(directory, "rivet.json")
writeFileSync(
  config,
  JSON.stringify({
    topology: {
      datacenter_label: 1,
      datacenters: {
        default: {
          datacenter_label: 1,
          is_leader: true,
          public_url: publicUrl,
          peer_url: publicUrl.replace(String(guardPort), String(peerPort)),
        },
      },
    },
  }),
)

const child = spawn(getEnginePath(), ["--config", config, "start"], {
  env: {
    ...process.env,
    RIVET__FILE_SYSTEM__PATH: dataPath,
    RIVET__GUARD__HOST: guardHost,
    RIVET__GUARD__PORT: String(guardPort),
    RIVET__API_PEER__HOST: peerHost,
    RIVET__API_PEER__PORT: String(peerPort),
    RIVET__METRICS__HOST: metricsHost,
    RIVET__METRICS__PORT: String(metricsPort),
    RIVET__TELEMETRY__ENABLED: "false",
    RIVET__FEATURES__GUARD_GATEWAY_V3__MODE: "on",
    RIVET__FEATURES__GUARD_GATEWAY_V3__PERCENTAGE: "100",
    RIVET__PEGBOARD__ENVOY_ELIGIBLE_THRESHOLD: "5000",
    RIVET__PEGBOARD__ENVOY_LOST_THRESHOLD: "7000",
    RIVET__PEGBOARD__RUNNER_ELIGIBLE_THRESHOLD: "5000",
    RIVET__PEGBOARD__RUNNER_LOST_THRESHOLD: "7000",
    RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "2",
    RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
    RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
  },
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    child.kill(signal)
  })

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === "SIGTERM" ? 0 : 1))
})
