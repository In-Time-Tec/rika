import { readFile, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import { ToolRegistry } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Provider, Retry, Router } from "@rika/llm"
import { ArtifactStore } from "@rika/persistence"
import { Artifact, Common, Ids } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const defaultMaxOutputChars = 24_000
const maxPainterReferenceImageBytes = 8_000_000

export interface OracleInput extends Schema.Schema.Type<typeof OracleInput> {}
export const OracleInput = Schema.Struct({
  task: Schema.String,
  context: Schema.optionalKey(Schema.String),
  max_output_chars: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.OracleInput" })

export interface LibrarianInput extends Schema.Schema.Type<typeof LibrarianInput> {}
export const LibrarianInput = Schema.Struct({
  question: Schema.String,
  repository: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  max_output_chars: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.LibrarianInput" })

export interface PainterInput extends Schema.Schema.Type<typeof PainterInput> {}
export const PainterInput = Schema.Struct({
  prompt: Schema.String,
  input_image_paths: Schema.optionalKey(Schema.Array(Schema.String)),
  size: Schema.optionalKey(Schema.String),
  max_output_chars: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.PainterInput" })

export const Severity = Schema.Literals(["low", "medium", "high", "critical"]).annotate({
  identifier: "Rika.Tools.SpecialtyTools.Severity",
})
export type Severity = typeof Severity.Type

export interface Finding extends Schema.Schema.Type<typeof Finding> {}
export const Finding = Schema.Struct({
  severity: Severity,
  title: Schema.String,
  evidence: Schema.String,
  recommendation: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.Finding" })

export interface Citation extends Schema.Schema.Type<typeof Citation> {}
export const Citation = Schema.Struct({
  title: Schema.String,
  url: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  line_start: Schema.optionalKey(Schema.Int),
  line_end: Schema.optionalKey(Schema.Int),
  excerpt: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.Citation" })

export interface ImageAsset extends Schema.Schema.Type<typeof ImageAsset> {}
export const ImageAsset = Schema.Struct({
  mime_type: Schema.String,
  data_url: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.ImageAsset" })

export interface OracleDraft extends Schema.Schema.Type<typeof OracleDraft> {}
export const OracleDraft = Schema.Struct({
  answer: Schema.String,
  findings: Schema.Array(Finding),
  model: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.OracleDraft" })

export interface ResearchDraft extends Schema.Schema.Type<typeof ResearchDraft> {}
export const ResearchDraft = Schema.Struct({
  answer: Schema.String,
  citations: Schema.Array(Citation),
  model: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.ResearchDraft" })

export interface PainterDraft extends Schema.Schema.Type<typeof PainterDraft> {}
export const PainterDraft = Schema.Struct({
  prompt: Schema.String,
  images: Schema.Array(ImageAsset),
  model: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Rika.Tools.SpecialtyTools.PainterDraft" })

export class SpecialtyToolsError extends Schema.TaggedErrorClass<SpecialtyToolsError>()("SpecialtyToolsError", {
  message: Schema.String,
  operation: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Backend {
  readonly oracle: (input: OracleInput) => Effect.Effect<OracleDraft, SpecialtyToolsError>
  readonly librarian: (input: LibrarianInput) => Effect.Effect<ResearchDraft, SpecialtyToolsError>
  readonly painter: (input: PainterInput) => Effect.Effect<PainterDraft, SpecialtyToolsError>
}

export interface Interface {
  readonly oracle: (input: OracleInput, call: Call) => Effect.Effect<Common.JsonValue, SpecialtyToolsError>
  readonly librarian: (input: LibrarianInput, call: Call) => Effect.Effect<Common.JsonValue, SpecialtyToolsError>
  readonly painter: (input: PainterInput, call: Call) => Effect.Effect<Common.JsonValue, SpecialtyToolsError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/SpecialtyTools") {}

interface Dependencies {
  readonly artifactStore: ArtifactStore.Interface
  readonly backend: Backend
  readonly idGenerator: IdGenerator.Interface
  readonly time: Time.Interface
}

export const layerWithBackend = (
  backend: Backend,
): Layer.Layer<Service, never, ArtifactStore.Service | IdGenerator.Service | Time.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      const dependencies: Dependencies = { artifactStore, backend, idGenerator, time }
      return makeService(dependencies)
    }),
  )

export const layer: Layer.Layer<
  Service,
  never,
  ArtifactStore.Service | Config.Service | IdGenerator.Service | Router.Service | Time.Service
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const router = yield* Router.Service
    return layerWithBackend(modelRoutedBackend(router, values.workspace_root))
  }),
)

export const fakeLayer = (backend: Partial<Backend> = {}) =>
  layerWithBackend({
    oracle: backend.oracle ?? ((input) => Effect.succeed(defaultOracleDraft(input))),
    librarian: backend.librarian ?? ((input) => Effect.succeed(defaultResearchDraft(input))),
    painter: backend.painter ?? ((input) => Effect.succeed(defaultPainterDraft(input))),
  })

export const oracle = Effect.fn("SpecialtyTools.oracle.call")(function* (input: OracleInput, call: Call) {
  const service = yield* Service
  return yield* service.oracle(input, call)
})

export const librarian = Effect.fn("SpecialtyTools.librarian.call")(function* (input: LibrarianInput, call: Call) {
  const service = yield* Service
  return yield* service.librarian(input, call)
})

export const painter = Effect.fn("SpecialtyTools.painter.call")(function* (input: PainterInput, call: Call) {
  const service = yield* Service
  return yield* service.painter(input, call)
})

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("oracle", {
      description:
        "Ask a separate model-routed second-opinion reviewer for hard reasoning, complex debugging, implementation-plan critique, or subtle code review. Do not use for routine edits.",
      parameters: OracleInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SpecialtyTools.tool.oracle")(function* (call: Call) {
      const input = yield* decodeOracleInput(call)
      return yield* service.oracle(input, call).pipe(Effect.mapError(toRegistryError("oracle")))
    }),
  },
  {
    tool: Tool.make("librarian", {
      description:
        "Research external repositories or libraries outside the local workspace. Use for remote codebase understanding; do not use it as a replacement for local semantic_search or fff tools.",
      parameters: LibrarianInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SpecialtyTools.tool.librarian")(function* (call: Call) {
      const input = yield* decodeLibrarianInput(call)
      return yield* service.librarian(input, call).pipe(Effect.mapError(toRegistryError("librarian")))
    }),
  },
  {
    tool: Tool.make("painter", {
      description:
        "Opt-in image generation/editing tool. Use only when the user explicitly asks for Painter or image generation/editing. Stores generated image assets as artifacts.",
      parameters: PainterInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("SpecialtyTools.tool.painter")(function* (call: Call) {
      const input = yield* decodePainterInput(call)
      return yield* service.painter(input, call).pipe(Effect.mapError(toRegistryError("painter")))
    }),
  },
]

export const registryLayerFromService: Layer.Layer<ToolRegistry.Service, never, Service> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const service = yield* Service
    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(toolDefinitions(service))))
  }),
)

const makeService = (dependencies: Dependencies): Interface =>
  Service.of({
    oracle: Effect.fn("SpecialtyTools.oracle")(function* (input: OracleInput, call: Call) {
      const draft = yield* dependencies.backend.oracle(input)
      const artifact = yield* persistArtifact(dependencies, call, {
        kind: "research",
        title: "Oracle second opinion",
        content: oracleContent(input, draft),
        metadata: { tool: "oracle", findings: draft.findings.length },
      })
      return yield* jsonValue({
        type: "specialty.oracle",
        answer: capText(draft.answer, outputLimit(input.max_output_chars)),
        findings: draft.findings.map(findingToJson),
        artifact_id: artifact.id,
        ...(draft.model === undefined ? {} : { model: draft.model }),
      })
    }),
    librarian: Effect.fn("SpecialtyTools.librarian")(function* (input: LibrarianInput, call: Call) {
      const draft = yield* dependencies.backend.librarian(input)
      const artifact = yield* persistArtifact(dependencies, call, {
        kind: "research",
        title: input.repository === undefined ? "External research" : `External research: ${input.repository}`,
        content: researchContent(input, draft),
        metadata: { tool: "librarian", citations: draft.citations.length },
      })
      return yield* jsonValue({
        type: "specialty.librarian",
        answer: capText(draft.answer, outputLimit(input.max_output_chars)),
        citations: draft.citations.map(citationToJson),
        artifact_id: artifact.id,
        ...(draft.model === undefined ? {} : { model: draft.model }),
      })
    }),
    painter: Effect.fn("SpecialtyTools.painter")(function* (input: PainterInput, call: Call) {
      const draft = yield* dependencies.backend.painter(input)
      const artifact = yield* persistArtifact(dependencies, call, {
        kind: "image",
        title: "Painter image artifact",
        content: painterContent(input, draft),
        metadata: { tool: "painter", images: draft.images.length },
      })
      return yield* jsonValue({
        type: "specialty.painter",
        prompt: draft.prompt,
        images: draft.images.map(imageToJson),
        artifact_id: artifact.id,
        ...(draft.model === undefined ? {} : { model: draft.model }),
      })
    }),
  })

const modelRoutedBackend = (router: Router.Interface, workspaceRoot: string): Backend => ({
  oracle: Effect.fn("SpecialtyTools.backend.oracle")(function* (input: OracleInput) {
    const result = yield* router
      .completeStructured({
        profile: "oracle",
        schema: OracleDraft,
        messages: [
          { role: "system", content: oracleSystemPrompt },
          { role: "user", content: oracleUserPrompt(input, workspaceRoot) },
        ],
        metadata: { specialty_tool: "oracle" },
      })
      .pipe(Effect.catchTag("StructuredOutputError", (error) => Effect.succeed(oracleFallback(error.raw_content))))
      .pipe(Effect.mapError((error) => fromExternalError(error, "oracle")))
    return { ...result.value, model: result.value.model ?? result.raw.model }
  }),
  librarian: Effect.fn("SpecialtyTools.backend.librarian")(function* (input: LibrarianInput) {
    const result = yield* router
      .completeStructured({
        profile: "librarian",
        schema: ResearchDraft,
        messages: [
          { role: "system", content: librarianSystemPrompt },
          { role: "user", content: librarianUserPrompt(input) },
        ],
        metadata: { specialty_tool: "librarian" },
      })
      .pipe(Effect.mapError((error) => fromExternalError(error, "librarian")))
    return { ...result.value, model: result.value.model ?? result.raw.model }
  }),
  painter: Effect.fn("SpecialtyTools.backend.painter")(function* (input: PainterInput) {
    const userMessage = yield* painterUserMessage(input, workspaceRoot)
    const result = yield* router
      .completeStructured({
        mode: "smart",
        schema: PainterDraft,
        messages: [{ role: "system", content: painterSystemPrompt }, userMessage],
        metadata: { specialty_tool: "painter" },
      })
      .pipe(Effect.mapError((error) => fromExternalError(error, "painter")))
    return { ...result.value, model: result.value.model ?? result.raw.model }
  }),
})

interface ArtifactParts {
  readonly kind: Artifact.Kind
  readonly title: string
  readonly content: Common.JsonValue
  readonly metadata: Common.Metadata
}

const persistArtifact = (dependencies: Dependencies, call: Call, parts: ArtifactParts) =>
  Effect.gen(function* () {
    const threadId = threadIdFromCall(call)
    const turnId = turnIdFromCall(call)
    if (Option.isNone(threadId)) {
      return yield* new SpecialtyToolsError({
        message: "Specialty tools require thread_id metadata so outputs can be persisted as artifacts.",
        operation: "persistArtifact",
        retryable: false,
      })
    }
    const createdAt = yield* dependencies.time.nowMillis
    const id = Ids.ArtifactId.make(yield* dependencies.idGenerator.next("artifact"))
    return yield* dependencies.artifactStore
      .put({
        id,
        thread_id: threadId.value,
        ...(Option.isSome(turnId) ? { turn_id: turnId.value } : {}),
        kind: parts.kind,
        title: parts.title,
        content: parts.content,
        metadata: parts.metadata,
        created_at: createdAt,
      })
      .pipe(Effect.mapError((error) => fromExternalError(error, "persistArtifact")))
  })

const threadIdFromCall = (call: Call) => {
  const value = call.metadata?.thread_id
  return typeof value === "string" ? Option.some(Ids.ThreadId.make(value)) : Option.none<Ids.ThreadId>()
}

const turnIdFromCall = (call: Call) => {
  const value = call.metadata?.turn_id
  return typeof value === "string" ? Option.some(Ids.TurnId.make(value)) : Option.none<Ids.TurnId>()
}

const oracleFallback = (content: string): Router.StructuredResponse<OracleDraft> => ({
  value: { answer: content.trim(), findings: [] },
  raw: { provider: "openai", model: "structured-output-fallback", content },
})

const defaultOracleDraft = (input: OracleInput): OracleDraft => ({
  answer: `Fake oracle response for: ${input.task}`,
  findings: [
    {
      severity: "medium",
      title: "Fake second opinion",
      evidence: input.context ?? input.task,
      recommendation: "Replace the fake oracle backend in live tests when needed.",
    },
  ],
  model: "fake-specialty",
})

const defaultResearchDraft = (input: LibrarianInput): ResearchDraft => ({
  answer: `Fake external research response for: ${input.question}`,
  citations: [
    {
      title: input.repository ?? "fake external source",
      excerpt: input.context ?? input.question,
      ...(input.repository === undefined ? {} : { repository: input.repository }),
    },
  ],
  model: "fake-specialty",
})

const defaultPainterDraft = (input: PainterInput): PainterDraft => ({
  prompt: input.prompt,
  images: [svgImage(input.prompt, "Fake painter artifact")],
  model: "fake-specialty",
})

const svgImage = (prompt: string, description: string): ImageAsset => {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">`,
    `<rect width="1024" height="1024" fill="#111827"/>`,
    `<circle cx="512" cy="384" r="220" fill="#22d3ee" opacity="0.25"/>`,
    `<text x="512" y="520" fill="#f9fafb" font-family="monospace" font-size="36" text-anchor="middle">${escapeXml(prompt.slice(0, 36))}</text>`,
    `</svg>`,
  ].join("")
  return {
    mime_type: "image/svg+xml",
    data_url: `data:image/svg+xml;base64,${btoa(svg)}`,
    description,
  }
}

const oracleContent = (input: OracleInput, draft: OracleDraft): Common.JsonValue => ({
  tool: "oracle",
  task: input.task,
  ...(input.context === undefined ? {} : { context: input.context }),
  answer: draft.answer,
  findings: draft.findings.map(findingToJson),
  ...(draft.model === undefined ? {} : { model: draft.model }),
})

const researchContent = (input: LibrarianInput, draft: ResearchDraft): Common.JsonValue => ({
  tool: "librarian",
  question: input.question,
  ...(input.repository === undefined ? {} : { repository: input.repository }),
  ...(input.context === undefined ? {} : { context: input.context }),
  answer: draft.answer,
  citations: draft.citations.map(citationToJson),
  ...(draft.model === undefined ? {} : { model: draft.model }),
})

const painterContent = (input: PainterInput, draft: PainterDraft): Common.JsonValue => ({
  tool: "painter",
  prompt: input.prompt,
  ...(input.input_image_paths === undefined ? {} : { input_image_paths: input.input_image_paths }),
  ...(input.size === undefined ? {} : { size: input.size }),
  images: draft.images.map(imageToJson),
  ...(draft.model === undefined ? {} : { model: draft.model }),
})

const findingToJson = (finding: Finding): Common.JsonValue => ({
  severity: finding.severity,
  title: finding.title,
  evidence: finding.evidence,
  ...(finding.recommendation === undefined ? {} : { recommendation: finding.recommendation }),
})

const citationToJson = (citation: Citation): Common.JsonValue => ({
  title: citation.title,
  ...(citation.url === undefined ? {} : { url: citation.url }),
  ...(citation.repository === undefined ? {} : { repository: citation.repository }),
  ...(citation.path === undefined ? {} : { path: citation.path }),
  ...(citation.line_start === undefined ? {} : { line_start: citation.line_start }),
  ...(citation.line_end === undefined ? {} : { line_end: citation.line_end }),
  ...(citation.excerpt === undefined ? {} : { excerpt: citation.excerpt }),
})

const imageToJson = (image: ImageAsset): Common.JsonValue => ({
  mime_type: image.mime_type,
  ...(image.data_url === undefined ? {} : { data_url: image.data_url }),
  ...(image.url === undefined ? {} : { url: image.url }),
  ...(image.description === undefined ? {} : { description: image.description }),
})

const decodeOracleInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(OracleInput)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidInput(call, "oracle")
}

const decodeLibrarianInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(LibrarianInput)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidInput(call, "librarian")
}

const decodePainterInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(PainterInput)(call.input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return invalidInput(call, "painter")
}

const invalidInput = (call: Call, name: string) =>
  new ToolRegistry.ToolRegistryError({
    message: `${name} input did not match the expected schema`,
    name: call.name,
    retryable: false,
  })

const toRegistryError = (name: string) => (error: SpecialtyToolsError) =>
  new ToolRegistry.ToolRegistryError({
    message: error.message,
    name,
    retryable: error.retryable ?? false,
    ...(error.details === undefined ? {} : { details: error.details }),
  })

const fromExternalError = (cause: unknown, operation: string) =>
  new SpecialtyToolsError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    retryable: Retry.isTransient(cause),
  })

const jsonValue = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(Common.JsonValue)(value)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return new SpecialtyToolsError({
    message: "Specialty tool output was not JSON serializable",
    operation: "jsonValue",
    retryable: false,
  })
}

const outputLimit = (value: number | undefined) => Math.min(Math.max(value ?? defaultMaxOutputChars, 1_000), 80_000)
const capText = (text: string, maxChars: number) =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated`
const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const oracleSystemPrompt = [
  "You are Rika's second-opinion reasoning specialist.",
  "Review only the task supplied by the main agent. Do not edit files.",
  'Return JSON only: {"answer": string, "findings": [{"severity": "low|medium|high|critical", "title": string, "evidence": string, "recommendation": string?}]}',
].join("\n")

const librarianSystemPrompt = [
  "You are Rika's external-codebase research specialist.",
  "Focus on repositories, packages, APIs, and documentation outside the local workspace. Do not answer by searching local workspace files.",
  'Return JSON only: {"answer": string, "citations": [{"title": string, "url": string?, "repository": string?, "path": string?, "line_start": number?, "line_end": number?, "excerpt": string?}]}',
].join("\n")

const painterSystemPrompt = [
  "You are Rika's image generation prompt specialist.",
  "The actual image backend is swappable. Produce a concise visual description that can be stored with an image artifact.",
  'Return JSON only when possible: {"prompt": string, "images": [{"mime_type": string, "data_url": string?, "url": string?, "description": string?}]}',
].join("\n")

const oracleUserPrompt = (input: OracleInput, workspaceRoot: string) =>
  [
    `Workspace root: ${workspaceRoot}`,
    `Task:\n${input.task}`,
    input.context === undefined ? undefined : `Context:\n${input.context}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n")

const librarianUserPrompt = (input: LibrarianInput) =>
  [
    input.repository === undefined ? undefined : `Repository or package: ${input.repository}`,
    `Question:\n${input.question}`,
    input.context === undefined ? undefined : `Context:\n${input.context}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n")

const painterUserMessage = (
  input: PainterInput,
  workspaceRoot: string,
): Effect.Effect<Provider.Message, SpecialtyToolsError> =>
  Effect.gen(function* () {
    const images = yield* Effect.forEach(
      input.input_image_paths ?? [],
      (path) => painterReferenceImage(workspaceRoot, path),
      { concurrency: 4 },
    )
    const text = painterUserPrompt(input)
    if (images.length === 0) return { role: "user", content: text }
    return { role: "user", content: [{ type: "text", text }, ...images] }
  })

const painterUserPrompt = (input: PainterInput) =>
  [
    `Prompt:\n${input.prompt}`,
    input.size === undefined ? undefined : `Requested size: ${input.size}`,
    input.input_image_paths === undefined || input.input_image_paths.length === 0
      ? undefined
      : `Reference image paths:\n${input.input_image_paths.map((path) => `- ${path}`).join("\n")}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n")

const painterReferenceImage = (
  workspaceRoot: string,
  inputPath: string,
): Effect.Effect<Provider.FileContent, SpecialtyToolsError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveWorkspacePath(workspaceRoot, inputPath, "painterReferenceImage")
    const mediaType = yield* imageMediaType(resolved.filename, inputPath)
    const fileStat = yield* Effect.tryPromise({
      try: () => stat(resolved.path),
      catch: (cause) =>
        new SpecialtyToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation: "painterReferenceImage",
          retryable: false,
        }),
    })
    if (!fileStat.isFile()) {
      return yield* new SpecialtyToolsError({
        message: `Painter reference image is not a file: ${inputPath}`,
        operation: "painterReferenceImage",
        retryable: false,
      })
    }
    if (fileStat.size > maxPainterReferenceImageBytes) {
      return yield* new SpecialtyToolsError({
        message: `Painter reference image exceeds ${maxPainterReferenceImageBytes} bytes: ${inputPath}`,
        operation: "painterReferenceImage",
        retryable: false,
      })
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(resolved.path),
      catch: (cause) =>
        new SpecialtyToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation: "painterReferenceImage",
          retryable: false,
        }),
    })
    return {
      type: "file",
      media_type: mediaType,
      data: bytes.toString("base64"),
      filename: resolved.filename,
    }
  })

