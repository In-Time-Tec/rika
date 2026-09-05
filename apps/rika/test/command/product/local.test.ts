import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import type { Input } from "@rika/product/product-operation"
import { Service } from "@rika/product/product-operation-service"
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { run } from "../../../src/command/root/rika"
import { run as runClient } from "../../../src/client/process"
import * as Local from "../../../src/client/local-operations"
import { provideLayerScoped } from "../../../src/platform/provide"

const cases: ReadonlyArray<readonly [ReadonlyArray<string>, Input]> = [
  [["doctor"], { _tag: "Doctor" }],
  [["config", "list"], { _tag: "Config", action: "list" }],
  [["config", "keymap"], { _tag: "Config", action: "keymap" }],
  [["config", "edit"], { _tag: "Config", action: "edit", workspace: false }],
  [["config", "edit", "--workspace"], { _tag: "Config", action: "edit", workspace: true }],
  [["tools", "list"], { _tag: "ToolCatalog", action: "list" }],
  [["tools", "show", "read"], { _tag: "ToolCatalog", action: "show", name: "read" }],
  [["skills", "list"], { _tag: "Skill", action: "list" }],
  [["skills", "add", "/tmp/skill"], { _tag: "Skill", action: "add", source: "/tmp/skill" }],
  ...(["inspect", "remove"] as const).map((action): readonly [ReadonlyArray<string>, Input] => [
    ["skills", action, "example"],
    { _tag: "Skill", action, name: "example" },
  ]),
  [["extensions", "list"], { _tag: "Extension", action: "list" }],
  ...(["enable", "disable", "rollback"] as const).map((action): readonly [ReadonlyArray<string>, Input] => [
    ["extensions", action, "example"],
    { _tag: "Extension", action, name: "example" },
  ]),
  ...(["list", "doctor"] as const).map((action): readonly [ReadonlyArray<string>, Input] => [
    ["mcp", action],
    { _tag: "Mcp", action },
  ]),
  [
    ["mcp", "add", "remote", "--url", "https://example.com/mcp"],
    { _tag: "Mcp", action: "add", name: "remote", url: "https://example.com/mcp" },
  ],
  [
    ["mcp", "add", "local", "--", "node", "--version"],
    { _tag: "Mcp", action: "add", name: "local", command: ["node", "--version"] },
  ],
  ...(["remove", "enable", "disable", "oauth-login", "oauth-logout"] as const).map(
    (action): readonly [ReadonlyArray<string>, Input] => [
      ["mcp", action, "example"],
      { _tag: "Mcp", action, name: "example" },
    ],
  ),
  [["mcp", "oauth-status"], { _tag: "Mcp", action: "oauth-status" }],
  [["mcp", "oauth-status", "remote"], { _tag: "Mcp", action: "oauth-status", name: "remote" }],
]

for (const [argv, expected] of cases) {
  it.effect(`dispatches ${argv.join(" ")}`, () =>
    Effect.gen(function* () {
      const calls: Array<Input> = []
      yield* run(argv).pipe(
        Effect.provideService(
          Service,
          Service.of({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          }),
        ),
      )
      expect(calls).toEqual([expected])
    }).pipe(provideLayerScoped(Layer.merge(BunServices.layer, FetchHttpClient.layer)), Effect.scoped),
  )
}

for (const argv of [
  ["mcp", "add", "missing"],
  ["mcp", "add", "mixed", "--url", "https://example.com", "node"],
  ["tools", "show"],
  ["skills", "inspect"],
  ["extensions", "create-plugin", "x"],
]) {
  it.effect(`rejects ${argv.join(" ")} without dispatch`, () =>
    Effect.gen(function* () {
      let dispatched = false
      const exit = yield* Effect.exit(
        run(argv).pipe(
          Effect.provideService(
            Service,
            Service.of({
              run: () =>
                Effect.sync(() => {
                  dispatched = true
                }),
            }),
          ),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(dispatched).toBe(false)
    }).pipe(provideLayerScoped(Layer.merge(BunServices.layer, FetchHttpClient.layer)), Effect.scoped),
  )
}

it.effect("runs doctor and tools through the real client dispatcher and rejects unknown tools", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    yield* Effect.gen(function* () {
      yield* runClient(["doctor"])
      yield* runClient(["tools", "list"])
      const output = (yield* TestConsole.logLines).join("\n")
      expect(output).toContain('"global": "missing"')
      expect(output).toContain('"name":"shell_command_status"')
      expect(Exit.isFailure(yield* Effect.exit(runClient(["tools", "show", "missing"])))).toBe(true)
      expect((yield* TestConsole.errorLines).join("\n")).toContain("Tool missing does not exist")
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HOME: home } })))
  }).pipe(
    provideLayerScoped(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, TestConsole.layer)),
    Effect.scoped,
  ),
)

it.effect("uses real workspace MCP and extension storage, including duplicate and malformed failures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* fs.makeTempDirectoryScoped()
    yield* Local.run({
      _tag: "Mcp",
      action: "add",
      name: "local",
      command: ["node", "--version"],
      clientWorkspace: workspace,
    })
    expect(
      yield* fs
        .readFileString(`${workspace}/.rika/mcp.json`)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)))),
    ).toMatchObject({ servers: { local: { command: "node" } } })
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          Local.run({ _tag: "Mcp", action: "add", name: "local", command: ["node"], clientWorkspace: workspace }),
        ),
      ),
    ).toBe(true)
    yield* Local.run({ _tag: "Mcp", action: "disable", name: "local", clientWorkspace: workspace })
    expect(
      yield* fs
        .readFileString(`${workspace}/.rika/mcp.json`)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)))),
    ).toMatchObject({ disabled: ["local"] })
    yield* Local.run({ _tag: "Extension", action: "enable", name: "example", clientWorkspace: workspace })
    expect(
      yield* fs
        .readFileString(`${workspace}/.rika/extensions.json`)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)))),
    ).toMatchObject({ extensions: { example: { enabled: true } } })
    yield* fs.writeFileString(`${workspace}/.rika/mcp.json`, "broken")
    expect(
      Exit.isFailure(yield* Effect.exit(Local.run({ _tag: "Mcp", action: "doctor", clientWorkspace: workspace }))),
    ).toBe(true)
  }).pipe(provideLayerScoped(BunServices.layer), Effect.scoped),
)

it.effect("discovers and inspects a real workspace skill through local composition", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspace = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${workspace}/.rika/skills/example`, { recursive: true })
    yield* fs.writeFileString(
      `${workspace}/.rika/skills/example/SKILL.md`,
      "---\nname: example\ndescription: Test fixture\n---\nFixture instructions.\n",
    )
    yield* Local.run({ _tag: "Skill", action: "list", clientWorkspace: workspace })
    yield* Local.run({ _tag: "Skill", action: "inspect", name: "example", clientWorkspace: workspace })
    expect((yield* TestConsole.logLines).join("\n")).toContain("Fixture instructions")
  }).pipe(provideLayerScoped(Layer.merge(BunServices.layer, TestConsole.layer)), Effect.scoped),
)
