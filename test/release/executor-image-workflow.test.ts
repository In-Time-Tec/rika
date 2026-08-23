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
  readonly needs?: string | ReadonlyArray<string>
  readonly environment?: string
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
  readonly "runs-on"?: string
}
type Workflow = {
  readonly on?: {
    readonly workflow_dispatch?: {
      readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
  }
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

test("runs every executor image job on Blacksmith", () => {
  for (const job of ["review", "publish", "resume", "template"])
    expect(jobs[job]?.["runs-on"], job).toMatch(/^blacksmith-/)
})

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
  const extraction = named("review", "Extract OCI candidate for vulnerability scan")
  expect(extraction?.run).toContain("tar -xf executor-image.oci.tar -C executor-image.oci")
  expect(extraction?.run).toContain("executor-image.oci/index.json")
  expect(position("review", "Extract OCI candidate for vulnerability scan")).toBeLessThan(
    position("review", "Scan candidate vulnerabilities"),
  )

  const scan = steps("review").find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"))
  expect(scan?.uses).toBe("aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25")
  expect(scan?.with).toMatchObject({
    version: "v0.70.0",
    "scan-type": "image",
    input: "executor-image.oci",
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

  const provenance = named("publish", "Attest exact image provenance")
  expect(provenance?.with).toMatchObject({
    "subject-name": "${{ env.IMAGE }}",
    "subject-digest": "${{ env.digest }}",
    "push-to-registry": true,
  })
  const identity = named("publish", "Attest executor build identity")
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
  expect(jobs.review?.if).toBe("inputs.resume_run_id == ''")
  expect(jobs.publish?.if).toBe("inputs.promote == true && inputs.resume_run_id == ''")
  expect(jobs.publish?.needs).toBe("review")
  expect(jobs.publish?.environment).toBe("executor-production")
  expect(jobs.publish?.permissions).toMatchObject({ packages: "write", "id-token": "write", attestations: "write" })
  expect(commands("publish")).not.toContain("E2B_API_KEY")
  expect(position("publish", "Verify approved review evidence")).toBeLessThan(
    position("publish", "Require a fresh generation package"),
  )
  expect(position("publish", "Require a fresh generation package")).toBeLessThan(
    position("publish", "Authenticate to GHCR"),
  )
  expect(position("publish", "Authenticate to GHCR")).toBeLessThan(
    position("publish", "Upload immutable digest without a tag"),
  )
  expect(position("publish", "Upload immutable digest without a tag")).toBeLessThan(
    position("publish", "Attest exact image provenance"),
  )
  expect(position("publish", "Attest executor build identity")).toBeLessThan(
    position("publish", "Verify published image attestations"),
  )

  const publish = commands("publish")
  expect(publish).toContain("rika-executor-g${{ inputs.generation }}")
  expect(publish).toContain('"docker://$IMAGE@$digest"')
  expect(publish).toContain("copy --preserve-digests")
  expect(publish).not.toContain("docker push")
  expect(publish).not.toMatch(/\$IMAGE:[^/]/)
  expect(publish).toContain('subject="oci://$IMAGE@$digest"')
  expect(publish).not.toContain("visibility=public")

  expect(jobs.template?.needs).toEqual(["review", "publish", "resume"])
  expect(jobs.template?.environment).toBe("executor-production")
  expect(jobs.template?.permissions).toMatchObject({ packages: "read", "id-token": "write", attestations: "write" })
  expect(jobs.template?.permissions?.packages).not.toBe("write")
  expect(jobs.template?.if).toContain("needs.publish.result == 'success'")
  expect(jobs.template?.if).toContain("needs.resume.result == 'success'")
  const template = commands("template")
  expect(template).toContain('template_alias="rika-executor-v1-g${{ inputs.generation }}"')
  expect(template).toContain(
    'bun run packages/e2b-executor/scripts/create-image-template.ts "$IMAGE@$digest" "$template_alias"',
  )
  expect(template).toContain(
    'bun run packages/e2b-executor/scripts/image-smoke.ts "$template_id" "$build_id" "$MANIFEST_SHA256"',
  )
  expect(position("template", "Require template credentials")).toBeLessThan(
    position("template", "Create and smoke immutable E2B build"),
  )
})

test("resumes only an exact failed promotion after verifying retained evidence and private image attestations", () => {
  expect(workflow.on?.workflow_dispatch?.inputs?.resume_run_id).toMatchObject({
    required: false,
    default: "",
    type: "string",
  })
  expect(jobs.resume?.if).toBe("inputs.promote == true && inputs.resume_run_id != ''")
  expect(jobs.resume?.permissions).toEqual({
    actions: "read",
    attestations: "read",
    contents: "read",
    packages: "read",
  })
  const download = named("resume", "Download retained review evidence")
  expect(download?.with).toMatchObject({
    "run-id": "${{ inputs.resume_run_id }}",
    "github-token": "${{ github.token }}",
  })
  const resume = commands("resume")
  expect(resume).toContain('test "$(jq -er \'.path\' resume-run.json)" = ".github/workflows/executor-image.yml"')
  expect(resume).toContain("test \"$(jq -er '.event' resume-run.json)\" = workflow_dispatch")
  expect(resume).toContain("test \"$(jq -er '.head_branch' resume-run.json)\" = main")
  expect(resume).toContain('test "$(jq -er \'.sourceCommit\' executor-build.json)" = "$SOURCE_COMMIT"')
  expect(resume).toContain("gh attestation verify executor-build.json")
  expect(resume).toContain('docker manifest inspect "$IMAGE@$digest"')
  expect(resume).toContain('subject="oci://$IMAGE@$digest"')
  expect(position("resume", "Verify retained review evidence")).toBeLessThan(
    position("resume", "Verify exact published image and attestations"),
  )
})

test("pins every workflow action to a commit", () => {
  const references = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  )
  expect(references.length).toBeGreaterThan(0)
  for (const reference of references) expect(reference).toMatch(/@[a-f0-9]{40}$/)
})
