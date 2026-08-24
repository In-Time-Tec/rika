import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Browser, HostedError } from "./contract"

const browserCommand = (platform: NodeJS.Platform, url: string) => {
  if (platform === "darwin") return { executable: "open", arguments: [url] }
  if (platform === "win32") return { executable: "cmd", arguments: ["/c", "start", "", url] }
  return { executable: "xdg-open", arguments: [url] }
}

export const layer = (platform: NodeJS.Platform = process.platform) =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return Browser.of({
        open: Effect.fn("HostedBrowser.open")(function* (url) {
          const command = browserCommand(platform, url)
          const exitCode = yield* Effect.scoped(
            spawner
              .spawn(
                ChildProcess.make(command.executable, command.arguments, {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              )
              .pipe(Effect.flatMap((child) => child.exitCode)),
          ).pipe(Effect.mapError(() => HostedError.make({ kind: "host", message: "Could not open a browser" })))
          if (exitCode !== 0) return yield* HostedError.make({ kind: "host", message: "Could not open a browser" })
        }),
      })
    }),
  )
