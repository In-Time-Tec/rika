/* oxlint-disable effecttsgo/strict-effect-provide -- these tests supply deterministic platform services at their boundary. */
import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem } from "effect"
import { ProductClientError, type ProductClient } from "@rika/client/product"
import type { WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import { Installation, type PreparedInstallation } from "../src/client/installation"
import { validateRunnerBinding } from "../src/client/runners"
import { prepareOnlineStartup } from "../src/launch"
import { resolveLaunchOptions, type MainOptions } from "../src/main"

const options = (overrides: Partial<MainOptions> = {}): MainOptions => ({
  offline: false,
  scenario: "welcome",
  animate: true,
  apiUrl: "https://rika.test",
  workspace: "",
  thread: "",
  box: false,
  ...overrides,
})

const prepared: PreparedInstallation = {
  deviceId: "device",
  workspacePath: "/workspace",
  checkoutFingerprint: "checkout",
  workspaceIdentity: "runner:workspace",
  profile: {
    protocolVersion: 2,
    workspaceIdentity: "runner:workspace",
    repository: { identity: "repository" },
    nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0", trustMode: "trusted-local" },
    capabilities: { nativeTools: true, checkpoints: false, pty: false },
  },
}

it.effect("keeps offline scenarios explicit and makes local Runner placement the online default", () =>
  Effect.gen(function* () {
    expect(
      yield* resolveLaunchOptions(options({ offline: true, scenario: "streaming", apiUrl: "" }), "/current"),
    ).toEqual({ scenario: "streaming", animate: true })
    expect(yield* resolveLaunchOptions(options({ apiUrl: "https://rika.test" }), "/current")).toEqual({
      scenario: "welcome",
      animate: true,
      connection: {
        apiUrl: "https://rika.test",
        workspace: "/current",
        target: "runner",
      },
    })
    expect(
      yield* resolveLaunchOptions(
        options({ apiUrl: "https://rika.test", workspace: "/checkout", box: true }),
        "/current",
      ),
    ).toMatchObject({ connection: { workspace: "/checkout", target: "orb" } })
  }),
)

it.effect("rejects implicit offline fallback and conflicting Box reconnection", () =>
  Effect.gen(function* () {
    const missingApi = yield* Effect.flip(resolveLaunchOptions(options({ apiUrl: "" }), "/current"))
    expect(missingApi.userMessage).toContain("--api-url")
    expect(missingApi.userMessage).toContain("--offline")
    const existingBox = yield* Effect.flip(
      resolveLaunchOptions(options({ apiUrl: "https://rika.test", thread: "thread", box: true }), "/current"),
    )
    expect(existingBox.userMessage).toContain("already has an execution target")
  }),
)

const seedWorkspace = Effect.fn("TuiV2.MainTest.seedWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const workspace = yield* fileSystem.makeTempDirectory({ prefix: "rika-tui-v2-startup-" })
  yield* fileSystem.writeFileString(`${workspace}/seeded.txt`, "local checkout contents\n")
  return workspace
})

it.effect("authenticates and registers the checkout before creating a Runner Thread with one caller identity", () => {
  const events: string[] = []
  const requests: Array<{ readonly threadId: string; readonly target: string }> = []
  return prepareOnlineStartup({
    workspace: "/workspace",
    target: "runner",
    callerId: "caller-thread",
    deviceId: "device",
    product: {
      identity: Effect.sync(() => {
        events.push("identity")
        return { userId: "user", ownerId: "owner" }
      }),
      thread: () => Effect.die("Startup creation must not read an unrelated Thread"),
      createThread: (request) =>
        Effect.sync(() => {
          events.push("create")
          requests.push(request)
          return { threadId: request.threadId }
        }),
    },
    runner: {
      register: () =>
        Effect.sync(() => {
          events.push("register")
        }),
    },
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.provideService(
      Installation,
      Installation.of({
        prepare: () =>
          Effect.sync(() => {
            events.push("installation")
            return prepared
          }),
      }),
    ),
    Effect.tap((startup) =>
      Effect.sync(() => {
        expect(events).toEqual(["identity", "installation", "register", "create"])
        expect(requests).toEqual([
          {
            owner: { kind: "personal" },
            threadId: "caller-thread",
            target: "runner",
            runnerTarget: { deviceId: "device", checkoutFingerprint: "checkout" },
          },
        ])
        expect(startup.thread).toEqual({ id: "caller-thread", target: "runner" })
        expect(startup.creation.runnerTarget).toEqual({ deviceId: "device", checkoutFingerprint: "checkout" })
      }),
    ),
    Effect.asVoid,
  )
})

it.effect("keeps an unknown explicit Thread as an error without creating a Box fallback", () => {
  let creations = 0
  return prepareOnlineStartup({
    workspace: "/workspace",
    target: "runner",
    threadId: "missing",
    callerId: "unused-caller",
    deviceId: "device",
    product: {
      identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
      thread: () =>
        ProductClientError.make({ kind: "protocol", message: "Requested Thread was not found", status: 404 }),
      createThread: () => {
        creations += 1
        return Effect.die("Explicit Thread selection must not create a fallback")
      },
    },
    runner: { register: () => Effect.void },
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.provideService(Installation, Installation.of({ prepare: () => Effect.succeed(prepared) })),
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toBe("Requested Thread was not found")
        expect(creations).toBe(0)
      }),
    ),
    Effect.asVoid,
  )
})

