import { expect, test } from "vitest"

type Step = {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, unknown>>
  readonly if?: string
  readonly id?: string
}
type Job = {
  readonly if?: string
  readonly needs?: string
  readonly environment?: string
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
}
type Workflow = {
  readonly concurrency?: Readonly<Record<string, unknown>>
  readonly jobs?: Readonly<Record<string, Job>>
}

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/executor-image.yml").text()) as Workflow
const jobs = workflow.jobs ?? {}
const steps = (job: string) => jobs[job]?.steps ?? []
const commands = (job: string) =>
  steps(job)
    .flatMap((step) => (step.run === undefined ? [] : [step.run]))
    .join("\n")
const named = (job: string, name: string) => steps(job).find((step) => step.name === name)
const position = (job: string, name: string) => steps(job).findIndex((step) => step.name === name)

test("builds one deterministic OCI candidate and canonical SPDX SBOM without registry authority", () => {
  expect(jobs.review?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
  const review = commands("review")
  expect(review).toContain("sha256sum infra/e2b/executor-v1/tool-manifest.json")
  expect(review).toContain("git show --no-patch --format=%ct")
  expect(review).toContain('if [ "${{ inputs.promote }}" = true ]; then test "$GITHUB_REF" = refs/heads/main; fi')
  expect(review).toContain("docker buildx build")
  expect(review).toContain("--platform linux/amd64")
  expect(review).toContain("type=oci,dest=executor-image.oci.tar,rewrite-timestamp=true")
  expect(review).not.toContain("BUILDKIT_MULTI_PLATFORM")
  expect(review).toContain("dev.rika.executor.manifest.sha256=$MANIFEST_SHA256")
  expect(review).not.toContain("docker push")
  expect(review).not.toContain("docker login")

  const buildx = named("review", "Set up Docker Buildx")
  expect(buildx?.uses).toBe("docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e")
  expect(position("review", "Set up Docker Buildx")).toBeLessThan(
    position("review", "Build deterministic OCI candidate"),
  )

  const sbom = steps("review").find((step) => step.uses?.startsWith("anchore/sbom-action@"))
  expect(sbom?.with).toMatchObject({
    image: "oci-archive:executor-image.oci.tar",
    format: "spdx-json",
    "syft-version": "v1.33.0",
    "upload-artifact": false,
  })
  expect(review).toContain(".creationInfo.created = $created")
  expect(review).toContain(".documentNamespace = $namespace")
  expect(review).toContain("jq -S -c")
  expect(review).toContain('namespace="https://github.com/$GITHUB_REPOSITORY/sbom/${digest#sha256:}"')

  const evidence = named("review", "Upload retained review evidence")
  expect(evidence?.with?.path).toContain("executor-sbom.spdx.json")
  expect(evidence?.with?.path).toContain("executor-vulnerability-scan.json")
  expect(evidence?.with?.["retention-days"]).toBe(90)
})

test("retains a complete vulnerability report and blocks every fixable HIGH or CRITICAL finding", () => {
  const scan = steps("review").find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"))
  expect(scan?.uses).toBe("aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25")
  expect(scan?.with).toMatchObject({
    version: "v0.70.0",
    "scan-type": "image",
    input: "executor-image.oci.tar",
    scanners: "vuln",
    "vuln-type": "os,library",
    format: "json",
    output: "executor-vulnerability-scan.json",
    severity: "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    "ignore-unfixed": false,
    "exit-code": 0,
  })
  expect(commands("review")).toContain('scanner:"trivy-v0.70.0"')
  const gate = named("review", "Enforce vulnerability policy")?.run ?? ""
  expect(gate).toContain('.Severity == "HIGH" or .Severity == "CRITICAL"')
  expect(gate).toContain('(.FixedVersion // "") != ""')
  expect(gate).toContain('test "$blocking" -eq 0')
  expect(position("review", "Enforce vulnerability policy")).toBeLessThan(
    position("review", "Upload private promotion handoff"),
  )
})

test("binds source, manifest, SBOM, scan, and image digests into signed provenance", () => {
  const review = commands("review")
  expect(review).toContain("sourceCommit:$sourceCommit")
  expect(review).toContain("imageDigest:$imageDigest")
  expect(review).toContain("manifest:{path:")
  expect(review).toContain("sbom:{path:")
  expect(review).toContain("vulnerabilityScan:{path:")
  expect(named("review", "Attest review build record")?.with?.["subject-path"]).toBe("executor-build.json")

  const provenance = named("promote", "Attest exact image provenance")
  expect(provenance?.with).toMatchObject({
    "subject-name": "${{ env.IMAGE }}",
    "subject-digest": "${{ env.digest }}",
    "push-to-registry": true,
  })
  const identity = named("promote", "Attest executor build identity")
  expect(identity?.with).toMatchObject({
    "subject-name": "${{ env.IMAGE }}",
    "subject-digest": "${{ env.digest }}",
    "predicate-path": "executor-build.json",
    "push-to-registry": true,
  })
  expect(String(identity?.with?.["predicate-type"])).toContain("/attestations/executor-image/v1")
})

test("cannot publish or promote a mutable, reused, unreviewed, or unattested image", () => {
  expect(workflow.concurrency).toEqual({
    group: "executor-image-g${{ inputs.generation }}",
    "cancel-in-progress": false,
  })
  expect(jobs.promote?.if).toBe("inputs.promote == true")
  expect(jobs.promote?.needs).toBe("review")
  expect(jobs.promote?.environment).toBe("executor-production")
  expect(jobs.promote?.permissions).toMatchObject({ packages: "write", "id-token": "write", attestations: "write" })

  const credentials = named("promote", "Require promotion credentials")
  expect(credentials?.env).toEqual({ E2B_API_KEY: "${{ secrets.E2B_API_KEY }}" })
  expect(credentials?.run).toContain('test -n "$E2B_API_KEY"')
  expect(position("promote", "Require promotion credentials")).toBeLessThan(
    position("promote", "Require a fresh generation package"),
  )
  expect(position("promote", "Verify approved review evidence")).toBeLessThan(
    position("promote", "Require a fresh generation package"),
  )
  expect(position("promote", "Require a fresh generation package")).toBeLessThan(
    position("promote", "Authenticate to GHCR"),
  )
  expect(position("promote", "Authenticate to GHCR")).toBeLessThan(
    position("promote", "Upload immutable digest without a tag"),
  )
  expect(position("promote", "Upload immutable digest without a tag")).toBeLessThan(
    position("promote", "Attest exact image provenance"),
  )
  expect(position("promote", "Attest executor build identity")).toBeLessThan(
    position("promote", "Verify image attestations before publication"),
  )
  expect(position("promote", "Verify image attestations before publication")).toBeLessThan(
    position("promote", "Publish attested generation for E2B"),
  )
  expect(position("promote", "Publish attested generation for E2B")).toBeLessThan(
    position("promote", "Create and smoke immutable E2B build"),
  )

  const promote = commands("promote")
  expect(promote).toContain("rika-executor-g${{ inputs.generation }}")
  expect(promote).toContain('"docker://$IMAGE@$digest"')
  expect(promote).toContain("copy --preserve-digests")
  expect(promote).not.toContain("docker push")
  expect(promote).not.toMatch(/\$IMAGE:[^/]/)
  expect(promote).toContain('subject="oci://$IMAGE@$digest"')
  expect(promote).toContain('template_alias="rika-executor-v1-g${{ inputs.generation }}"')
  expect(promote).not.toContain("template list")
  expect(promote).toContain("Template created with ID: \\([^,]*\\), Build ID:")
  expect(promote).toContain(
    'bun run packages/e2b-executor/scripts/image-smoke.ts "$template_id" "$build_id" "$MANIFEST_SHA256"',
  )
})

test("pins every workflow action to a commit", () => {
  const references = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  )
  expect(references.length).toBeGreaterThan(0)
  for (const reference of references) expect(reference).toMatch(/@[a-f0-9]{40}$/)
})
