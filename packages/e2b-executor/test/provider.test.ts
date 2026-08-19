import { describe, expect, it } from "@effect/vitest"
import type { SandboxInfo, SandboxOpts } from "e2b"
import { Effect, Redacted } from "effect"
import { makeWithSdk, type Sdk } from "../src/provider"

const request = {
  appId: "rika",
  deploymentId: "test",
  templateBuildId: "build-immutable-v1",
  assignmentId: "assignment-1",
  threadId: "thread-1",
  generation: 3,
  idleTimeoutMillis: 900_000,
  allowedEgress: ["controller.example.test", "github.com"],
  environment: { RIKA_EXECUTOR_ASSIGNMENT_ID: "assignment-1" },
} as const

const sandboxInfo = (sandboxId: string, state: "running" | "paused"): SandboxInfo =>
  ({
    sandboxId,
    state,
    templateId: "template-id",
    metadata: { "rika.managed": "e2b-executor", "rika.template-build-id": "build-immutable-v1" },
  }) as unknown as SandboxInfo

describe("Provider", () => {
  it.effect("provisions default-deny ingress and egress with 15-minute filesystem-only idle pause", () => {
    let template = ""
    let createOptions: SandboxOpts | undefined
    const sdk = {
      create: (templateBuildId, options) => {
        template = templateBuildId
        createOptions = options
        return Promise.resolve({ sandboxId: "sandbox-e2b" })
      },
    } as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      expect(yield* provider.create(request)).toEqual({ sandboxId: "sandbox-e2b", state: "running" })
      expect(template).toBe("build-immutable-v1")
      expect(createOptions).toMatchObject({
        apiKey: "e2b-controller-secret",
        timeoutMs: 900_000,
        secure: true,
        allowInternetAccess: true,
        lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
        network: {
          allowPublicTraffic: false,
          allowOut: ["controller.example.test", "github.com"],
          denyOut: ["0.0.0.0/0"],
        },
        metadata: {
          "rika.managed": "e2b-executor",
          "rika.assignment-id": "assignment-1",
          "rika.thread-id": "thread-1",
          "rika.generation": "3",
          "rika.template-build-id": "build-immutable-v1",
        },
        envs: {
          RIKA_EXECUTOR_ASSIGNMENT_ID: "assignment-1",
        },
      })
    })
  })

  it.effect("maps every lifecycle operation and redacts controller and bootstrap secrets from failures", () => {
    const calls: Array<string> = []
    let bootstrapUrl = ""
    const sdk: Sdk = {
      create: () => Promise.reject(new Error("e2b-controller-secret bootstrap-secret")),
      connect: (sandboxId) => {
        calls.push(`connect:${sandboxId}`)
        return Promise.resolve({ sandboxId })
      },
      pause: (sandboxId, options) => {
        calls.push(`pause:${sandboxId}:${String(options.keepMemory)}`)
        return Promise.resolve(true)
      },
      kill: (sandboxId) => {
        calls.push(`kill:${sandboxId}`)
        return Promise.resolve(true)
      },
      setTimeout: (sandboxId, timeout) => {
        calls.push(`touch:${sandboxId}:${timeout}`)
        return Promise.resolve()
      },
      list: () => ({ hasNext: false, nextItems: () => Promise.resolve([]) }),
      bootstrap: (input) => {
        bootstrapUrl = input.url
        return Promise.resolve()
      },
    }
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failed = yield* Effect.flip(provider.create(request))
      expect(failed.message).not.toContain("e2b-controller-secret")
      expect(failed.message).not.toContain("bootstrap-secret")
      expect(yield* provider.connect("sandbox", 900_000)).toEqual({ sandboxId: "sandbox", state: "running" })
      yield* provider.bootstrap({ sandboxId: "sandbox", credential: Redacted.make("bootstrap-secret") })
      expect(bootstrapUrl).toBe("https://7070-sandbox.e2b.app/.rika/bootstrap")
      expect(yield* provider.pauseFilesystem("sandbox")).toBe(true)
      yield* provider.touch("sandbox", 900_000)
      expect(yield* provider.kill("sandbox")).toBe(true)
      expect(calls).toEqual(["connect:sandbox", "pause:sandbox:false", "touch:sandbox:900000", "kill:sandbox"])
    })
  })

  it.effect("paginates running and paused managed inventory", () => {
    const pages = [[sandboxInfo("running", "running")], [sandboxInfo("paused", "paused")]]
    let page = 0
    const sdk = {
      list: () => ({
        get hasNext() {
          return page < pages.length
        },
        nextItems: () => Promise.resolve(pages[page++]!),
      }),
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      expect(yield* provider.inventory).toEqual([
        expect.objectContaining({ sandboxId: "running", state: "running", templateBuildId: "build-immutable-v1" }),
        expect.objectContaining({ sandboxId: "paused", state: "paused", templateBuildId: "build-immutable-v1" }),
      ])
    })
  })
})
