import { describe, expect, it } from "@effect/vitest"
import { make, digest, pin, defaultLimits } from "@rika/kernel/kernel-profile-registration"

const base = { runtimeVersion: "1.3.14", workspace: "/repo", dataRoot: "/data" } as const

describe("kernel profile registration", () => {
  it("pins the runtime, workspace, limits, and trust posture", () => {
    const profile = make(base)
    expect(profile.runtime.name).toBe("bun")
    expect(profile.runtime.version).toBe("1.3.14")
    expect(profile.workspace).toEqual({ root: "/repo", dataRoot: "/data" })
    expect(profile.limits).toEqual(defaultLimits)
    expect(profile.trustMode).toBe("trusted-local")
  })

  it("is stable for one identical input", () => {
    expect(digest(make(base))).toBe(digest(make(base)))
  })

  it("starts a new epoch when the Bun version changes", () => {
    expect(digest(make({ ...base, runtimeVersion: "1.3.15" }))).not.toBe(digest(make(base)))
  })

  it("starts a new epoch when the workspace or data root changes", () => {
    expect(digest(make({ ...base, workspace: "/other" }))).not.toBe(digest(make(base)))
    expect(digest(make({ ...base, dataRoot: "/other" }))).not.toBe(digest(make(base)))
  })

  it("starts a new epoch when the trust mode changes", () => {
    expect(digest(make({ ...base, trustMode: "trusted-workspace" }))).not.toBe(digest(make(base)))
  })

  it("starts a new epoch when a limit changes", () => {
    expect(digest(make({ ...base, limits: { ...defaultLimits, cellDeadlineMillis: 1_000 } }))).not.toBe(
      digest(make(base)),
    )
  })

  it("carries the bindings digest, so evolving the surface changes the profile", () => {
    expect(make(base).bindingsDigest).toEqual(expect.any(String))
    expect(make(base).bindingsDigest.length).toBeGreaterThan(0)
  })

  const skill = (name: string, overrides?: Partial<{ importName: string; digest: string; importable: boolean }>) => ({
    name,
    importName: `@skills/${name}`,
    digest: "skill-digest",
    importable: true,
    ...overrides,
  })

  const server = (name: string, enabled = true) => ({ server: { name }, enabled })

  it("starts a new epoch when an executable skill is added", () => {
    expect(digest(make({ ...base, environment: { skills: [skill("search")] } }))).not.toBe(digest(make(base)))
  })

  it("starts a new epoch when an executable skill changes content", () => {
    const before = make({ ...base, environment: { skills: [skill("search")] } })
    const after = make({ ...base, environment: { skills: [skill("search", { digest: "other" })] } })
    expect(digest(after)).not.toBe(digest(before))
  })

  it("ignores an executable skill the kernel may not import", () => {
    const withUntrusted = make({ ...base, environment: { skills: [skill("local", { importable: false })] } })
    expect(digest(withUntrusted)).toBe(digest(make({ ...base, environment: { skills: [] } })))
  })

  it("starts a new epoch when a reachable MCP server set changes", () => {
    const one = make({ ...base, environment: { servers: [server("files")] } })
    const two = make({ ...base, environment: { servers: [server("files"), server("search")] } })
    expect(digest(two)).not.toBe(digest(one))
  })

  it("ignores a disabled MCP server", () => {
    const disabled = make({ ...base, environment: { servers: [server("files"), server("legacy", false)] } })
    expect(digest(disabled)).toBe(digest(make({ ...base, environment: { servers: [server("files")] } })))
  })

  it("does not depend on the order the environment is discovered in", () => {
    const forward = make({
      ...base,
      environment: { skills: [skill("alpha"), skill("zulu")], servers: [server("a"), server("z")] },
    })
    const reversed = make({
      ...base,
      environment: { skills: [skill("zulu"), skill("alpha")], servers: [server("z"), server("a")] },
    })
    expect(digest(reversed)).toBe(digest(forward))
  })

  it("produces a capability pin a replayed Execution can reconstruct from", () => {
    expect(pin(make(base))).toMatch(/^capability-pin:v1:sha256:[0-9a-f]{64}$/)
    expect(pin(make(base))).toBe(pin(make(base)))
    expect(pin(make({ ...base, runtimeVersion: "9.9.9" }))).not.toBe(pin(make(base)))
  })
})