const resolveWorkspacePath = (workspaceRoot: string, inputPath: string, operation: string) =>
  Effect.gen(function* () {
    const lexicalPath = yield* Effect.try({
      try: () => {
        const clean = inputPath.trim().replace(/^@/, "")
        if (clean.length === 0) throw new Error("input_image_paths entries must be non-empty")
        const path = isAbsolute(clean) ? resolve(clean) : resolve(workspaceRoot, clean)
        if (isOutside(workspaceRoot, path)) throw new Error(`Path is outside the workspace: ${inputPath}`)
        return path
      },
      catch: (cause) =>
        new SpecialtyToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation,
          retryable: false,
        }),
    })
    const real = yield* Effect.tryPromise({
      try: async () => ({ root: await realpath(workspaceRoot), path: await realpath(lexicalPath) }),
      catch: (cause) =>
        new SpecialtyToolsError({
          message: cause instanceof Error ? cause.message : String(cause),
          operation,
          retryable: false,
        }),
    })
    if (isOutside(real.root, real.path)) {
      return yield* new SpecialtyToolsError({
        message: `Path is outside the workspace: ${inputPath}`,
        operation,
        retryable: false,
      })
    }
    return {
      path: real.path,
      filename: slashPath(relative(workspaceRoot, lexicalPath)),
    }
  })

const imageMediaType = (path: string, inputPath: string) => {
  const mediaType = imageMediaTypes[extname(path).toLowerCase()]
  if (mediaType !== undefined) return Effect.succeed(mediaType)
  return new SpecialtyToolsError({
    message: `Unsupported painter reference image type: ${inputPath}`,
    operation: "painterReferenceImage",
    retryable: false,
  })
}

const imageMediaTypes: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

const isOutside = (workspaceRoot: string, path: string) => {
  const rel = relative(workspaceRoot, resolve(path))
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

const slashPath = (path: string) => path.split(sep).join("/")
