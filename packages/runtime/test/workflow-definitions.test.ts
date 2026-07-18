import { describe, expect, it } from "vitest"
import { compile, definitions } from "../src/workflow-definitions"

describe("workflow definitions", () => {
  it("compiles pinned v2 product workflows with grounded children and joins", () => {
    expect(definitions.map((item) => [item.definition.version, item.definition.name])).toEqual([
      [2, "delivery"],
      [2, "research-synthesis"],
    ])
    const research = definitions[1]!.definition
    expect(research.operations.find((operation) => operation.kind === "parallel")).toMatchObject({
      fan_out_key: "research",
      max_concurrency: 2,
    })
    expect(research.operations.find((operation) => operation.kind === "join")).toMatchObject({
      policy: { _tag: "all" },
    })
  })

  it("compiles the complete typed extension surface without executable code", () => {
    const result = compile({
      schemaVersion: 1,
      name: "extension",
      entry: "sequence",
      operations: [
        { id: "sequence", kind: "sequence", operations: ["approval", "timer", "branch"] },
        { id: "approval", kind: "approval", prompt: "Continue?" },
        { id: "timer", kind: "timer", durationMs: 10 },
        { id: "branch", kind: "branch", condition: "approved", whenTrue: "retry", whenFalse: "cancel" },
        { id: "child", kind: "child", profile: "Task", prompt: "work" },
        { id: "tool", kind: "tool", toolName: "workspace.read", input: { path: "README.md" } },
        { id: "tool-empty", kind: "tool", toolName: "git.status" },
        { id: "retry", kind: "retry", operation: "child", maxAttempts: 3 },
        { id: "budget", kind: "budget", operation: "retry", limit: 100, unit: "operations" },
        { id: "cancel", kind: "cancellation", operation: "budget", onCancel: "undo" },
        { id: "cancel-plain", kind: "cancellation", operation: "budget" },
        { id: "undo", kind: "compensation", operation: "child", compensateWith: "timer" },
        { id: "parallel", kind: "parallel", fanOutKey: "extension", operations: ["child"], maxConcurrency: 1 },
        {
          id: "join",
          kind: "join",
          parallelOperation: "parallel",
          members: ["child"],
          policy: { _tag: "quorum", count: 1 },
        },
        { id: "completion", kind: "structured-completion", schemaRef: "schema:result", valueFrom: "tool" },
      ],
    })
    expect(result.definition.version).toBe(2)
    expect(result.definition.operations.map((operation) => operation.kind)).toEqual([
      "sequence",
      "approval",
      "timer",
      "branch",
      "child",
      "tool",
      "tool",
      "retry",
      "budget",
      "cancellation",
      "cancellation",
      "compensation",
      "parallel",
      "join",
      "structured-completion",
    ])
    expect(result.definition.operations.find((operation) => operation.kind === "tool")).toMatchObject({
      tool_name: "workspace.read",
      input: { path: "README.md" },
    })
    expect(result.definition.operations.find((operation) => operation.kind === "structured-completion")).toMatchObject({
      schema_ref: "schema:result",
      value_from: "tool",
    })
    expect(result.definition.operations.find((operation) => operation.id === "tool-empty")).toEqual({
      id: "tool-empty",
      kind: "tool",
      tool_name: "git.status",
    })
  })

  it.each([
    {
      name: "a missing entry",
      definition: {
        schemaVersion: 1 as const,
        name: "invalid-entry",
        entry: "missing",
        operations: [{ id: "present", kind: "timer" as const, durationMs: 0 }],
      },
    },
    {
      name: "duplicate operation identifiers",
      definition: {
        schemaVersion: 1 as const,
        name: "duplicate-operations",
        entry: "same",
        operations: [
          { id: "same", kind: "timer" as const, durationMs: 0 },
          { id: "same", kind: "approval" as const, prompt: "Continue?" },
        ],
      },
    },
    {
      name: "an invalid retry limit",
      definition: {
        schemaVersion: 1 as const,
        name: "invalid-retry",
        entry: "retry",
        operations: [
          { id: "retry", kind: "retry" as const, operation: "work", maxAttempts: 0 },
          { id: "work", kind: "child" as const, profile: "Task", prompt: "work" },
        ],
      },
    },
    {
      name: "a join member outside its parallel operation",
      definition: {
        schemaVersion: 1 as const,
        name: "invalid-join",
        entry: "sequence",
        operations: [
          { id: "sequence", kind: "sequence" as const, operations: ["parallel", "join"] },
          {
            id: "parallel",
            kind: "parallel" as const,
            fanOutKey: "invalid-join",
            operations: ["one"],
            maxConcurrency: 1,
          },
          { id: "one", kind: "child" as const, profile: "Task", prompt: "one" },
          { id: "two", kind: "child" as const, profile: "Task", prompt: "two" },
          {
            id: "join",
            kind: "join" as const,
            parallelOperation: "parallel",
            members: ["two"],
            policy: { _tag: "all" as const },
          },
        ],
      },
    },
  ])("rejects $name before registration", ({ definition }) => {
    expect(() => compile(definition)).toThrow()
  })
})
