import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { SkillRegistry } from "../src"
import { provideLayer } from "./layer"

const document = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

it("discovers overrides and activates sorted files while ignoring directories and manifests", () =>
  Effect.runPromise(
    Effect.scoped(
      provideLayer(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-" })
          const globalRoot = `${root}/global`
          const workspaceRoot = `${root}/workspace`
          yield* fileSystem.makeDirectory(`${globalRoot}/review`, { recursive: true })
          yield* fileSystem.makeDirectory(`${globalRoot}/empty`, { recursive: true })
          yield* fileSystem.makeDirectory(`${workspaceRoot}/review/references`, { recursive: true })
          yield* fileSystem.writeFileString(
            `${globalRoot}/review/SKILL.md`,
            document("review", "global", "global body"),
          )
          yield* fileSystem.writeFileString(`${globalRoot}/empty/SKILL.md`, document("empty", "empty", "empty body"))
          yield* fileSystem.writeFileString(
            `${workspaceRoot}/review/SKILL.md`,
            document("review", "workspace", "workspace body"),
          )
          yield* fileSystem.writeFileString(`${workspaceRoot}/review/z.txt`, "z")
          yield* fileSystem.writeFileString(`${workspaceRoot}/review/a.txt`, "a")
          const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot, descriptionCap: 20 })
          const selected = yield* registry.source.get("review")
          const activated = yield* registry.activate("review")
          const empty = yield* registry.activate("empty")
          expect(registry.listings).toEqual(["- empty: empty", "- review: workspace"])
          expect(selected?.frontmatter.description).toBe("workspace")
          expect(activated).toEqual({
            body: "workspace body",
            resources: [
              { path: "a.txt", content: "a" },
              { path: "z.txt", content: "z" },
            ],
          })
          expect(empty).toEqual({ body: "empty body", resources: [] })
          expect(registry.digest).toHaveLength(64)
        }),
        Layer.merge(SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
      ),
    ),
  ))

it("returns a typed missing activation error through the test filesystem", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const error = yield* provideLayer(
        Effect.gen(function* () {
          const registry = yield* SkillRegistry.discover({ globalRoot: "/global", workspaceRoot: "/workspace" })
          return yield* Effect.flip(registry.activate("missing"))
        }),
        Layer.merge(
          SkillRegistry.fileSystemTestLayer({}, {}).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      )
      expect(error.operation).toBe("activate")
      expect(error.path).toBe("missing")
    }),
  ))

it("activates a discovered skill with no resource directory", () =>
  Effect.runPromise(
    Effect.scoped(
      provideLayer(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-missing-resources-" })
          const globalRoot = `${root}/global`
          const workspaceRoot = `${root}/workspace`
          yield* fileSystem.makeDirectory(`${globalRoot}/plain`, { recursive: true })
          yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true })
          yield* fileSystem.writeFileString(`${globalRoot}/plain/SKILL.md`, document("plain", "plain", "body"))
          const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
          expect(yield* registry.activate("plain")).toEqual({ body: "body", resources: [] })
        }),
        Layer.merge(
          SkillRegistry.fileSystemTestLayer({}, {}).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    ),
  ))
