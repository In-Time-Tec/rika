import * as ThreadRepository from "@rika/product/thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ExecutionRecovery from "./execution-recovery-dispatch"
import * as ContextMentions from "../../context/context-mention-parser"
import * as FileMentions from "../../context/file-mention-parser"
import * as ResolvedContext from "../../context/context-resolution-service"
import { Context, Effect } from "effect"
import { operationError } from "../operation-error"

const untrustedData = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")
const markdownExport = (thread: Thread.Thread, turns: ReadonlyArray<Turn.Turn>) =>
  turns.map((turn) => turn.prompt).join("\\n")

export const makeExecutionContext = (input: any) =>
  Effect.sync(() => {
    const {
      options,
      extensionService,
      executionDependencies,
      claimTurnObserver,
      releaseTurnObserver,
      claimQueuedTurn,
    } = input
    const typedExecutionDependencies: Context.Context<
      | TurnRepository.Service
      | ThreadRepository.Service
      | ResolvedContext.Service
      | ExecutionExtensions.ExecutionExtensionService
    > = executionDependencies
    const { startReviewSettlement } = input
    const testRoute = (mode: Parameters<typeof ExecutionRouteSnapshot.testExecutionRoute>[0]) =>
      Effect.succeed(ExecutionRouteSnapshot.testExecutionRoute(mode))
    const resolveExecutionRoute = options.resolveExecutionRoute ?? testRoute
    const executionPrompt = Effect.fn("ProductOperation.executionPrompt")(function* (
      workspace: string,
      prompt: string,
      promptParts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    ) {
      const context = yield* ResolvedContext.Service
      const threads = yield* ThreadRepository.Service
      const authored =
        promptParts === undefined
          ? prompt
          : promptParts.flatMap((part) => (part.type === "text" && part.pasted !== true ? [part.text] : [])).join("\n")
      const structured = ContextMentions.parse(authored)
      const bareMentions = [...new Set(FileMentions.parse(authored))].filter(
        (value) => !/^(?:file|ref|guidance|image):/.test(value),
      )
      const mentionKinds = yield* Effect.forEach(
        bareMentions,
        (value) =>
          threads
            .get(Thread.ThreadId.make(value))
            .pipe(Effect.map((thread) => ({ value, isThread: thread !== undefined }))),
        { concurrency: 1 },
      )
      const files = [
        ...new Set([
          ...mentionKinds.filter(({ isThread }) => !isThread).map(({ value }) => value),
          ...structured.files,
          ...structured.images,
        ]),
      ].toSorted()
      const threadIds = [...new Set(mentionKinds.filter(({ isThread }) => isThread).map(({ value }) => value))]
      const resolved = yield* context.resolve({
        workspace,
        targetPaths: files,
        references: [...files, ...structured.references],
      })
      const turns = yield* TurnRepository.Service
      const threadBlocks = yield* Effect.forEach(
        threadIds,
        (id) =>
          Effect.gen(function* () {
            const thread = yield* threads.get(Thread.ThreadId.make(id))
            if (thread === undefined) return `Thread ${id} was not found`
            const history = yield* turns.list(thread.id)
            return `<thread-data format="json">${untrustedData({ id, content: markdownExport(thread, history) })}</thread-data>`
          }),
        { concurrency: 1 },
      )
      const messages = resolved.diagnostics.map((diagnostic) => diagnostic.message + `: ${diagnostic.path}`)
      if (resolved.sources.length === 0 && threadBlocks.length === 0)
        return { prompt, digest: resolved.digest, messages }
      const block = [
        ...resolved.sources.map((source) =>
          source.kind === "guidance"
            ? `<guidance-instructions path=${JSON.stringify(source.path)}>\n${source.content}\n</guidance-instructions>`
            : `<reference-data format="json">${untrustedData({ path: source.path, content: source.content })}</reference-data>`,
        ),
        ...threadBlocks,
      ].join("\n\n")
      return {
        prompt: `${prompt}\n\n<resolved-context>\n${block}\n</resolved-context>`,
        digest: resolved.digest,
        messages,
      }
    })
    const prepareExecution = Effect.fn("ProductOperation.prepareExecution")(function* (
      turn: Turn.AgentExecutionTurn,
      workspace: string,
      persistExtensionPin: boolean = true,
    ) {
      const resolved = yield* executionPrompt(workspace, turn.prompt, turn.promptParts)
      let promptParts = turn.promptParts
      if (promptParts !== undefined && resolved.prompt !== turn.prompt) {
        promptParts = [...promptParts, { type: "text" as const, text: resolved.prompt.slice(turn.prompt.length) }]
      }
      if (options.executionExtensions === undefined)
        return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
      const extensions = yield* ExecutionExtensions.ExecutionExtensionService
      if (turn.extensionPin !== undefined) {
        yield* extensions.resume(turn.extensionPin)
        return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
      }
      const activated = yield* extensions.future(yield* options.executionExtensions.mcpFingerprint, resolved.digest)
      if (persistExtensionPin) {
        const turns = yield* TurnRepository.Service
        yield* turns.setExtensionPin(turn.id, activated.pin)
      }
      return { prompt: resolved.prompt, promptParts, extensionPin: activated.pin, messages: resolved.messages }
    })
    const reconcileExecutions = ExecutionRecovery.reconcileInternal(
      extensionService,
      (turn, workspace) =>
        prepareExecution(turn, workspace, false).pipe(Effect.mapError((error) => operationError(String(error)))) as any,
      (turn, inspection) =>
        startReviewSettlement(turn, inspection.fanOutId, inspection).pipe(
          Effect.asVoid,
          Effect.mapError((error) => operationError(String(error))),
        ) as any,
      {
        claim: (turn) => claimTurnObserver(turn.id, turn.status),
        release: releaseTurnObserver,
        claimQueued: claimQueuedTurn,
      },
      false,
    ).pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.scoped,
      Effect.mapError((error) => operationError(String(error))),
    )
    return { resolveExecutionRoute, executionPrompt, prepareExecution, reconcileExecutions }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
