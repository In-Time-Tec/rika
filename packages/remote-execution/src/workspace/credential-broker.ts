import { Redacted } from "effect"

export interface Credential {
  readonly token: Redacted.Redacted<string>
  readonly username: "x-access-token"
  readonly repositoryUrl: string
  readonly expiresAt: number
}

export const ghExecutable =
  Bun.which("gh") ?? Bun.which("gh", { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }) ?? "/usr/bin/gh"

const readOnlyGhWrapper = (executable = ghExecutable, credentialClient?: string) =>
  `#!/bin/sh\nset -eu\nauthenticate() {\n${credentialClient === undefined ? "  :\n" : `  token="$(${credentialClient} github-read)"\n  [ -n "$token" ] || exit 1\n  export GH_TOKEN="$token"\n`}}\ncase "\${1:-}:\${2:-}" in\n  --version:|version:) exec ${executable} "$@" ;;\n  auth:status|repo:view|repo:list|issue:view|issue:list|issue:status|pr:view|pr:list|pr:checks|pr:status|pr:diff|search:*) authenticate; exec ${executable} "$@" ;;\n  api:*)\n    shift\n    for value in "$@"; do\n      case "$value" in graphql|-X*|--method*|-f*|-F*|--field*|--raw-field*|--input*|--hostname*) echo 'write-capable gh api arguments are disabled' >&2; exit 2 ;; esac\n    done\n    authenticate\n    exec ${executable} api --method GET "$@" ;;\n  *) echo 'only read-only gh operations are enabled' >&2; exit 2 ;;\nesac\n`

const credentialClientSource = (socketPath: string) =>
  `#!/usr/bin/env bun
const { exit, stdout } = process
const operation = process.argv[2] ?? ""
if (operation !== "git-read" && operation !== "github-read" && operation !== "branch-push") exit(2)
let response = ""
const timeout = setTimeout(() => exit(1), 5000)
await Bun.connect({
  unix: ${JSON.stringify(socketPath)},
  socket: {
    open(socket) { socket.write(operation) },
    data(_socket, data) { response += new TextDecoder().decode(data) },
    close() { clearTimeout(timeout); stdout.write(response) },
    error() { clearTimeout(timeout); exit(1) },
  },
})
`

const listen = (
  socketPath: string,
  credential: (purpose: "git-read" | "github-read" | "branch-push") => Credential | undefined,
) =>
  Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        const operation = new TextDecoder().decode(data).trim()
        if (operation !== "git-read" && operation !== "github-read" && operation !== "branch-push") {
          socket.end()
          return
        }
        const current = credential(operation)
        if (current === undefined) {
          socket.end()
          return
        }
        const token = Redacted.value(current.token)
        socket.end(operation === "github-read" ? token : `username=${current.username}\npassword=${token}\n\n`)
      },
    },
  })

export const CredentialBroker = { clientSource: credentialClientSource, listen, readOnlyGhWrapper } as const
