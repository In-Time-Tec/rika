import type { FileCredentialAuth } from "@rika/client/credentials"
import type { ThreadCreationOptions } from "@rika/tui-v2/src/client/threads"
import type { Crypto, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

interface ConnectedTuiOptions {
  readonly scenario: "welcome"
  readonly animate: boolean
  readonly connection: {
    readonly apiUrl: string
    readonly workspace: string
    readonly target: "runner"
    readonly auth: FileCredentialAuth
    readonly creation: ThreadCreationOptions
    readonly threadId?: string
    readonly initialPrompt?: string
  }
}

interface ConnectedTui {
  readonly launch: (
    options: ConnectedTuiOptions,
  ) => Effect.Effect<
    void,
    { readonly message: string },
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >
}

export declare const loadConnectedTui: Effect.Effect<ConnectedTui, { readonly message: string }>
