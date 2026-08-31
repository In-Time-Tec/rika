import { describe, expect, it } from "@effect/vitest"
import {
  EnvironmentReferenceId,
  EnvironmentValueDigest,
  SourceCommitSha,
  defaultEgressDestinations,
  normalizeEgressDestination,
  resolveEgressPolicy,
  resolveEnvironmentReferences,
  sourceMayReceiveSecrets,
  type EnvironmentReference,
  type SourceTrust,
} from "../../../src/hosted/environment/policy"

const digest = EnvironmentValueDigest.make(`sha256:${"a".repeat(64)}`)
const source = (overrides: Partial<SourceTrust> = {}): SourceTrust => ({
  owner: "In-Time-Tec",
  commitSha: SourceCommitSha.make("a".repeat(40)),
  fork: false,
  trustedRef: true,
  ...overrides,
})
const reference = (
  scope: EnvironmentReference["scope"],
  name: string,
  overrides: Partial<EnvironmentReference> = {},
): EnvironmentReference => {
  const base: EnvironmentReference = {
    id: EnvironmentReferenceId.make(`${scope}-${name}`),
    ownerId: "owner-1",
    scope,
    scopeId: `${scope}-1`,
    name,
    classification: "secret",
    phases: ["setup", "runtime"],
    revision: "1",
    valueDigest: digest,
    state: "active",
    updatedByUserId: "user-1",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  }
  return scope === "project" ? { ...base, projectId: "project-1" } : base
}

describe("hosted environment policy", () => {
  it("applies organization, project, and personal precedence with organization override policy", () => {
    const candidates = [
      { reference: reference("project", "TOKEN") },
      { reference: reference("personal", "TOKEN") },
      { reference: reference("organization", "TOKEN") },
      { reference: reference("personal", "PERSONAL_ONLY") },
    ]
    expect(
      resolveEnvironmentReferences({
        candidates,
        phase: "runtime",
        source: source(),
        organizationPersonalOverrides: true,
      }).map(({ id }) => id),
    ).toEqual(["personal-PERSONAL_ONLY", "personal-TOKEN"])
    expect(
      resolveEnvironmentReferences({
        candidates,
        phase: "runtime",
        source: source(),
        organizationPersonalOverrides: false,
      }).map(({ id }) => id),
    ).toEqual(["personal-PERSONAL_ONLY", "project-TOKEN"])
    expect(
      resolveEnvironmentReferences({
        candidates: candidates.filter((candidate) => candidate.reference.scope !== "project"),
        phase: "runtime",
        source: source(),
        organizationPersonalOverrides: false,
      }).map(({ id }) => id),
    ).toEqual(["personal-PERSONAL_ONLY", "organization-TOKEN"])
  })

  it("denies fork and untrusted-ref secrets unless approval matches owner, source SHA, and phase", () => {
    const untrusted = source({ fork: true, trustedRef: false })
    const approval = {
      ownerId: "owner-1",
      projectId: "project-1",
      sourceOwner: untrusted.owner,
      sourceCommitSha: untrusted.commitSha,
      phase: "setup" as const,
      approvedByUserId: "user-1",
      approvedAt: "2026-08-21T00:00:00.000Z" as const,
      revokedAt: null,
    }
    expect(sourceMayReceiveSecrets({ source: untrusted, phase: "setup" })).toBe(false)
    expect(sourceMayReceiveSecrets({ source: untrusted, phase: "setup", approval })).toBe(true)
    expect(
      sourceMayReceiveSecrets({
        source: untrusted,
        phase: "setup",
        approval: { ...approval, ownerId: "owner-2" },
        ownerId: "owner-1",
      }),
    ).toBe(false)
    expect(
      sourceMayReceiveSecrets({
        source: untrusted,
        phase: "setup",
        approval: { ...approval, revokedAt: "2026-08-21T00:01:00.000Z" },
      }),
    ).toBe(false)
    expect(sourceMayReceiveSecrets({ source: untrusted, phase: "runtime", approval })).toBe(false)
    expect(
      sourceMayReceiveSecrets({
        source: source({ ...untrusted, commitSha: SourceCommitSha.make("b".repeat(40)) }),
        phase: "setup",
        approval,
      }),
    ).toBe(false)
    expect(
      resolveEnvironmentReferences({
        candidates: [
          { reference: reference("personal", "PUBLIC", { classification: "plain" }) },
          { reference: reference("project", "SECRET") },
        ],
        phase: "setup",
        source: untrusted,
        organizationPersonalOverrides: true,
      }).map(({ name }) => name),
    ).toEqual(["PUBLIC"])
  })

  it("creates separate constrained setup and runtime egress policies", () => {
    expect(defaultEgressDestinations("setup")).toEqual(["github.com", "registry.npmjs.org"])
    expect(defaultEgressDestinations("runtime")).toEqual([])
    expect(
      resolveEgressPolicy({ phase: "setup", approved: ["registry.npmjs.org", "github.com", "github.com"] }),
    ).toEqual({ phase: "setup", allow: ["github.com", "registry.npmjs.org"] })
    expect(resolveEgressPolicy({ phase: "runtime", approved: ["api.example.com"] })).toEqual({
      phase: "runtime",
      allow: ["api.example.com"],
    })
    for (const destination of [
      "*",
      "0.0.0.0/0",
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "metadata.google.internal",
      "api.e2b.dev",
      "sandbox.e2b.app",
      "postgres.internal",
    ]) {
      expect(normalizeEgressDestination({ destination })).toBeUndefined()
    }
    expect(
      resolveEgressPolicy({
        phase: "runtime",
        approved: ["db.public.example.com"],
        protectedHosts: new Set(["db.public.example.com"]),
      }),
    ).toBeUndefined()
  })
})
