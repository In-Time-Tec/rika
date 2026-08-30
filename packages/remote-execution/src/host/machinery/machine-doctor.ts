import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Layer } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as MachineProcess from "./machine-process"

const doctor = Effect.fn("MachineDoctor.check")(function* (workspace: string) {
  const machine = yield* MachineProcess.make({
    workspace,
    workspaceUser: "rika-workspace",
    environment: { RIKA_MACHINE_DOCTOR: "machine-environment" },
  })
  const edited = yield* machine.execute({
    _tag: "CodingTool",
    request: { _tag: "Edit", path: "existing.txt", oldStr: "before", newStr: "after" },
  })
  const written = yield* machine.execute({
    _tag: "CodingTool",
    request: { _tag: "Write", path: "created.txt", content: "created-by-machine" },
  })
  const identity = yield* machine.execute({
    _tag: "CodingTool",
    request: { _tag: "Bash", command: 'printf "%s:%s" "$(id -un)" "$RIKA_MACHINE_DOCTOR"' },
  })
  const identityText =
    identity._tag === "Success" && identity.value._tag === "CodingTool" ? identity.value.result.text : ""
  if (edited._tag !== "Success" || written._tag !== "Success" || identityText !== "rika-workspace:machine-environment")
    return yield* Effect.die("workspace machine doctor failed")
  yield* Console.log(identityText)
})

const command = Command.make("machine-doctor", { workspace: Argument.string("workspace") }, ({ workspace }) =>
  doctor(workspace),
)
const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
