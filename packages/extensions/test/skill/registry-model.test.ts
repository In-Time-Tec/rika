import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as SkillFileSystem from "../../src/skill/file-system"
import { provideLayer } from "../support/extension-test-layer"

const document = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

const manifest = (value: Schema.JsonObject) => JSON.stringify(value)

const platform = Layer.merge(SkillFileSystem.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer)

const withRoots = <A, E>(
  build: (roots: {
    readonly globalRoot: string
    readonly workspaceRoot: string
  }) => Effect.Effect<A, E, FileSystem.FileSystem | SkillFileSystem.SkillFileSystem>,
) =>
  Effect.runPromise(
    Effect.scoped(
      provideLayer(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-executable-skills-" })
          const globalRoot = `${root}/global`
          const workspaceRoot = `${root}/workspace`
          yield* fileSystem.makeDirectory(globalRoot, { recursive: true })
          yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true })
          return yield* build({ globalRoot, workspaceRoot })
        }),
        platform,
      ),
    ),
  )

it("reports an instruction-only skill with no executable entry", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/notes`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/notes/SKILL.md`, document("notes", "note taking", "body"))
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(discovered.listings).toEqual(["- notes: note taking"])
      expect(discovered.executable).toEqual([])
      expect(discovered.executableDigest).toHaveLength(64)
    }),
  ))

it("discovers a TypeScript-backed skill package and derives its import name", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/search`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/search/SKILL.md`, document("search", "searches", "body"))
      yield* fileSystem.writeFileString(
        `${globalRoot}/search/package.json`,
        manifest({ name: "@skills/search", rika: { kind: "skill" } }),
      )
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(discovered.executable).toHaveLength(1)
      expect(discovered.executable[0]?.name).toBe("search")
      expect(discovered.executable[0]?.importName).toBe("@skills/search")
      expect(discovered.executable[0]?.origin).toBe("global")
      expect(discovered.executable[0]?.importable).toBe(true)
      expect(discovered.executable[0]?.digest).toHaveLength(64)
    }),
  ))

it("prefers an explicit importName over the package name", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/search`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/search/SKILL.md`, document("search", "searches", "body"))
      yield* fileSystem.writeFileString(
        `${globalRoot}/search/package.json`,
        manifest({ name: "@skills/search", rika: { kind: "skill", importName: "rika-search" } }),
      )
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(discovered.executable[0]?.importName).toBe("rika-search")
    }),
  ))

it("ignores a package.json without the Rika skill field", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/plain`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/plain/SKILL.md`, document("plain", "plain", "body"))
      yield* fileSystem.writeFileString(`${globalRoot}/plain/package.json`, manifest({ name: "plain" }))
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(discovered.executable).toEqual([])
    }),
  ))

it("fails typed when a skill package manifest is not JSON", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/broken`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/broken/SKILL.md`, document("broken", "broken", "body"))
      yield* fileSystem.writeFileString(`${globalRoot}/broken/package.json`, "{")
      const error = yield* Effect.flip(SkillRegistry.discover({ globalRoot, workspaceRoot }))
      expect(error.operation).toBe("discover")
      expect(error.path).toBe(`${globalRoot}/broken/package.json`)
    }),
  ))

it("keeps Workspace precedence and reports the winning origin", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/review`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/review`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/review/SKILL.md`, document("review", "global", "global body"))
      yield* fileSystem.writeFileString(
        `${globalRoot}/review/package.json`,
        manifest({ name: "global-review", rika: { kind: "skill" } }),
      )
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/review/SKILL.md`,
        document("review", "workspace", "workspace body"),
      )
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/review/package.json`,
        manifest({ name: "workspace-review", rika: { kind: "skill" } }),
      )
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot, workspaceTrusted: true })
      expect(discovered.listings).toEqual(["- review: workspace"])
      expect(discovered.executable).toHaveLength(1)
      expect(discovered.executable[0]?.importName).toBe("workspace-review")
      expect(discovered.executable[0]?.origin).toBe("workspace")
    }),
  ))

it("lists an untrusted Workspace executable skill without making it importable", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${workspaceRoot}/local`, { recursive: true })
      yield* fileSystem.writeFileString(`${workspaceRoot}/local/SKILL.md`, document("local", "local", "body"))
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/local/package.json`,
        manifest({ name: "local-skill", rika: { kind: "skill" } }),
      )
      const untrusted = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      const trusted = yield* SkillRegistry.discover({ globalRoot, workspaceRoot, workspaceTrusted: true })
      expect(untrusted.executable[0]?.importable).toBe(false)
      expect(trusted.executable[0]?.importable).toBe(true)
      expect(untrusted.executableDigest).not.toBe(trusted.executableDigest)
    }),
  ))

it("changes the executable digest when a skill package changes and not when only a body changes", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(`${globalRoot}/tool`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/tool/SKILL.md`, document("tool", "tool", "first body"))
      yield* fileSystem.writeFileString(
        `${globalRoot}/tool/package.json`,
        manifest({ name: "tool", version: "1.0.0", rika: { kind: "skill" } }),
      )
      const first = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      yield* fileSystem.writeFileString(`${globalRoot}/tool/SKILL.md`, document("tool", "tool", "second body"))
      const afterBody = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      yield* fileSystem.writeFileString(
        `${globalRoot}/tool/package.json`,
        manifest({ name: "tool", version: "2.0.0", rika: { kind: "skill" } }),
      )
      const afterManifest = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(afterBody.executableDigest).toBe(first.executableDigest)
      expect(afterManifest.executableDigest).not.toBe(first.executableDigest)
    }),
  ))

it("keeps executable entries in canonical skill order", () =>
  withRoots(({ globalRoot, workspaceRoot }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      for (const name of ["zulu", "alpha", "mike"]) {
        yield* fileSystem.makeDirectory(`${globalRoot}/${name}`, { recursive: true })
        yield* fileSystem.writeFileString(`${globalRoot}/${name}/SKILL.md`, document(name, name, "body"))
        yield* fileSystem.writeFileString(
          `${globalRoot}/${name}/package.json`,
          manifest({ name, rika: { kind: "skill" } }),
        )
      }
      const discovered = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
      expect(discovered.executable.map((entry) => entry.name)).toEqual(["alpha", "mike", "zulu"])
    }),
  ))
