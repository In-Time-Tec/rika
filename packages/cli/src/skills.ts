import { SkillRegistry } from "@rika/agent"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"
import * as SkillInstaller from "./skill-installer"

export class SkillsError extends Schema.TaggedErrorClass<SkillsError>()("SkillsError", {
  message: Schema.String,
  action: Args.SkillAction,
}) {}

export type RunError = SkillInstaller.SkillInstallerError | SkillRegistry.SkillRegistryError | SkillsError

export interface Interface {
  readonly executeCommand: (command: Args.SkillCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Skills") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const skills = yield* SkillRegistry.Service
    const installer = yield* SkillInstaller.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Skills.executeCommand")(function* (command: Args.SkillCommand) {
        switch (command.action) {
          case "list": {
            const summaries = yield* skills.list()
            yield* output.stdout(formatJson(summaries))
            return 0
          }
          case "inspect": {
            const skill = yield* skills.inspect(yield* requireName(command))
            yield* output.stdout(formatJson(skill))
            return 0
          }
          case "add": {
            const result = yield* installer.install({
              source: yield* requireSource(command),
              scope: command.user === true ? "user" : "project",
              force: command.force === true,
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
          case "remove": {
            const result = yield* installer.remove({
              name: yield* requireName(command),
              scope: command.user === true ? "user" : "project",
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
        }
        return yield* new SkillsError({ message: "Unsupported skill action", action: command.action })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Skills.executeCommand.call")(function* (command: Args.SkillCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof SkillsError) return error.message
  if (error instanceof SkillInstaller.SkillInstallerError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireName = (command: Args.SkillCommand) =>
  command.name === undefined
    ? Effect.fail(new SkillsError({ message: `Skill name is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.name)

const requireSource = (command: Args.SkillCommand) =>
  command.source === undefined
    ? Effect.fail(
        new SkillsError({ message: `Skill source is required for ${command.action}`, action: command.action }),
      )
    : Effect.succeed(command.source)

const formatJson = (value: unknown) => JSON.stringify(value)