it.effect("creates a Box Thread only when Box placement is explicit and stages the checkout as its seed", () =>
  Effect.gen(function* () {
    const requests: Parameters<ProductClient["createThread"]>[0][] = []
    const staged: Parameters<WorkspaceSeedClient["stage"]>[0][] = []
    const workspace = yield* seedWorkspace()
    const installed: PreparedInstallation = { ...prepared, workspacePath: workspace }
    const startup = yield* prepareOnlineStartup({
      workspace: "/workspace",
      target: "orb",
      callerId: "box-thread",
      deviceId: "device",
      product: {
        identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
        thread: () => Effect.die("Box startup must use the creation receipt"),
        createThread: (request) => {
          requests.push(request)
          return Effect.succeed({ threadId: request.threadId })
        },
      },
      runner: { register: () => Effect.void },
      workspaceSeeds: {
        stage: (input) =>
          Effect.sync(() => {
            staged.push(input)
            return { workspaceSeedId: "workspace-seed-startup" }
          }),
      },
    }).pipe(Effect.provideService(Installation, Installation.of({ prepare: () => Effect.succeed(installed) })))
    expect(staged).toHaveLength(1)
    expect(staged[0]?.owner).toEqual({ kind: "personal" })
    expect(staged[0]?.archive.content.length).toBeGreaterThan(0)
    expect(requests).toEqual([
      {
        owner: { kind: "personal" },
        threadId: "box-thread",
        target: "orb",
        workspaceSeedId: "workspace-seed-startup",
      },
    ])
    expect(startup.thread).toEqual({ id: "box-thread", target: "orb" })
    expect(startup.creation.runnerTarget).toEqual({ deviceId: "device", checkoutFingerprint: "checkout" })
  }).pipe(Effect.provide(BunServices.layer), Effect.asVoid),
)

it.effect("does not create a Box Thread when Workspace seed staging fails", () =>
  Effect.gen(function* () {
    const requests: Parameters<ProductClient["createThread"]>[0][] = []
    const workspace = yield* seedWorkspace()
    const installed: PreparedInstallation = { ...prepared, workspacePath: workspace }
    const error = yield* prepareOnlineStartup({
      workspace: "/workspace",
      target: "orb",
      callerId: "box-thread",
      deviceId: "device",
      product: {
        identity: Effect.succeed({ userId: "user", ownerId: "owner" }),
        thread: () => Effect.die("Box startup must use the creation receipt"),
        createThread: (request) => {
          requests.push(request)
          return Effect.succeed({ threadId: request.threadId })
        },
      },
      runner: { register: () => Effect.void },
      workspaceSeeds: {
        stage: () => ProductClientError.make({ kind: "network", message: "Workspace staging is unavailable" }),
      },
    }).pipe(
      Effect.provideService(Installation, Installation.of({ prepare: () => Effect.succeed(installed) })),
      Effect.flip,
    )
    expect(error.message).toBe("Workspace staging is unavailable")
    expect(requests).toEqual([])
  }).pipe(Effect.provide(BunServices.layer), Effect.asVoid),
)

it.effect("rejects Runner bindings outside the installed workspace and local executor policy", () =>
  Effect.gen(function* () {
    const binding = {
      workspaceId: "runner:workspace",
      assignmentId: "assignment",
      generation: 1,
      placement: { _tag: "Runner" as const, workspaceId: "runner:workspace", checkoutFingerprint: "checkout" },
      buildId: "runner-build",
      protocolVersion: 1,
    }
    expect(yield* validateRunnerBinding(prepared, binding, { buildId: "runner-build", protocolVersion: 1 })).toEqual(
      binding,
    )
    const mismatchedWorkspace = yield* Effect.flip(
      validateRunnerBinding(
        prepared,
        { ...binding, workspaceId: "other" },
        { buildId: "runner-build", protocolVersion: 1 },
      ),
    )
    expect(mismatchedWorkspace.message).toContain("workspace identity")
    const mismatchedBuild = yield* Effect.flip(
      validateRunnerBinding(prepared, binding, { buildId: "other-build", protocolVersion: 1 }),
    )
    expect(mismatchedBuild.message).toContain("unsupported executor build")
  }),
)

it.effect("uses the current checkout and local Runner for online startup by default", () =>
  Effect.gen(function* () {
    expect(yield* resolveLaunchOptions(options(), "/work/current")).toEqual({
      scenario: "welcome",
      animate: true,
      connection: {
        apiUrl: "https://rika.test",
        workspace: "/work/current",
        target: "runner",
      },
    })
    expect(
      yield* resolveLaunchOptions(options({ workspace: "/work/selected", box: true }), "/work/current"),
    ).toMatchObject({
      connection: { workspace: "/work/selected", target: "orb" },
    })
  }),
)

it.effect("keeps deterministic scenarios behind explicit offline mode", () =>
  Effect.gen(function* () {
    expect(
      yield* resolveLaunchOptions(options({ offline: true, scenario: "streaming", apiUrl: "" }), "/work/current"),
    ).toEqual({ scenario: "streaming", animate: true })
    const missingMode = yield* Effect.flip(resolveLaunchOptions(options({ apiUrl: "" }), "/work/current"))
    expect(missingMode.userMessage).toContain("--api-url")
    expect(missingMode.userMessage).toContain("--offline")
    const mixedMode = yield* Effect.flip(
      resolveLaunchOptions(options({ offline: true, apiUrl: "https://rika.test" }), "/work/current"),
    )
    expect(mixedMode.userMessage).toContain("remove --offline")
  }),
)

it.effect("reopens only the requested Thread without changing its immutable placement", () =>
  Effect.gen(function* () {
    expect(yield* resolveLaunchOptions(options({ thread: "thread-1" }), "/work/current")).toMatchObject({
      connection: { threadId: "thread-1", target: "runner" },
    })
    const conflict = yield* Effect.flip(
      resolveLaunchOptions(options({ thread: "thread-1", box: true }), "/work/current"),
    )
    expect(conflict.userMessage).toContain("already has an execution target")
  }),
)
