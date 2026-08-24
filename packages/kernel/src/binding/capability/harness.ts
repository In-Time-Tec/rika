import { DateTime, Effect, Result, Schema } from "effect"
import {
  Authorship,
  HarnessEntry,
  HarnessMerge,
  HarnessOverview,
  HarnessState,
  HarnessStore,
  Refinement,
} from "tenetkit/harness"
import { ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as ScopePolicy from "../../harness/scope-policy"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

export const name = "harness"

export class HarnessRejected extends Schema.TaggedError<HarnessRejected>()("HarnessRejected", {
  reason: Schema.String,
  message: Schema.String,
  target: Schema.optionalKey(Schema.String),
}) {}

const Failure = Schema.Union([HarnessRejected, NestedOperationFailed])

const Scope = ScopePolicy.ScopeName
type Scope = ScopePolicy.ScopeName

const Applied = Schema.Struct({ snapshotId: HarnessEntry.HarnessSnapshotId, applied: Schema.Int })

const SnapshotInput = Schema.Struct({ scope: Schema.optionalKey(Scope) })
const OverviewInput = Schema.Struct({ scope: Schema.optionalKey(Scope) })

/**
 * `baseSnapshot` is REQUIRED here even though `tenetkit/harness` types it optional. HarnessStore
 * offers only load and save with no compare-and-swap, so every mutation is a whole-scope
 * read-modify-write and two concurrent cells would silently lose an update. Requiring the baseline
 * turns that race into an observable `baseline-drift` rejection the model can retry.
 */
const Authored = {
  id: HarnessEntry.HarnessId,
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  content: Schema.String.check(Schema.isMaxLength(65_536)),
  baseSnapshot: HarnessEntry.HarnessSnapshotId,
  path: Schema.optionalKey(Schema.String),
  reference: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  source: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Scope),
}

const CreateInput = Schema.Struct(Authored)
const UpdateInput = Schema.Struct({ ...Authored, baseVersion: Schema.optionalKey(HarnessEntry.HarnessVersion) })
const DeleteInput = Schema.Struct({
  id: HarnessEntry.HarnessId,
  baseSnapshot: HarnessEntry.HarnessSnapshotId,
  baseVersion: Schema.optionalKey(HarnessEntry.HarnessVersion),
  scope: Schema.optionalKey(Scope),
})
const RefineInput = Schema.Struct({
  rationale: Schema.String.check(Schema.isMaxLength(65_536)),
  edits: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  baseSnapshot: HarnessEntry.HarnessSnapshotId,
  scope: Schema.optionalKey(Scope),
})
const RollbackInput = Schema.Struct({
  refinementId: HarnessEntry.HarnessId,
  scope: Schema.optionalKey(Scope),
})

/**
 * A refinement event carries a copy of every entry it touched, so retaining them all makes a
 * long-lived scope grow with its own history rather than with what it knows. The overview already
 * bounds what a prompt reads, so this bounds only what the store keeps.
 *
 * Entry counts are deliberately left unbounded: capacity is checked against the entries a proposal
 * would leave behind, so binding it would start refusing a model's writes once a scope filled up.
 */
const applyOptions = { maxRefinements: 200 } as const

interface RejectionDetails {
  reason: string
  message: string
  target?: string
}

const rejected = (reason: string, message: string, target?: string) => {
  const details: RejectionDetails = { reason, message }
  if (target !== undefined) details.target = target
  return HarnessRejected.make(details)
}

const kinds = { memory: "memory", skill: "skill", subagent: "subagent", promptNote: "prompt" } as const
type AuthoredKind = keyof typeof kinds

const instant = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/(\.\d{3})?\d*Z$/, (match) =>
      match.length === 5 ? match : ".000Z",
    ),
)

export interface Options {
  readonly workspaceDigest: string
}

