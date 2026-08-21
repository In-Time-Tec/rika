import { expect, test } from "vitest"

type Step = {
  readonly uses?: string
  readonly run?: string
  readonly with?: Readonly<Record<string, unknown>>
  readonly if?: string
  readonly id?: string
  readonly "continue-on-error"?: boolean
}
type Job = {
  readonly if?: string
  readonly needs?: string
  readonly environment?: string
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
}
type Workflow = { readonly jobs?: Readonly<Record<string, Job>> }

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/executor-image.yml").text()) as Workflow
const jobs = workflow.jobs ?? {}
const steps = (job: string) => jobs[job]?.steps ?? []
const commands = (job: string) =>
  steps(job)
    .flatMap((step) => (step.run === undefined ? [] : [step.run]))
    .join("\n")

test("builds and scans the digest-pinned executor image and retains its SBOM", () => {
  const build = commands("build")
  expect(build).toContain("infra/e2b/executor-v1/e2b.Dockerfile")
  expect(build).toContain("docker manifest inspect")
  expect(build).toContain("docker push")
  expect(build).toContain("RepoDigests")
  expect(steps("build").find((step) => step.run?.includes("visibility=public"))?.if).toBe("inputs.promote == true")

  const sbom = steps("build").find((step) => step.uses?.startsWith("anchore/sbom-action@"))
  const scan = steps("build").find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"))
  expect(sbom?.with?.image).toContain("@${{ env.digest }}")
  expect(scan?.with?.["image-ref"]).toContain("@${{ env.digest }}")
  expect(scan?.with?.["exit-code"]).toBe(1)
  expect(scan?.["continue-on-error"]).toBe(true)
  expect(steps("build").find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.path).toContain(
    "executor-sbom.spdx.json",
  )
  expect(commands("build")).toContain('test "${{ steps.scan.outcome }}" = success')
})

test("attests the exact manifest and the build identity", () => {
  expect(jobs.build?.permissions).toEqual({
    contents: "read",
    packages: "write",
    "id-token": "write",
    attestations: "write",
  })
  const attestations = steps("build").filter((step) => step.uses?.startsWith("actions/attest-build-provenance@"))
  expect(attestations).toHaveLength(2)
  expect(attestations[0]?.with).toMatchObject({
    "subject-name": "${{ env.IMAGE }}",
    "subject-digest": "${{ env.digest }}",
    "push-to-registry": true,
  })
  expect(attestations[1]?.with?.["subject-path"]).toBe("executor-build.json")
  expect(commands("build")).toContain("sourceCommit:$source")
  expect(commands("build")).toContain("imageDigest:$digest")
})

test("promotion is an explicit approved new E2B generation", () => {
  expect(jobs.promote?.if).toBe("inputs.promote == true")
  expect(jobs.promote?.needs).toBe("build")
  expect(jobs.promote?.environment).toBe("executor-production")
  expect(commands("promote")).toContain("FROM ghcr.io/${{ github.repository_owner }}/rika-executor@%s")
  expect(commands("promote")).toContain("@e2b/cli@2.16.2 template create rika-executor-v1")
  expect(commands("promote")).toContain("--dockerfile e2b-promoted.Dockerfile")
  expect(commands("promote")).toContain("template list --format json")
  expect(commands("promote")).toContain('.aliases | index("rika-executor-v1")')
  expect(commands("promote")).toContain('bun run packages/e2b-executor/scripts/image-smoke.ts "$build_id"')
  expect(commands("promote")).toContain("e2bBuildId:$buildId")
  expect(commands("promote")).toContain("generation:($generation|tonumber)")
  expect(steps("promote").find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with?.path).toContain(
    "executor-smoke.json",
  )
})

test("pins every workflow action to a commit", () => {
  const references = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  )
  expect(references.length).toBeGreaterThan(0)
  for (const reference of references) expect(reference).toMatch(/@[a-f0-9]{40}$/)
})
