const { existsSync } = process.getBuiltinModule("node:fs")
const { dirname, join } = process.getBuiltinModule("node:path")
const { fileURLToPath } = process.getBuiltinModule("node:url")

/**
 * Resolves the development server entry (apps/server/src/server-main.ts) from
 * any CLI runtime location: source (`apps/rika/src/...`) or the built bundle
 * (`apps/rika/dist/...`). Packaged runtimes use the sibling `.rika-server`
 * binary instead and never call this.
 */
export const devServerEntry = (): string => {
  let directory = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "apps", "server", "src", "server-main.ts")
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return join(import.meta.dir ?? directory, "..", "server-main.ts")
}
