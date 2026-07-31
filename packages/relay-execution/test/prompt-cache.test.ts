import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Prompt, Response } from "effect/unstable/ai"
import { annotateCacheBreakpoints, cacheBreakpoints, promptCachingLanguageModel } from "../src/prompt-cache"
import { streamingOnlyLanguageModel } from "../src/streaming-only-model"

const system = (text: string, options?: Prompt.ProviderOptions) =>
  Prompt.makeMessage("system", { content: text, ...(options === undefined ? {} : { options }) })

const user = (...texts: ReadonlyArray<string>) =>
  Prompt.makeMessage("user", { content: texts.map((text) => Prompt.makePart("text", { text })) })

const assistantCall = (id: string) =>
  Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("text", { text: `calling ${id}` }),
      Prompt.makePart("tool-call", { id, name: "bash", params: { command: "ls" }, providerExecuted: false }),
    ],
  })

const toolResult = (id: string) =>
  Prompt.makeMessage("tool", {
    content: [Prompt.makePart("tool-result", { id, name: "bash", isFailure: false, result: { stdout: id } })],
  })

const approvedToolResult = (id: string) =>
  Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", { id, name: "bash", isFailure: false, result: { stdout: id } }),
      Prompt.makePart("tool-approval-response", { approvalId: `${id}-approval`, approved: true }),
    ],
  })

const anthropicOptions = (options: unknown) =>
  (options as { readonly anthropic?: { readonly cacheControl?: unknown } } | undefined)?.anthropic

const bedrockOptions = (options: unknown) =>
  (options as { readonly amazonBedrock?: { readonly cachePoint?: unknown } } | undefined)?.amazonBedrock

const isBreakpoint = (options: unknown) =>
  JSON.stringify(anthropicOptions(options)?.cacheControl) === JSON.stringify({ type: "ephemeral" }) &&
  bedrockOptions(options)?.cachePoint === true

const breakpointPaths = (prompt: Prompt.Prompt): ReadonlyArray<string> => {
  const paths: Array<string> = []
  prompt.content.forEach((message, index) => {
    if (isBreakpoint(message.options)) paths.push(`${message.role}:${index}`)
    if (message.role === "system") return
    const parts: ReadonlyArray<Prompt.Part> = message.content
    parts.forEach((part, position) => {
      if (isBreakpoint(part.options)) paths.push(`${message.role}:${index}:${position}`)
    })
  })
  return paths
}

const recordingModel = (prompts: Array<Prompt.Prompt>): LanguageModel.Service =>
  ({
    generateText: (options: { readonly prompt: Prompt.Prompt }) => {
      prompts.push(options.prompt)
      return Effect.succeed("generateText")
    },
    generateObject: (options: { readonly prompt: Prompt.Prompt }) => {
      prompts.push(options.prompt)
      return Effect.succeed("generateObject")
    },
    streamText: (options: { readonly prompt: Prompt.Prompt }) => {
      prompts.push(options.prompt)
      return Stream.empty
    },
  }) as unknown as LanguageModel.Service

