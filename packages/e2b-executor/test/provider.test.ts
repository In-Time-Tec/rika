import "./provider.harness"
import { describe, expect, it } from "@effect/vitest"
import { ALL_TRAFFIC, type SandboxInfo, type SandboxOpts } from "e2b"
import { Effect, Redacted, Schema } from "effect"
import { makeWithSdk, type Sdk, SdkError, testing } from "../src/provider"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const request = {
  appId: "rika",
  deploymentId: "test",
  templateId: "ar7-template-alias",
  templateBuildId: "7d0-build-receipt",
  assignmentId: "assignment-1",
  threadId: "thread-1",
  generation: 3,
  idleTimeoutMillis: 900_000,
  allowedEgress: ["api.example.test", "github.com"],
  environment: {
    RIKA_EXECUTOR_ASSIGNMENT_ID: "assignment-1",
    RIKA_EXECUTOR_TEMPLATE_BUILD_ID: "7d0-build-receipt",
  },
} as const

const bootstrapIdentity = (sandboxId: string) => ({
  target: "orb" as const,
  ownerId: "owner-1",
  threadId: "thread-1",
  assignmentId: "assignment-1",
  assignmentGeneration: 3,
  instanceId: sandboxId,
  executorId: "assignment-1:g3",
  templateBuildId: request.templateBuildId,
  apiUrl: "wss://api.example.test/api/v1/executors",
  workspaceId: "workspace-1",
  repository: null,
  lifecycle: "fresh" as const,
  environmentDigest: `sha256:${"a".repeat(64)}`,
  setupCache: false,
})

const sandboxInfo = (sandboxId: string, state: "running" | "paused"): SandboxInfo =>
  ({
    sandboxId,
    state,
    templateId: request.templateId,
    metadata: { "rika.managed": "e2b-executor", "rika.template-build-id": "7d0-build-receipt" },
  }) as unknown as SandboxInfo

const attestationSdk = {
  buildStatus: () =>
    Effect.succeed({
      templateId: request.templateId,
      buildId: request.templateBuildId,
      status: "ready" as const,
    }),
  getInfo: (sandboxId: string) =>
    Effect.succeed({ ...sandboxInfo(sandboxId, "running"), templateId: request.templateId }),
}

