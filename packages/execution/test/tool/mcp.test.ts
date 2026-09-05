import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { configure, makeResolver } from "../../src/routing/route"
import type { Capability } from "@rika/extensions/mcp-capability-contract"
import { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"

const capability: Capability = {
  specialist: "Librarian",
  server: "docs",
  sourceDigest: "digest",
  name: "mcp_fixture",
  rawName: "find",
  description: "Find docs",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: null,
}

it.effect("pins MCP only on granted children and restores exactly the catalog from durable registration", () =>
  Effect.gen(function* () {
    const options = { executionRoute: testExecutionRoute(), workspace: "/not-present", mcp: [capability] }
    const configured = yield* configure(options)
    for (const entry of configured.executable.manifest.entries) {
      if (entry._tag !== "Agent") continue
      expect(entry.manifest.tools.map((tool) => tool.name)).toEqual(
        entry.manifest.name === "rika-librarian"
          ? ["bash", "edit", "mcp_fixture", "read", "shell_command_status"]
          : ["bash", "edit", "read", "shell_command_status"],
      )
    }
    const resolved = yield* makeResolver({}).resolve({
      runId: "recovered",
      ref: configured.executable.ref,
      manifest: configured.executable.manifest,
      registrations: configured.registrations,
    })
    expect(resolved).toBeDefined()
    const changed = yield* configure({ ...options, mcp: [{ ...capability, inputSchema: { type: "object" } }] })
    expect(changed.executable.ref).not.toEqual(configured.executable.ref)
    const grantChanged = yield* configure({ ...options, mcp: [{ ...capability, specialist: "Task" }] })
    expect(grantChanged.executable.ref).not.toEqual(configured.executable.ref)
  }),
)

it("keeps old snapshot codecs interoperable with optional MCP advertisement and denies absent grants", () => {
  const { mcp: _mcp, ...oldFields } = WorkspaceCapabilitySnapshot.fields
  const OldSnapshot = Schema.Struct(oldFields)
  const ready = { _tag: "Ready" as const, detail: "ready" }
  const old = {
    environmentDigest: `sha256:${"0".repeat(64)}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    filesystem: ready,
    nativeTools: ready,
    git: ready,
    process: ready,
    pty: ready,
    browser: ready,
    services: ready,
    workspaceLifecycle: ready,
  }
  const decodeNew = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceCapabilitySnapshot))
  const decodeOld = Schema.decodeUnknownSync(Schema.fromJsonString(OldSnapshot))
  expect(decodeNew(Schema.encodeSync(Schema.fromJsonString(OldSnapshot))(old)).mcp).toBeUndefined()
  const encodedNew = Schema.encodeSync(Schema.fromJsonString(WorkspaceCapabilitySnapshot))({
    ...old,
    mcp: { _tag: "Ready", catalog: [capability] },
  })
  expect(decodeOld(encodedNew)).toEqual(old)
})
