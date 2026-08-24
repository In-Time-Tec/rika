import { Effect } from "effect"
import { expect, test } from "vitest"
import { live, readText } from "../support/platform"

type Step = {
  readonly uses?: string
  readonly run?: string
  readonly if?: string
}

type Job = {
  readonly needs?: string | ReadonlyArray<string>
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
  readonly "runs-on"?: string
}

type Workflow = {
  readonly permissions?: Readonly<Record<string, string>>
  readonly jobs?: Readonly<Record<string, Job>>
}

const workflow = Bun.YAML.parse(await Effect.runPromise(live(readText(".github/workflows/publish.yml")))) as Workflow
const jobs = workflow.jobs ?? {}
const steps = (job: string) => jobs[job]?.steps ?? []
const commands = (job: string) =>
  steps(job)
    .flatMap((step) => (step.run === undefined ? [] : [step.run]))
    .join("\n")

test("packages nothing until CI is green for the commit being published", () => {
  expect(jobs.package?.needs).toBe("verify")
  expect(jobs.verify?.permissions).toEqual({ contents: "read", actions: "write" })
  const gate = commands("verify")
  const required = ((steps("verify")[0] as { readonly env?: Readonly<Record<string, string>> }).env ?? {}).REQUIRED_JOBS
  expect((required ?? "").split(" ").toSorted()).toEqual(["proc", "quality", "tui"])
  expect(gate).toContain("actions/workflows/ci.yml/runs?head_sha=$COMMIT")
  expect(gate).toContain("No ci run exists for $COMMIT")
})

test("runs every release job on Blacksmith", () => {
  for (const job of ["verify", "aggregate", "npm", "publish"])
    expect(jobs[job]?.["runs-on"], job).toMatch(/^blacksmith-/)
  expect(jobs.package?.["runs-on"]).toBe("${{ matrix.runner }}")
})

test("retries only the known-flaky lane, a bounded number of times, and logs any override", () => {
  const gate = commands("verify")
  expect(gate).toContain('[ "$blocking" = "$RETRY_JOB" ] && [ "$retries" -lt "$RETRY_LIMIT" ]')
  expect(gate).toContain('gh run rerun "$run_id" --failed --repo "$GITHUB_REPOSITORY"')
  const environment = (steps("verify")[0] as { readonly env?: Readonly<Record<string, string>> }).env ?? {}
  expect(environment.REQUIRED_JOBS).toBe("quality tui proc")
  expect(environment.RETRY_JOB).toBe("tui")
  expect(Number(environment.RETRY_LIMIT)).toBeGreaterThan(0)
  expect(Number(environment.RETRY_LIMIT)).toBeLessThanOrEqual(3)
  expect(environment.OVERRIDE).toBe("${{ inputs.skip_ci_gate }}")
  expect(gate).toContain("CI gate overridden by $GITHUB_ACTOR")
  expect(gate).toContain("$GITHUB_STEP_SUMMARY")
})

test("publishes only unchanged, attested native archives from a validated tag", () => {
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(jobs.package?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
  expect(jobs.aggregate?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
  expect(jobs.publish?.permissions).toEqual({ contents: "write" })

  expect(commands("package").match(/bun run package/g)).toHaveLength(1)
  expect(commands("package")).toContain("env -i")
  expect(commands("package")).toContain("--version")
  expect(commands("package")).toContain("--help")
  expect(commands("aggregate")).toContain("bun run package -- --aggregate")
  expect(commands("aggregate")).toContain("gh attestation verify")
  expect(commands("publish")).not.toMatch(/bun (?:install|build)|bun run package/)
  expect(commands("publish")).toContain("sha256sum --check SHA256SUMS")
  expect(commands("publish")).toContain("gh release create")
  expect(commands("publish")).toContain("gh release edit")

  const actionReferences = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
  expect(actionReferences.length).toBeGreaterThan(0)
  for (const reference of actionReferences) expect(reference).toMatch(/@[a-f0-9]{40}$/)
  expect(actionReferences.filter((reference) => reference.startsWith("actions/attest-build-provenance@"))).toHaveLength(
    2,
  )
  expect(actionReferences.some((reference) => reference.startsWith("actions/attest@"))).toBe(false)
  for (const job of ["package", "aggregate", "publish"]) expect(commands(job), job).not.toMatch(/npm (?:publish|pack)/)
})

test("retries the macOS Bun download when the setup action cannot reach its release archive", () => {
  const fallback = steps("package").find((step) => step.run?.includes("curl --fail --location --retry 5"))
  expect(fallback).toBeDefined()
  expect((fallback as { readonly if?: string }).if).toContain("steps.setup-bun.outcome == 'failure'")
  expect((fallback as { readonly if?: string }).if).toContain("runner.os == 'macOS'")
  expect(fallback?.run).toContain("packageManager.split('@')[1]")
  expect(fallback?.run).toContain("bun-darwin-aarch64.zip")
})

test("publishes npm packages built from the same attested archives", () => {
  expect(jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" })

  // The npm job must repackage the downloaded archives, never rebuild the binaries.
  expect(commands("npm")).not.toMatch(/bun run package(?! -- --aggregate)/)
  expect(commands("npm")).toContain("sha256sum --check SHA256SUMS")
  expect(commands("npm")).toContain("bun run npm-package")

  // Each platform package carries only the public executable.
  expect(commands("npm")).toContain("package/bin/rika")
  for (const privateArtifact of [
    ".rika-interactive",
    ".rika-kernel-runtime",
    ".rika-kernel-worker.js",
    "text-result.js",
    ".rika-performance",
    ".rika-server",
  ])
    expect(commands("npm")).not.toContain(`package/bin/${privateArtifact}`)

  const npmCommands = commands("npm")
  expect(npmCommands.indexOf("--dry-run")).toBeGreaterThan(-1)
  expect(npmCommands).not.toContain("--provenance")

  const publishSteps = steps("npm").filter(
    (step) => (step.run ?? "").includes("npm publish") && !(step.run ?? "").includes("--dry-run"),
  )
  expect(publishSteps).toHaveLength(2)
  for (const step of publishSteps) expect(step.if).toContain("dry_run != true")
})
