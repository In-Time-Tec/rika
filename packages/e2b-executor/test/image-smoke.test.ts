import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem } from "effect"
import { testing } from "../scripts/image-smoke"

const doctorSource = Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
  fileSystem.readFileString(new URL("../../../infra/e2b/executor-v1/doctor.ts", import.meta.url).pathname),
)
const manifest = { tools: [{ name: "bun" }], aptPackages: [{ name: "git" }] }
const checks = [...testing.requiredChecks, "tool:bun", "package:git"].map((name) => ({
  name,
  ok: true,
  detail: "ok",
}))
const result = {
  ok: true,
  image: "rika-executor-v1" as const,
  manifestSchemaVersion: 1 as const,
  buildId: "build-1",
  manifestSha256: "abc",
  manifestToolCount: 1,
  manifestPackageCount: 1,
  checks,
}

describe("image smoke doctor contract", () => {
  it.layer(BunServices.layer)((test) => {
    test("requires only checks the executor doctor emits", () =>
      Effect.gen(function* () {
        const source = yield* doctorSource
        for (const name of testing.requiredChecks) {
          expect(source, `doctor.ts must emit check "${name}"`).toContain(`"${name}"`)
        }
      }))
  })

  it("accepts a matching doctor result", () => {
    expect(testing.doctorContractViolations(result, "build-1", "abc", manifest)).toEqual([])
  })

  it("names every violated expectation", () => {
    const stale = {
      ...result,
      ok: false,
      buildId: "build-2",
      checks: [
        ...checks.filter(({ name }) => name !== "process:workspace-user" && name !== "package:git"),
        { name: "network:outbound", ok: false, detail: "dns failed" },
      ],
    }
    expect(testing.doctorContractViolations(stale, "build-1", "abc", manifest)).toEqual([
      "network:outbound: dns failed",
      "doctor reported ok=false",
      "buildId build-2 is not build-1",
      "doctor check names are not unique",
      "missing checks: process:workspace-user, package:git",
    ])
  })
})