describe("annotateCacheBreakpoints", () => {
  it("stamps the last system message and the tail user part on the first request of a thread", () => {
    const annotated = annotateCacheBreakpoints(Prompt.fromMessages([system("guidance"), user("first ask")]))
    expect(breakpointPaths(annotated)).toEqual(["system:0", "user:1:0"])
  })

  it("caches the tool definitions ahead of the system block, so no separate tools breakpoint is needed", () => {
    const annotated = annotateCacheBreakpoints(Prompt.fromMessages([system("first"), system("second"), user("ask")]))
    expect(breakpointPaths(annotated)).toEqual(["system:1", "user:2:0"])
  })

  it("stamps prev on the tool message before the last assistant turn, which is the previous request's tail", () => {
    const annotated = annotateCacheBreakpoints(
      Prompt.fromMessages([
        system("guidance"),
        user("ask"),
        assistantCall("call-1"),
        toolResult("call-1"),
        assistantCall("call-2"),
        toolResult("call-2"),
      ]),
    )
    expect(breakpointPaths(annotated)).toEqual(["system:0", "tool:3:0", "tool:5:0"])
  })

  it("never annotates an assistant message, because the Anthropic mapper discards assistant cache_control", () => {
    const annotated = annotateCacheBreakpoints(
      Prompt.fromMessages([
        system("guidance"),
        user("ask"),
        assistantCall("call-1"),
        toolResult("call-1"),
        assistantCall("call-2"),
        toolResult("call-2"),
      ]),
    )
    const assistants = annotated.content.filter((message) => message.role === "assistant")
    expect(assistants).toHaveLength(2)
    for (const message of assistants) {
      expect(isBreakpoint(message.options)).toBe(false)
      const parts: ReadonlyArray<Prompt.Part> = message.content
      for (const part of parts) expect(isBreakpoint(part.options)).toBe(false)
    }
  })

  it("stamps at most three breakpoints, leaving one of Anthropic's four free", () => {
    const messages: Array<Prompt.Message> = [system("guidance"), user("ask")]
    for (let round = 0; round < 12; round += 1) {
      messages.push(assistantCall(`call-${round}`), toolResult(`call-${round}`))
      const stamped = Prompt.fromMessages(messages).pipe(annotateCacheBreakpoints, breakpointPaths)
      expect(stamped.length).toBeLessThanOrEqual(3)
    }
  })

  it("stamps fewer than three breakpoints when prev does not exist", () => {
    expect(breakpointPaths(annotateCacheBreakpoints(Prompt.fromMessages([user("ask")])))).toEqual(["user:0:0"])
    expect(breakpointPaths(annotateCacheBreakpoints(Prompt.fromMessages([system("guidance")])))).toEqual(["system:0"])
    expect(breakpointPaths(annotateCacheBreakpoints(Prompt.empty))).toEqual([])
  })

  it("collapses prev and tail onto one breakpoint when the prompt ends on an assistant message", () => {
    const annotated = annotateCacheBreakpoints(
      Prompt.fromMessages([system("guidance"), user("ask"), assistantCall("call-1")]),
    )
    expect(breakpointPaths(annotated)).toEqual(["system:0", "user:1:0"])
  })

  it("annotates the last part of a multi-part message so earlier parts stay inside the cached prefix", () => {
    const annotated = annotateCacheBreakpoints(Prompt.fromMessages([system("guidance"), user("one", "two", "three")]))
    expect(breakpointPaths(annotated)).toEqual(["system:0", "user:1:2"])
  })

  it("skips a trailing tool-approval-response part, which the Anthropic mapper drops", () => {
    const annotated = annotateCacheBreakpoints(
      Prompt.fromMessages([system("guidance"), user("ask"), assistantCall("call-1"), approvedToolResult("call-1")]),
    )
    expect(breakpointPaths(annotated)).toEqual(["system:0", "user:1:0", "tool:3:0"])
  })

  it("omits ttl so breakpoints stay on the five-minute ephemeral tier", () => {
    const annotated = annotateCacheBreakpoints(Prompt.fromMessages([system("guidance"), user("ask")]))
    expect(anthropicOptions(annotated.content[0]!.options)?.cacheControl).toEqual({ type: "ephemeral" })
    expect(bedrockOptions(annotated.content[0]!.options)?.cachePoint).toBe(true)
  })

  it("merges into existing provider options instead of overwriting them", () => {
    const annotated = annotateCacheBreakpoints(
      Prompt.fromMessages([
        system("guidance", { openai: { reasoningEffort: "high" }, anthropic: { container: "sandbox" } }),
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "ask", options: { openai: { itemId: "item-1" } } })],
        }),
      ]),
    )
    expect(annotated.content[0]!.options).toEqual({
      openai: { reasoningEffort: "high" },
      anthropic: { container: "sandbox", cacheControl: { type: "ephemeral" } },
      amazonBedrock: { cachePoint: true },
    })
    const userMessage = annotated.content[1]!
    const parts: ReadonlyArray<Prompt.Part> = userMessage.role === "system" ? [] : userMessage.content
    expect(parts[0]!.options).toEqual({
      openai: { itemId: "item-1" },
      anthropic: { cacheControl: { type: "ephemeral" } },
      amazonBedrock: { cachePoint: true },
    })
  })

  it("leaves untouched messages referentially identical so only three segments are rewritten", () => {
    const messages = [system("guidance"), user("ask"), assistantCall("call-1"), toolResult("call-1")]
    const annotated = annotateCacheBreakpoints(Prompt.fromMessages(messages))
    expect(annotated.content[2]).toBe(messages[2])
  })

  it("is idempotent, so re-annotating an already-annotated prompt changes nothing", () => {
    const prompt = Prompt.fromMessages([system("guidance"), user("ask"), assistantCall("call-1"), toolResult("call-1")])
    const once = annotateCacheBreakpoints(prompt)
    const twice = annotateCacheBreakpoints(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(breakpointPaths(twice)).toEqual(breakpointPaths(once))
  })

  it("converges: prev for an extended prompt is the tail of the prompt it extends", () => {
    const messages: Array<Prompt.Message> = [system("guidance"), user("ask")]
    let tail = cacheBreakpoints(messages).tail
    for (let round = 0; round < 8; round += 1) {
      messages.push(assistantCall(`call-${round}`), toolResult(`call-${round}`))
      const next = cacheBreakpoints(messages)
      expect(next.previous).toBe(tail)
      expect(next.system).toBe(0)
      tail = next.tail
    }
  })

  it("keeps an index pointing at the same bytes, because message history is append-only", () => {
    const messages: Array<Prompt.Message> = [system("guidance"), user("ask"), assistantCall("call-1")]
    const before = annotateCacheBreakpoints(Prompt.fromMessages(messages))
    messages.push(toolResult("call-1"))
    const after = annotateCacheBreakpoints(Prompt.fromMessages(messages))
    expect(JSON.stringify(after.content.slice(0, 2))).toBe(JSON.stringify(before.content.slice(0, 2)))
  })
})

