import { expect, test } from "vitest"

type Step = {
  readonly uses?: string
  readonly run?: string
}

type Job = {
  readonly needs?: string | ReadonlyArray<string>
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
}

type Workflow = {
  readonly permissions?: Readonly<Record<string, string>>
  readonly jobs?: Readonly<Record<string, Job>>
}

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/publish.yml").text()) as Workflow
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

test("retries only the known-flaky lane, a bounded number of times, and logs any override", () => {
  const gate = commands("verify")
  expect(gate).toContain('[ "$blocking" = "$RETRY_JOB" ] && [ "$retries" -lt "$RETRY_LIMIT" ]')
  expect(gate).toContain("gh run rerun")
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
  expect(commands("package")).toContain("bun run release-smoke")
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

test("publishes npm packages built from the same attested archives", () => {
  expect(jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" })

  // The npm job must repackage the downloaded archives, never rebuild the binaries.
  expect(commands("npm")).not.toMatch(/bun run package(?! -- --aggregate)/)
  expect(commands("npm")).toContain("sha256sum --check SHA256SUMS")
  expect(commands("npm")).toContain("bun run npm-package")

  // Both binaries must be present in every platform package.
  expect(commands("npm")).toContain("package/bin/rika")
  expect(commands("npm")).toContain("package/bin/.rika-performance")
  expect(commands("npm")).toContain("package/bin/.rika-runtime")

  const npmCommands = commands("npm")
  expect(npmCommands.indexOf("--dry-run")).toBeGreaterThan(-1)
  expect(npmCommands.indexOf("--dry-run")).toBeLessThan(npmCommands.indexOf("--provenance"))

  const publishSteps = steps("npm").filter((step) => (step.run ?? "").includes("npm publish"))
  const guarded = publishSteps.filter((step) => (step.run ?? "").includes("--provenance"))
  expect(guarded.length).toBe(2)
  for (const step of guarded) expect((step as { readonly if?: string }).if).toContain("dry_run != true")
})
