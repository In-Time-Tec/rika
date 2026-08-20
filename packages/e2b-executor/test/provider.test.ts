import { describe, expect, it } from "@effect/vitest"
import type { SandboxInfo, SandboxOpts } from "e2b"
import { Effect, Redacted } from "effect"
import { makeWithSdk, type Sdk, testing } from "../src/provider"

const request = {
  appId: "rika",
  deploymentId: "test",
  templateId: "ar7-template-alias",
  templateBuildId: "7d0-build-receipt",
  assignmentId: "assignment-1",
  threadId: "thread-1",
  generation: 3,
  idleTimeoutMillis: 900_000,
  allowedEgress: ["controller.example.test", "github.com"],
  environment: {
    RIKA_EXECUTOR_ASSIGNMENT_ID: "assignment-1",
    RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "7d0-build-receipt",
  },
} as const

const sandboxInfo = (sandboxId: string, state: "running" | "paused"): SandboxInfo =>
  ({
    sandboxId,
    state,
    templateId: request.templateId,
    metadata: { "rika.managed": "e2b-executor", "rika.template-build-id": "7d0-build-receipt" },
  }) as unknown as SandboxInfo

const attestationSdk = {
  templateTags: () => Promise.resolve([{ tag: "default", buildId: request.templateBuildId }]),
  buildStatus: () =>
    Promise.resolve({
      templateId: request.templateId,
      buildId: request.templateBuildId,
      status: "ready" as const,
    }),
  getInfo: (sandboxId: string) =>
    Promise.resolve({ ...sandboxInfo(sandboxId, "running"), templateId: request.templateId }),
}

describe("Provider", () => {
  it.effect("attests the E2B template build before and after creation while preserving its receipt", () => {
    let template = ""
    let createOptions: SandboxOpts | undefined
    const sdk = {
      ...attestationSdk,
      create: (templateBuildId: string, options: SandboxOpts) => {
        template = templateBuildId
        createOptions = options
        return Promise.resolve({ sandboxId: "sandbox-e2b" })
      },
      kill: () => Promise.resolve(true),
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      expect(yield* provider.create(request)).toEqual({ sandboxId: "sandbox-e2b", state: "running" })
      expect(template).toBe("ar7-template-alias")
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
          "rika.template-build-id": "7d0-build-receipt",
        },
        envs: {
          RIKA_EXECUTOR_ASSIGNMENT_ID: "assignment-1",
          RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "7d0-build-receipt",
        },
      })
    })
  })

  it.effect("rejects a retargeted default build before creating a sandbox", () => {
    let created = false
    const sdk = {
      ...attestationSdk,
      templateTags: () => Promise.resolve([{ tag: "default", buildId: "different-build" }]),
      create: () => {
        created = true
        return Promise.resolve({ sandboxId: "unexpected" })
      },
      kill: () => Promise.resolve(true),
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(provider.create(request))
      expect(failure).toMatchObject({ operation: "create", message: "E2B template build attestation failed" })
      expect(created).toBe(false)
    })
  })

  it.effect("kills a new sandbox when the default build is retargeted during creation", () => {
    let checks = 0
    const killed: Array<string> = []
    const sdk = {
      ...attestationSdk,
      templateTags: () =>
        Promise.resolve([{ tag: "default", buildId: checks++ === 0 ? request.templateBuildId : "retargeted-build" }]),
      create: () => Promise.resolve({ sandboxId: "retargeted" }),
      kill: (sandboxId: string) => {
        killed.push(sandboxId)
        return Promise.resolve(true)
      },
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(provider.create(request))
      expect(failure).toMatchObject({ operation: "create", message: "E2B template build attestation failed" })
      expect(killed).toEqual(["retargeted"])
    })
  })

  it.effect("kills a new sandbox when E2B reports a different template identity", () => {
    const killed: Array<string> = []
    const sdk = {
      ...attestationSdk,
      create: () => Promise.resolve({ sandboxId: "wrong-template" }),
      getInfo: (sandboxId: string) =>
        Promise.resolve({ ...sandboxInfo(sandboxId, "running"), templateId: "different-template" }),
      kill: (sandboxId: string) => {
        killed.push(sandboxId)
        return Promise.resolve(true)
      },
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(provider.create(request))
      expect(failure).toMatchObject({ operation: "create", message: "E2B sandbox template attestation failed" })
      expect(killed).toEqual(["wrong-template"])
    })
  })

  it.effect("maps every lifecycle operation and redacts controller and bootstrap secrets from failures", () => {
    const calls: Array<string> = []
    let bootstrapUrl = ""
    let bootstrapApiKey = ""
    const sdk: Sdk = {
      ...attestationSdk,
      templateTags: () => Promise.reject(new Error("e2b-controller-secret bootstrap-secret")),
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
        bootstrapApiKey = input.connection.apiKey ?? ""
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
      expect(bootstrapApiKey).toBe("e2b-controller-secret")
      expect(testing.bootstrapHeaders("sandbox-traffic-secret")).toEqual({
        "content-type": "application/json",
        "e2b-traffic-access-token": "sandbox-traffic-secret",
      })
      expect(yield* provider.pauseFilesystem("sandbox")).toBe(true)
      yield* provider.touch("sandbox", 900_000)
      expect(yield* provider.kill("sandbox")).toBe(true)
      expect(calls).toEqual(["connect:sandbox", "pause:sandbox:false", "touch:sandbox:900000", "kill:sandbox"])
    })
  })

  it.effect("rejects inventory whose metadata receipt is not the provider default build", () => {
    const sdk = {
      ...attestationSdk,
      templateTags: () => Promise.resolve([{ tag: "default", buildId: "different-build" }]),
      list: () => {
        let read = false
        return {
          get hasNext() {
            return !read
          },
          nextItems: () => {
            read = true
            return Promise.resolve([sandboxInfo("unattested", "running")])
          },
        }
      },
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      expect(yield* Effect.flip(provider.inventory)).toMatchObject({
        operation: "inventory",
        message: "E2B template build attestation failed",
      })
    })
  })

  it.effect("paginates running and paused managed inventory", () => {
    const pages = [[sandboxInfo("running", "running")], [sandboxInfo("paused", "paused")]]
    let page = 0
    const sdk = {
      ...attestationSdk,
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
        expect.objectContaining({ sandboxId: "running", state: "running", templateBuildId: "7d0-build-receipt" }),
        expect.objectContaining({ sandboxId: "paused", state: "paused", templateBuildId: "7d0-build-receipt" }),
      ])
    })
  })
})
