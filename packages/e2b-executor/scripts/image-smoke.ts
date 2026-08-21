import { Sandbox } from "e2b"

const buildId = process.argv[2]
if (buildId === undefined || buildId.length === 0) throw new Error("E2B template build ID is required")

const sandbox = await Sandbox.create(`rika-executor-v1:${buildId}`, {
  timeoutMs: 300_000,
  secure: true,
  allowInternetAccess: true,
  envs: {
    RIKA_EXECUTOR_TEMPLATE_BUILD_ID: buildId,
    RIKA_DOCTOR_NETWORK_URL: "https://example.com/",
  },
})

try {
  const command = await sandbox.commands.run("rika executor doctor --json", { timeoutMs: 180_000 })
  const result = JSON.parse(command.stdout) as {
    readonly ok?: boolean
    readonly buildId?: string
    readonly manifestSha256?: string
    readonly checks?: ReadonlyArray<{ readonly ok?: boolean }>
  }
  if (
    result.ok !== true ||
    result.buildId !== buildId ||
    typeof result.manifestSha256 !== "string" ||
    result.checks === undefined ||
    result.checks.some((check) => check.ok !== true)
  )
    throw new Error("Promoted E2B image failed its doctor contract")
  await Bun.write(
    "executor-smoke.json",
    `${JSON.stringify({ ...result, sandboxId: sandbox.sandboxId }, null, 2)}\n`,
  )
} finally {
  await sandbox.kill()
}
