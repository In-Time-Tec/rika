import { describe, expect, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Redacted, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RepositoryTransport, layerGitHubRepositoryTransport } from "../src/repository"

describe("GitHub repository transport", () => {
  it.effect("keeps authentication in scoped Git config and sanitizes failures", () => {
    const commands: Array<ChildProcess.Command> = []
    let exitCode = 0
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          commands.push(command)
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.sync(() => ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      ),
    )
    const token = "github-installation-private-token"
    const layer = layerGitHubRepositoryTransport({
      token: Redacted.make(token),
      fetchTimeout: "5 seconds",
    }).pipe(Layer.provide(spawner))
    return Effect.scoped(
      Layer.build(layer).pipe(
        Effect.flatMap((context) =>
          Effect.provide(
            Effect.gen(function* () {
              const transport = yield* RepositoryTransport
              const request = {
                directory: "/safe/repository.git",
                source: { owner: "example-owner", name: "example-repository" },
                commitSha: "a".repeat(40),
              }
              yield* transport.fetch(request)
              const command = commands[0]!
              expect(command._tag).toBe("StandardCommand")
              if (command._tag !== "StandardCommand") return
              expect(command.command).toBe("sh")
              expect(command.args).toContain("--no-tags")
              expect(command.args).toContain("--depth=1")
              expect(command.args).toContain("https://github.com/example-owner/example-repository.git")
              expect(command.args).toContain(`${request.commitSha}:refs/heads/rika-input`)
              expect(command.args).toContain("131072")
              expect(command.args.join(" ")).not.toContain(token)
              expect(command.args.join(" ")).not.toContain("AUTHORIZATION")
              const environment = command.options.env!
              expect(command.options.extendEnv).toBe(false)
              expect(environment.PATH).toBe("/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin")
              expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null")
              expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1")
              expect(environment.GIT_TERMINAL_PROMPT).toBe("0")
              expect(environment.GIT_ASKPASS).toBe("/bin/false")
              const count = Number(environment.GIT_CONFIG_COUNT)
              const configuration = Array.from({ length: count }, (_, index) => [
                environment[`GIT_CONFIG_KEY_${index}`],
                environment[`GIT_CONFIG_VALUE_${index}`],
              ])
              expect(configuration).toContainEqual(["credential.helper", ""])
              expect(configuration).toContainEqual(["core.hooksPath", "/dev/null"])
              expect(configuration).toContainEqual(["protocol.ext.allow", "never"])
              expect(configuration).toContainEqual(["protocol.file.allow", "never"])
              expect(configuration).toContainEqual([
                "http.https://github.com/.extraHeader",
                `AUTHORIZATION: basic ${Encoding.encodeBase64(`x-access-token:${token}`)}`,
              ])

              exitCode = 1
              const error = yield* Effect.flip(transport.fetch(request))
              expect(error.kind).toBe("git")
              expect(error.message).not.toContain(token)
              const failed = commands[1]!
              if (failed._tag === "StandardCommand") expect(failed.args.join(" ")).not.toContain(token)
            }),
            context,
          ),
        ),
      ),
    )
  })
})