export const make = (options: Options): HostBindingRegistry.Module<HarnessStore.HarnessStore | Requirements> => {
  const scopeOf = (scope: Scope | undefined) =>
    Effect.map(ToolContext.ToolContext, (context) =>
      ScopePolicy.scopeString(scope ?? "thread", {
        thread: context.sessionId,
        workspaceDigest: options.workspaceDigest,
      }),
    )

  const load = (scope: Scope | undefined) =>
    Effect.flatMap(scopeOf(scope), (resolved) =>
      Effect.flatMap(HarnessStore.HarnessStore, (store) =>
        store.load(resolved).pipe(Effect.mapError((error) => rejected(error.reason, error.message))),
      ),
    )

  const merged = Effect.gen(function* () {
    const store = yield* HarnessStore.HarnessStore
    const states = yield* Effect.forEach(ScopePolicy.mergeOrder, (level) =>
      Effect.flatMap(scopeOf(level), (scope) => store.load(scope)),
    )
    return states.reduce((outer, inner) => HarnessMerge.mergeStates(outer, inner))
  }).pipe(Effect.mapError((error) => rejected(error.reason, error.message)))

  /**
   * Cell input is authored through Authorship.authorProposal, which rejects a caller-supplied
   * revision and decodes with onExcessProperty "error". A binding that built a RefinementEdit
   * directly from cell input would let model code forge createdAt, updatedAt, and version.
   */
  const apply = (input: {
    readonly scope: Scope | undefined
    readonly baseSnapshot: string
    readonly rationale?: string
    readonly edits: ReadonlyArray<unknown>
  }) =>
    Effect.gen(function* () {
      const at = yield* instant
      const authored = {
        id: `refine-${at.replaceAll(/[:.TZ-]/g, "")}`,
        at,
        baseSnapshot: input.baseSnapshot,
        edits: input.edits,
      }
      const proposal = yield* Authorship.authorProposal(
        input.rationale === undefined ? authored : { ...authored, rationale: input.rationale },
      ).pipe(Effect.mapError((error) => rejected(error.reason, error.message)))
      const state = yield* load(input.scope)
      const result = Refinement.applyProposal(state, proposal, applyOptions)
      if (Result.isFailure(result))
        return yield* rejected(result.failure.reason, result.failure.message, result.failure.target)
      const store = yield* HarnessStore.HarnessStore
      yield* store.save(result.success.state).pipe(Effect.mapError((error) => rejected(error.reason, error.message)))
      return {
        snapshotId: HarnessState.snapshotId(result.success.state),
        applied: result.success.event.applied.length,
      }
    })

  const createOperation = (kind: AuthoredKind) =>
    operation({
      name: `create${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
      input: CreateInput,
      output: Applied,
      failure: Failure,
      handle: (input: typeof CreateInput.Type) =>
        nested(
          { kind: "harness.refine", payload: input, replayPolicy: "never" },
          apply({
            scope: input.scope,
            baseSnapshot: input.baseSnapshot,
            edits: [{ _tag: "Create", kind: kinds[kind], id: input.id, value: valueOf(input) }],
          }),
        ),
    })

  const updateOperation = (kind: AuthoredKind) =>
    operation({
      name: `update${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
      input: UpdateInput,
      output: Applied,
      failure: Failure,
      handle: (input: typeof UpdateInput.Type) =>
        nested(
          { kind: "harness.refine", payload: input, replayPolicy: "never" },
          apply({
            scope: input.scope,
            baseSnapshot: input.baseSnapshot,
            edits: [updateEdit(kind, input)],
          }),
        ),
    })

  const deleteOperation = (kind: AuthoredKind) =>
    operation({
      name: `delete${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
      input: DeleteInput,
      output: Applied,
      failure: Failure,
      handle: (input: typeof DeleteInput.Type) =>
        nested(
          { kind: "harness.refine", payload: input, replayPolicy: "never" },
          apply({
            scope: input.scope,
            baseSnapshot: input.baseSnapshot,
            edits: [deleteEdit(kind, input)],
          }),
        ),
    })

  const authoredKinds: ReadonlyArray<AuthoredKind> = ["memory", "skill", "subagent", "promptNote"]

  return {
    name,
    operations: [
      operation({
        name: "snapshot",
        input: SnapshotInput,
        /**
         * The snapshot carries the identity a write has to name, because a cell cannot derive it:
         * it is a digest of the state the host holds, and asking for one a caller cannot compute
         * makes every write a guess.
         */
        output: Schema.Struct({
          ...HarnessState.HarnessState.fields,
          snapshotId: HarnessEntry.HarnessSnapshotId,
        }),
        failure: Failure,
        handle: (input) =>
          Effect.map(input.scope === undefined ? merged : load(input.scope), (state) => ({
            ...state,
            snapshotId: HarnessState.snapshotId(state),
          })),
      }),
      operation({
        name: "overview",
        input: OverviewInput,
        output: Schema.Struct({ text: Schema.String }),
        failure: Failure,
        handle: (input) =>
          Effect.map(input.scope === undefined ? merged : load(input.scope), (state) => ({
            text: HarnessOverview.formatOverview(state),
          })),
      }),
      ...authoredKinds.map(createOperation),
      ...authoredKinds.map(updateOperation),
      ...authoredKinds.map(deleteOperation),
      operation({
        name: "recordRefinement",
        input: RefineInput,
        output: Applied,
        failure: Failure,
        handle: (input) =>
          nested(
            { kind: "harness.refine", payload: input, replayPolicy: "never" },
            apply({
              scope: input.scope,
              baseSnapshot: input.baseSnapshot,
              rationale: input.rationale,
              edits: input.edits,
            }),
          ),
      }),
      operation({
        name: "rollback",
        input: RollbackInput,
        output: Applied,
        failure: Failure,
        handle: (input) =>
          nested(
            { kind: "harness.refine", payload: input, replayPolicy: "never" },
            Effect.gen(function* () {
              const state = yield* load(input.scope)
              const event = state.refinements.find((candidate) => candidate.proposal === input.refinementId)
              if (event === undefined)
                return yield* rejected("unknown-refinement", `No refinement is recorded under ${input.refinementId}`)
              const at = yield* instant
              const proposal = Refinement.rollbackProposal(
                { state, event },
                { id: `rollback-${input.refinementId}`, at },
              )
              const result = Refinement.applyTrustedProposal(state, proposal)
              if (Result.isFailure(result))
                return yield* rejected(result.failure.reason, result.failure.message, result.failure.target)
              const store = yield* HarnessStore.HarnessStore
              yield* store
                .save(result.success.state)
                .pipe(Effect.mapError((error) => rejected(error.reason, error.message)))
              return {
                snapshotId: HarnessState.snapshotId(result.success.state),
                applied: result.success.event.applied.length,
              }
            }),
          ),
      }),
    ],
  }
}

interface AuthoredValue {
  title: string
  content: string
  path?: string
  reference?: string
  arguments?: Record<string, Schema.Json>
  metadata?: Record<string, Schema.Json>
  source?: string
}

const valueOf = (input: {
  readonly title: string
  readonly content: string
  readonly path?: string
  readonly reference?: string
  readonly arguments?: Record<string, Schema.Json>
  readonly metadata?: Record<string, Schema.Json>
  readonly source?: string
}) => {
  const value: AuthoredValue = { title: input.title, content: input.content }
  if (input.path !== undefined) value.path = input.path
  if (input.reference !== undefined) value.reference = input.reference
  if (input.arguments !== undefined) value.arguments = input.arguments
  if (input.metadata !== undefined) value.metadata = input.metadata
  if (input.source !== undefined) value.source = input.source
  return value
}

const updateEdit = (kind: AuthoredKind, input: typeof UpdateInput.Type) => {
  const edit = { _tag: "Update" as const, kind: kinds[kind], id: input.id, value: valueOf(input) }
  return input.baseVersion === undefined ? edit : { ...edit, baseVersion: input.baseVersion }
}

const deleteEdit = (kind: AuthoredKind, input: typeof DeleteInput.Type) => {
  const edit = { _tag: "Delete" as const, kind: kinds[kind], id: input.id }
  return input.baseVersion === undefined ? edit : { ...edit, baseVersion: input.baseVersion }
}
