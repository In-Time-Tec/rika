import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import * as Listing from "@rika/coding-tools/workspace-directory-listing"
import { provide } from "./test-layer"

describe("workspace directory listing", () => {
  it.effect("returns a bounded structured tree without following a symlink loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-list-" })
        yield* fileSystem.makeDirectory(`${workspace}/src/deep`, { recursive: true })
        yield* fileSystem.makeDirectory(`${workspace}/node_modules/ignored`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/a.ts`, "a")
        yield* fileSystem.writeFileString(`${workspace}/src/deep/b.ts`, "b")
        yield* fileSystem.writeFileString(`${workspace}/node_modules/ignored/index.ts`, "ignored")
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-list-outside-" })
        yield* fileSystem.writeFileString(`${outside}/secret`, "secret")
        yield* fileSystem.symlink(workspace, `${workspace}/src/deep/loop`)
        yield* fileSystem.symlink(outside, `${workspace}/src/deep/outside`)

        const shallow = yield* Listing.list(workspace, ".", { depth: 1 })
        const deep = yield* Listing.list(workspace, ".", { depth: 8 })

        expect(shallow).toMatchObject({
          entries: [{ name: "src", kind: "directory", entries: [] }],
          truncated: true,
        })
        expect(shallow.text).toContain("requested depth 1 hid descendants")
        expect(deep.entries).toEqual([
          {
            name: "src",
            kind: "directory",
            entries: [
              { name: "a.ts", kind: "file" },
              {
                name: "deep",
                kind: "directory",
                entries: [
                  { name: "b.ts", kind: "file" },
                  { name: "loop", kind: "file" },
                  { name: "outside", kind: "file" },
                ],
              },
            ],
          },
        ])
        expect(deep.truncated).toBe(false)
      }),
    ).pipe(provide(BunServices.layer)),
  )

  it.effect("stops at the entry cap and names the recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-list-cap-" })
        for (const name of ["a", "b", "c", "d"]) yield* fileSystem.writeFileString(`${workspace}/${name}`, name)
        const listed = yield* Listing.list(workspace, ".", { depth: 2, maximumEntries: 3 })
        expect(listed.entries.map((entry) => entry.name)).toEqual(["a", "b", "c"])
        expect(listed.truncated).toBe(true)
        expect(listed.text).toContain("entry cap 3 was reached; list a narrower path")
      }),
    ).pipe(provide(BunServices.layer)),
  )
})