describe("Provider", () => {
  it("uses E2B's supported all-traffic sentinel as the deny baseline", () => {
    expect(testing.protectedNetworks).toEqual([ALL_TRAFFIC])
  })

  it.effect("attests the E2B template build before and after creation while preserving its receipt", () => {
    let template = ""
    let createOptions: SandboxOpts | undefined
    const sdk = {
      ...attestationSdk,
      create: (templateBuildId: string, options: SandboxOpts) => {
        template = templateBuildId
        createOptions = options
        return Effect.succeed({ sandboxId: "sandbox-e2b" })
      },
      kill: () => Effect.succeed(true),
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      expect(yield* provider.create(request)).toEqual({ sandboxId: "sandbox-e2b", state: "running" })
      expect(template).toBe("ar7-template-alias:7d0-build-receipt")
      expect(createOptions).toMatchObject({
        apiKey: "e2b-controller-secret",
        timeoutMs: 900_000,
        secure: true,
        allowInternetAccess: true,
        lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
        network: {
          allowPublicTraffic: false,
          allowInternetAccess: true,
          allowOut: ["api.example.test", "github.com"],
          denyOut: [...testing.protectedNetworks],
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

  it.effect("rejects an unknown immutable build before creating a sandbox", () => {
    let created = false
    const sdk = {
      ...attestationSdk,
      buildStatus: () =>
        Effect.succeed({ templateId: request.templateId, buildId: "different-build", status: "ready" as const }),
      create: () => {
        created = true
        return Effect.succeed({ sandboxId: "unexpected" })
      },
      kill: () => Effect.succeed(true),
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(provider.create(request))
      expect(failure).toMatchObject({ operation: "create", message: "E2B template build attestation failed" })
      expect(created).toBe(false)
    })
  })

  it.effect("kills a new sandbox when its immutable build no longer attests during creation", () => {
    let checks = 0
    const killed: Array<string> = []
    const sdk = {
      ...attestationSdk,
      buildStatus: () =>
        Effect.succeed({
          templateId: request.templateId,
          buildId: checks++ === 0 ? request.templateBuildId : "different-build",
          status: "ready" as const,
        }),
      create: () => Effect.succeed({ sandboxId: "retargeted" }),
      kill: (sandboxId: string) => {
        killed.push(sandboxId)
        return Effect.succeed(true)
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
      create: () => Effect.succeed({ sandboxId: "wrong-template" }),
      getInfo: (sandboxId: string) =>
        Effect.succeed({ ...sandboxInfo(sandboxId, "running"), templateId: "different-template" }),
      kill: (sandboxId: string) => {
        killed.push(sandboxId)
        return Effect.succeed(true)
      },
    } as unknown as Sdk
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(provider.create(request))
      expect(failure).toMatchObject({ operation: "create", message: "E2B sandbox template attestation failed" })
      expect(killed).toEqual(["wrong-template"])
    })
  })

  it.effect("waits for the secure traffic token and bootstrap port before sending the credential once", () => {
    let connects = 0
    let probes = 0
    let posts = 0
    let postBody: RequestInit["body"]
    const headers: Array<RequestInit["headers"]> = []
    return testing
      .bootstrapSandbox(
        {
          sandboxId: "sandbox",
          body: '{"credential":"bootstrap-secret"}',
          connection: { apiKey: "e2b-controller-secret", requestTimeoutMs: 1_000 },
          url: "https://7070-sandbox.e2b.app/.rika/bootstrap",
        },
        {
          now: Effect.succeed(1),
          sleep: () => Effect.void,
          connect: () =>
            Effect.succeed({
              sandboxId: "sandbox",
              ...(connects++ === 0 ? {} : { trafficAccessToken: "sandbox-traffic-secret" }),
            }),
          fetch: (input, init) => {
            headers.push(init?.headers)
            if (init?.method === "POST") {
              posts++
              postBody = init.body
              return Effect.succeed(new Response("accepted", { status: 202 }))
            }
            probes++
            expect(new URL(input).pathname).toBe("/health")
            return Effect.succeed(
              new Response(probes === 1 ? "starting" : "ready", { status: probes === 1 ? 502 : 200 }),
            )
          },
        },
      )
      .pipe(
        Effect.mapError(() => SdkError.make({ message: "bootstrap sandbox test transport failed" })),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(connects).toBe(2)
            expect(probes).toBe(2)
            expect(posts).toBe(1)
            expect(postBody).toBe('{"credential":"bootstrap-secret"}')
            expect(headers.at(-1)).toEqual({
              "content-type": "application/json",
              "e2b-traffic-access-token": "sandbox-traffic-secret",
            })
          }),
        ),
      )
  })

  it.effect("maps every lifecycle operation and redacts controller and bootstrap secrets from failures", () => {
    const calls: Array<string> = []
    let bootstrapUrl = ""
    let bootstrapApiKey = ""
    let bootstrapBody = ""
    const sdk: Sdk = {
      ...attestationSdk,
      buildStatus: () => Effect.fail(SdkError.make({ message: "e2b-controller-secret bootstrap-secret" })),
      create: () => Effect.fail(SdkError.make({ message: "e2b-controller-secret bootstrap-secret" })),
      connect: (sandboxId) => {
        calls.push(`connect:${sandboxId}`)
        return Effect.succeed({ sandboxId })
      },
      host: (sandboxId, port) => {
        calls.push(`host:${sandboxId}:${port}`)
        return Effect.succeed(`${port}-${sandboxId}.e2b.app`)
      },
      updateNetwork: (sandboxId, network) => {
        calls.push(`network:${sandboxId}:${JSON.stringify(network)}`)
        return Effect.void
      },
      pause: (sandboxId, options) => {
        calls.push(`pause:${sandboxId}:${String(options.keepMemory)}`)
        return Effect.succeed(true)
      },
      kill: (sandboxId) => {
        calls.push(`kill:${sandboxId}`)
        return Effect.succeed(true)
      },
      setTimeout: (sandboxId, timeout) => {
        calls.push(`touch:${sandboxId}:${timeout}`)
        return Effect.void
      },
      list: () => ({ hasNext: false, nextItems: Effect.succeed([]) }),
      bootstrap: (input) => {
        bootstrapUrl = input.url
        bootstrapApiKey = input.connection.apiKey ?? ""
        bootstrapBody = input.body
        return Effect.void
      },
    }
    const provider = makeWithSdk({ options: { apiKey: Redacted.make("e2b-controller-secret") }, sdk })
    return Effect.gen(function* () {
      const failed = yield* Effect.flip(provider.create(request))
      expect(failed.message).not.toContain("e2b-controller-secret")
      expect(failed.message).not.toContain("bootstrap-secret")
      expect(yield* provider.connect("sandbox", 900_000)).toEqual({ sandboxId: "sandbox", state: "running" })
      expect(yield* provider.host("sandbox", 3000)).toBe("3000-sandbox.e2b.app")
      yield* provider.updateNetwork("sandbox", ["runtime.example.test"])
      yield* provider.bootstrap({
        sandboxId: "sandbox",
        credential: Redacted.make("bootstrap-secret"),
        identity: bootstrapIdentity("sandbox"),
        restore: null,
      })
      expect(bootstrapUrl).toBe("https://7070-sandbox.e2b.app/.rika/bootstrap")
      expect(bootstrapApiKey).toBe("e2b-controller-secret")
      expect(decodeJson(bootstrapBody)).toEqual({
        credential: "bootstrap-secret",
        identity: bootstrapIdentity("sandbox"),
        restore: null,
      })
      expect(testing.bootstrapHeaders("sandbox-traffic-secret")).toEqual({
        "content-type": "application/json",
        "e2b-traffic-access-token": "sandbox-traffic-secret",
      })
      expect(yield* provider.pauseFilesystem("sandbox")).toBe(true)
      yield* provider.touch("sandbox", 900_000)
      expect(yield* provider.kill("sandbox")).toBe(true)
      expect(calls).toEqual([
        "connect:sandbox",
        "host:sandbox:3000",
        `network:sandbox:${encodeJson(testing.networkPolicy(["runtime.example.test"]))}`,
        "pause:sandbox:false",
        "touch:sandbox:900000",
        "kill:sandbox",
      ])
    })
  })

  it.effect("rejects inventory whose immutable build receipt does not attest", () => {
    const sdk = {
      ...attestationSdk,
      buildStatus: () =>
        Effect.succeed({ templateId: request.templateId, buildId: "different-build", status: "ready" as const }),
      list: () => {
        let read = false
        return {
          get hasNext() {
            return !read
          },
          nextItems: Effect.sync(() => {
            read = true
            return [sandboxInfo("unattested", "running")]
          }),
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
        nextItems: Effect.sync(() => pages[page++]!),
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
