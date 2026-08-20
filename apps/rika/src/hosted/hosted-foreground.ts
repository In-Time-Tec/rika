import { BoxRenderable, InputRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
import { Deferred, Effect, Fiber, FiberSet, Layer } from "effect"
import {
  ForegroundLocalExecutorError,
  foregroundLocalExecutorLayer,
  runForegroundLocalExecutor,
} from "@rika/remote-execution/foreground"
import type { Input } from "../command/root/hosted-command-dispatch"
import * as HostedAccount from "./hosted-account"
import {
  CredentialStore,
  HostedError,
  Http,
  LocalExecutorReceiptStore,
  ProfileStore,
  type LocalExecutorAdmission,
  type RunRequest,
} from "./hosted-contract"

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })

type ForegroundInput = Extract<Input, { readonly _tag: "LocalForeground" }>
type HostedServices =
  | import("effect").Crypto.Crypto
  | Http
  | CredentialStore
  | LocalExecutorReceiptStore
  | ProfileStore

const append = (transcript: TextRenderable, line: string) => {
  transcript.content = `${transcript.content.toString()}${transcript.content.toString().length === 0 ? "" : "\n"}${line}`
}

const makeUi = (input: { readonly threadId: string }) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    const requests = yield* FiberSet.make<unknown, unknown>()
    const runFork = yield* FiberSet.runtime(requests)<HostedServices>()
    const renderer = yield* Effect.tryPromise({
      try: () =>
        createCliRenderer({
          screenMode: "alternate-screen",
          exitOnCtrlC: false,
          exitSignals: [],
          useMouse: false,
          consoleMode: "disabled",
        }),
      catch: () => failure("host", "Could not open the foreground terminal"),
    })
    yield* Effect.sync(() => {
      const complete = () => {
        runFork(Deferred.succeed(done, undefined))
      }
      const root = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      })
      const transcript = new TextRenderable(renderer, {
        content: `Hosted local thread ${input.threadId}\nWorkspace executor connected for this foreground session.\nType a shell command, or quit.`,
        flexGrow: 1,
        wrapMode: "word",
      })
      const inputBox = new BoxRenderable(renderer, {
        border: true,
        borderStyle: "rounded",
        paddingLeft: 1,
        paddingRight: 1,
      })
      const command = new InputRenderable(renderer, { placeholder: "shell command (quit to exit)" })
      inputBox.add(command)
      root.add(transcript)
      root.add(inputBox)
      renderer.root.add(root)
      const addResult = (value: string) => {
        append(transcript, value)
        renderer.requestRender()
      }
      const submit = () => {
        const line = command.value.trim()
        command.value = ""
        if (line.length === 0) return
        if (line === "quit" || line === "exit") return complete()
        addResult(`> ${line}`)
        const request: RunRequest = { prompt: [line] }
        runFork(
          HostedAccount.runThreadOperation(input.threadId, request).pipe(
            Effect.match({
              onFailure: (error) => addResult(`Error: ${String(error)}`),
              onSuccess: (result) => addResult(result.output),
            }),
          ),
        )
      }
      command.on("enter", submit)
      renderer.keyInput.on("keypress", (event) => {
        if (event.ctrl && event.name.toLowerCase() === "c") {
          event.preventDefault()
          complete()
        }
      })
      command.focus()
      renderer.requestRender()
    })
    return { renderer, done, requests }
  })

/**
 * A deliberately small OpenTUI shell. The remote executor owns the only
 * process that can touch the workspace. This UI owns the outbound scope and
 * never serializes its workspace path or admission ticket.
 */
const openTui = (input: { readonly threadId: string }) =>
  Effect.acquireUseRelease(
    makeUi({ threadId: input.threadId }),
    (ui) => Deferred.await(ui.done),
    (ui) =>
      FiberSet.clear(ui.requests).pipe(
        Effect.andThen(FiberSet.awaitEmpty(ui.requests)),
        Effect.andThen(Effect.sync(() => ui.renderer.destroy())),
      ),
  )

export const run = Effect.fn("HostedForeground.run")((input: ForegroundInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspacePath = input.workspace ?? process.cwd()
      const prepared = yield* HostedAccount.prepareLocalExecutor(input.threadId)
      const services = yield* Effect.context<HostedServices>()
      const receipts = yield* LocalExecutorReceiptStore
      const executorServices = yield* Layer.build(foregroundLocalExecutorLayer)
      // The runner is scoped to this public CLI process. Closing the UI closes
      // the WSS connection only; it does not cancel the durable hosted thread.
      const ready = yield* Deferred.make<void, ForegroundLocalExecutorError>()
      const runner = yield* runForegroundLocalExecutor({
        ...(prepared.admission === undefined ? {} : { admission: prepared.admission as LocalExecutorAdmission }),
        ...(prepared.resume === undefined ? {} : { resume: prepared.resume }),
        workspacePath,
        trustedOrigin: prepared.origin,
        receiptStore: {
          save: (scope, snapshot) =>
            receipts.save(scope, snapshot).pipe(
              Effect.mapError((error) => ForegroundLocalExecutorError.make({ message: error.message })),
            ),
        },
        receiptScope: prepared.scope,
        ready,
      }).pipe(
        Effect.provide(executorServices),
        Effect.mapError((error) => failure("network", error.message)),
        Effect.forkScoped,
      )
      // Do not claim a usable executor until the controller accepted its hello.
      yield* Deferred.await(ready).pipe(Effect.mapError((error) => failure("network", error.message)))
      yield* Effect.raceFirst(
        openTui({ threadId: prepared.threadId }).pipe(Effect.provideContext(services)),
        Fiber.join(runner),
      )
    }),
  ),
)