describe("promptCachingLanguageModel", () => {
  it.effect("annotates all three methods, because Anthropic and Bedrock routes get no streaming-only wrapper", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = []
      const model = promptCachingLanguageModel(recordingModel(prompts))
      const prompt = Prompt.fromMessages([system("guidance"), user("ask")])
      yield* model.generateText({ prompt })
      yield* Stream.runDrain(model.streamText({ prompt }))
      yield* model.generateObject({ prompt, schema: Prompt.Prompt as never, objectName: "output" })
      expect(prompts).toHaveLength(3)
      for (const recorded of prompts) expect(breakpointPaths(recorded)).toEqual(["system:0", "user:1:0"])
    }),
  )

  it.effect("normalizes a raw string prompt before annotating it", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = []
      const model = promptCachingLanguageModel(recordingModel(prompts))
      yield* model.generateText({ prompt: "hello" })
      expect(breakpointPaths(prompts[0]!)).toEqual(["user:0:0"])
    }),
  )

  it.effect("leaves every other option on the call untouched", () =>
    Effect.gen(function* () {
      const seen: Array<Record<string, unknown>> = []
      const model = promptCachingLanguageModel({
        generateText: (options: never) => {
          seen.push(options)
          return Effect.succeed("generateText")
        },
        generateObject: () => Effect.succeed("generateObject"),
        streamText: () => Stream.empty,
      } as unknown as LanguageModel.Service)
      yield* model.generateText({ prompt: "hello", disableToolCallResolution: true } as never)
      expect(seen[0]!["disableToolCallResolution"]).toBe(true)
    }),
  )
})

const usage = Response.Usage.make({
  inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const streamedJson = (text: string) => [
  Response.makePart("text-start", { id: "part-1" }),
  Response.makePart("text-delta", { id: "part-1", delta: text }),
  Response.makePart("text-end", { id: "part-1" }),
  Response.makePart("finish", { reason: "stop", usage, response: undefined }),
]

const streamRecordingModel = (prompts: Array<Prompt.Prompt>, parts: ReadonlyArray<unknown>): LanguageModel.Service =>
  ({
    generateText: () => Effect.die("generateText must not be reached on a streaming-only route"),
    generateObject: () => Effect.die("generateObject must not be reached on a streaming-only route"),
    streamText: (options: { readonly prompt: Prompt.Prompt }) => {
      prompts.push(options.prompt)
      return Stream.fromIterable(parts as Iterable<never>)
    },
  }) as unknown as LanguageModel.Service

const lastMessageText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content[prompt.content.length - 1]!
  if (message.role === "system") return message.content
  const parts: ReadonlyArray<Prompt.Part> = message.content
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("")
}

describe("promptCachingLanguageModel under streamingOnlyLanguageModel", () => {
  it.effect("moves the tail breakpoint onto the JSON-instruction message that generateObject appends", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = []
      const model = streamingOnlyLanguageModel(
        promptCachingLanguageModel(streamRecordingModel(prompts, streamedJson('{"ok":true}'))),
      )
      const response = yield* model.generateObject({
        prompt: Prompt.fromMessages([system("guidance"), user("ask")]),
        schema: Schema.Struct({ ok: Schema.Boolean }),
        objectName: "output",
      })
      expect(response.value).toEqual({ ok: true })
      const sent = prompts[0]!
      expect(sent.content).toHaveLength(3)
      expect(lastMessageText(sent)).toContain("JSON")
      expect(breakpointPaths(sent)).toEqual(["system:0", "user:2:0"])
    }),
  )

  it.effect("keeps the tail breakpoint on the instruction message when the caller's prompt is a tool loop", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = []
      const model = streamingOnlyLanguageModel(
        promptCachingLanguageModel(streamRecordingModel(prompts, streamedJson('{"ok":true}'))),
      )
      yield* model.generateObject({
        prompt: Prompt.fromMessages([system("guidance"), user("ask"), assistantCall("call-1"), toolResult("call-1")]),
        schema: Schema.Struct({ ok: Schema.Boolean }),
        objectName: "output",
      })
      const sent = prompts[0]!
      expect(sent.content).toHaveLength(5)
      expect(lastMessageText(sent)).toContain("JSON")
      expect(breakpointPaths(sent)).toEqual(["system:0", "user:1:0", "user:4:0"])
    }),
  )

  it.effect("annotates the prompt actually sent on the wire when generateText collapses to streamText", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = []
      const model = streamingOnlyLanguageModel(
        promptCachingLanguageModel(streamRecordingModel(prompts, streamedJson("answer"))),
      )
      yield* model.generateText({ prompt: Prompt.fromMessages([system("guidance"), user("ask")]) })
      expect(breakpointPaths(prompts[0]!)).toEqual(["system:0", "user:1:0"])
    }),
  )
})
