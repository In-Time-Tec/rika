import { assert, it } from "@effect/vitest"
import { Prompt } from "effect/unstable/ai"
import { durableToolCallId, providerPrompt } from "../src/tool-call-identifiers"

it("prepares replayed tool calls and results with the original provider identifier", () => {
  const originalCallId = `call_${"a".repeat(59)}`
  const firstExecutionId = "execution:38e2964b-e245-47b2-9670-3d1a28927fd6"
  const secondExecutionId = "execution:b297091a-f840-4d05-a4a4-9b785ef8f254"
  const durableCallId = durableToolCallId(firstExecutionId, originalCallId)
  assert.isAbove(durableCallId.length, 64)
  const request = providerPrompt(
    secondExecutionId,
    Prompt.fromMessages([
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "turn one" })] }),
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", {
            id: durableCallId,
            name: "read",
            params: { path: "fixture.txt" },
            providerExecuted: false,
          }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: durableCallId,
            name: "read",
            isFailure: false,
            result: "fixture",
          }),
        ],
      }),
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "turn two" })] }),
    ]),
  )
  const callIds = request.content.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) => (part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [])),
  )

  assert.deepStrictEqual(callIds, [originalCallId, originalCallId])
  assert.isTrue(callIds.every((callId) => callId.length <= 64))
})
