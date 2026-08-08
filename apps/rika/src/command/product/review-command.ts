import * as ProductOperation from "@rika/product/product-operation"
import { modeIds, type ModeId } from "@rika/config/behavior-mode"
import { Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation-dispatch"

const mode = Flag.choice("mode", modeIds).pipe(Flag.withAlias("m"), Flag.optional)
const workspace = Flag.directory("workspace").pipe(Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const prompt = Argument.variadic(Argument.string("prompt"))

const optionalValue = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)

export const reviewCommand = Command.make("review", { mode, workspace, thread, prompt }, (values) => {
  const selectedMode: ModeId | undefined = optionalValue(values.mode)
  const selectedWorkspace = optionalValue(values.workspace)
  const selectedThread = optionalValue(values.thread)
  const input: ProductOperation.Input = {
    _tag: "Review",
    prompt: values.prompt,
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
    ephemeral: false,
  }
  return dispatch(input)
}).pipe(Command.withDescription("Run correctness, security, and quality reviews"))
