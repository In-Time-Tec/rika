import { HostFiles } from "./host-files"

export interface Isolation {
  readonly root: string
  readonly cwd: string
  readonly home: string
  readonly temporary: string
  readonly batonDatabase: string
  readonly environment: Readonly<Record<string, string>>
}

export const make = (root: string): Isolation => {
  const absolute = HostFiles.resolve(root)
  const home = HostFiles.join(absolute, "home")
  const temporary = HostFiles.join(absolute, "tmp")
  const cwd = HostFiles.join(absolute, "cwd")
  const batonDatabase = HostFiles.join(absolute, "baton.db")
  return {
    root: absolute,
    cwd,
    home,
    temporary,
    batonDatabase,
    environment: {
      HOME: home,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: HostFiles.join(home, ".config"),
      XDG_DATA_HOME: HostFiles.join(home, ".local", "share"),
      RIKA_DATABASE: HostFiles.join(absolute, "rika.db"),
      RIKA_BATON_DATABASE: batonDatabase,
      BUN_INSTALL_CACHE_DIR: HostFiles.join(absolute, "bun-cache"),
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
  }
}

export const assertSafe = (input: { readonly isolation: Isolation; readonly userHome?: string }): void => {
  const { isolation, userHome = "" } = input
  const forbidden = `${userHome}/.rika`
  for (const path of [isolation.root, isolation.cwd, isolation.home, isolation.temporary, isolation.batonDatabase]) {
    if (!path.startsWith(`${isolation.root}/`) && path !== isolation.root)
      throw new Error(`path escaped isolation: ${path}`)
    if (forbidden.length > "/.rika".length && (path === forbidden || path.startsWith(`${forbidden}/`)))
      throw new Error(`benchmark path enters ~/.rika: ${path}`)
  }
}
