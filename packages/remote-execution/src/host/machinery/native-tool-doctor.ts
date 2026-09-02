import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Layer } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as NativeToolSubprocess from "./native-tool-subprocess"

const doctor = Effect.fn("NativeToolDoctor.check")(function* (workspace: string) {
  const nativeTool = yield* NativeToolSubprocess.make({
    workspace,
    workspaceUser: "rika-workspace",
    environment: { RIKA_NATIVE_TOOL_DOCTOR: "native-tool-environment" },
  })
  const edited = yield* nativeTool.execute({
    _tag: "Edit",
    path: "existing.txt",
    oldStr: "before",
    newStr: "after",
  })
  const written = yield* nativeTool.execute({
    _tag: "Bash",
    command: "printf created-by-native-tool > created.txt",
  })
  const identity = yield* nativeTool.execute({
    _tag: "Bash",
    command: 'printf "%s:%s" "$(id -un)" "$RIKA_NATIVE_TOOL_DOCTOR"',
  })
  const identityText =
    identity._tag === "Success" && identity.value._tag === "NativeTool" ? identity.value.result.text : ""
  if (
    edited._tag !== "Success" ||
    written._tag !== "Success" ||
    identityText !== "rika-workspace:native-tool-environment"
  )
    return yield* Effect.die("native tool subprocess doctor failed")
  yield* Console.log(identityText)
})

const command = Command.make("native-tool-doctor", { workspace: Argument.string("workspace") }, ({ workspace }) =>
  doctor(workspace),
)
const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
