import { Effect, Path } from "effect"

const exists = (filename: string) => process.getBuiltinModule("node:fs").existsSync(filename)

/**
 * Resolves the development server entry (apps/server/src/server-main.ts) from
 * any CLI runtime location: source (`apps/rika/src/...`) or the built bundle
 * (`apps/rika/dist/...`). Packaged runtimes use the sibling `.rika-server`
 * binary instead and never call this.
 */
export const devServerEntry = Effect.fn("ServerEntry.dev")(function* () {
  const path = yield* Path.Path
  let directory = import.meta.dir
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, "apps", "server", "src", "server-main.ts")
    if (exists(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return path.join(import.meta.dir, "..", "server-main.ts")
})
