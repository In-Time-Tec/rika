import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { defaultBuildLogger, Template } from "e2b"
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"

const TemplateIdentity = Schema.Struct({
  templateId: Schema.NonEmptyString,
  buildId: Schema.NonEmptyString,
})
const encodeTemplateIdentity = Schema.encodeEffect(Schema.fromJsonString(TemplateIdentity))

class ImageTemplateError extends Schema.TaggedError<ImageTemplateError>()("ImageTemplateError", {
  message: Schema.String,
}) {}

export const createImageTemplate = Effect.fn("ExecutorImageTemplate.create")(function* (image: string, alias: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const username = yield* Config.string("GHCR_USERNAME")
  const password = yield* Config.redacted("GHCR_PASSWORD")
  const apiKey = yield* Config.redacted("E2B_API_KEY")
  const createRuntimeDirectory =
    "/usr/bin/install -d -m 2750 -o rika-executor -g rika-workspace /run/rika"
  const template = Template()
    .fromImage(image, { username, password: Redacted.value(password) })
    .runCmd(
      `printf 'rika-executor ALL=(root) NOPASSWD: ${createRuntimeDirectory}\n' > /etc/sudoers.d/rika-runtime && chmod 0440 /etc/sudoers.d/rika-runtime`,
      { user: "root" },
    )
    .setUser("rika-executor")
    .setStartCmd(
      `sudo -n ${createRuntimeDirectory} && exec /opt/rika/start.sh`,
      "curl --fail --silent http://127.0.0.1:7070/health",
    )
  const built = yield* Effect.tryPromise({
    try: () =>
      Template.build(template, alias, {
        apiKey: Redacted.value(apiKey),
        onBuildLogs: defaultBuildLogger({ minLevel: "debug" }),
      }),
    catch: (cause) =>
      ImageTemplateError.make({
        message: cause instanceof Error ? cause.message : "E2B private image template build failed",
      }),
  })
  const identity = yield* Schema.decodeUnknownEffect(TemplateIdentity)(built)
  const artifact = yield* encodeTemplateIdentity(identity)
  yield* fileSystem.writeFileString("executor-template.json", `${artifact}\n`)
})

const command = Command.make(
  "create-image-template",
  {
    image: Argument.string("image"),
    alias: Argument.string("alias"),
  },
  ({ image, alias }) => createImageTemplate(image, alias),
)

const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
