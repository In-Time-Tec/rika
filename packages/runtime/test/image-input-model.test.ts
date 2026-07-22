import { TestModel } from "@batonfx/test"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import * as ImageInputModel from "../src/image-input-model"

it.effect("converts supported image data without changing non-image files", () =>
  Effect.gen(function* () {
    const fixture = yield* TestModel.make([TestModel.text("received")])
    const services = yield* Layer.build(fixture.layer)
    const model = yield* LanguageModel.LanguageModel.pipe(Effect.map(ImageInputModel.make), Effect.provide(services))
    yield* model.generateText({
      prompt: Prompt.fromMessages([
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("file", {
              mediaType: "text/plain",
              data: "data:text/plain;base64,dGV4dA==",
              fileName: "note.txt",
            }),
            Prompt.makePart("file", {
              mediaType: "image/png",
              data: "data:image/png;base64,AQID",
              fileName: "shot.png",
            }),
          ],
        }),
      ]),
    })
    const content = (yield* fixture.requests)[0]?.prompt.content[0]?.content
    assert.ok(Array.isArray(content))
    assert.strictEqual(content[0]?.type, "file")
    if (content[0]?.type === "file") assert.strictEqual(content[0].data, "data:text/plain;base64,dGV4dA==")
    assert.strictEqual(content[1]?.type, "file")
    if (content[1]?.type === "file") assert.deepStrictEqual(content[1].data, Uint8Array.from([1, 2, 3]))
  }),
)
