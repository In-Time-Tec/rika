import {
  BoxWorkspaceInputDocument,
  BoxWorkspaceInputReceipt,
  boxWorkspaceInputPartPath,
  boxWorkspaceInputPaths,
  type BoxWorkspaceInputArchive,
  type BoxWorkspaceInputDocument as BoxWorkspaceInputDocumentType,
  type BoxWorkspaceInputPolicy,
  workspaceInputChunkBytes,
  workspaceInputDirectory,
  workspaceInputReceiptRelativePath,
  workspaceInputWorkspace,
} from "@rika/box-executor/workspace-input-contract"
import { restoreArchive } from "@rika/workspace-input/archive"
import { Archive } from "@rika/workspace-input/contract"
import {
  RepositoryInput,
  type RepositoryInputError,
  RepositoryInputFormat,
  restoreRepositoryInput,
} from "@rika/workspace-input/repository"
import { Crypto, Effect, Encoding, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

export const maxWorkspaceInputDocumentBytes = 65_536
const workspaceInputMaxParts = 128
const workspaceInputTimeout = "10 seconds"

export interface BoxWorkspaceInputOptions {
  readonly inputDirectory?: string
  readonly workspace?: string
}

export class BoxWorkspaceInputModeError extends Schema.TaggedError<BoxWorkspaceInputModeError>()(
  "RikaRunnerV2BoxWorkspaceInputModeError",
  {
    reason: Schema.Literals(["input", "timeout", "policy", "archive", "transport", "conflict", "process"]),
    message: Schema.String,
  },
) {}

export type BoxWorkspaceInputFailure = BoxWorkspaceInputModeError
export type BoxWorkspaceInputRequirements =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Stdio.Stdio

const failure = (reason: BoxWorkspaceInputModeError["reason"], message: string) =>
  BoxWorkspaceInputModeError.make({ reason, message })

const readDocument = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const chunks: Array<Uint8Array> = []
  let total = 0
  yield* Stream.runForEach(stdio.stdin, (chunk) => {
    if (chunk.byteLength > maxWorkspaceInputDocumentBytes - total)
      return Effect.fail(failure("input", "Box workspace input document is invalid"))
    return Effect.sync(() => {
      chunks.push(chunk)
      total += chunk.byteLength
    })
  }).pipe(
    Effect.mapError(() => failure("input", "Box workspace input document is invalid")),
    Effect.timeoutOrElse({
      duration: workspaceInputTimeout,
      orElse: () => Effect.fail(failure("timeout", "Box workspace input timed out")),
    }),
  )
  if (total === 0) return yield* failure("input", "Box workspace input document is invalid")
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => failure("input", "Box workspace input document is invalid"),
  })
  return yield* Schema.decodeEffect(Schema.fromJsonString(BoxWorkspaceInputDocument))(text).pipe(
    Effect.mapError(() => failure("input", "Box workspace input document is invalid")),
  )
})

const validatePolicy = (document: BoxWorkspaceInputDocumentType): Effect.Effect<void, BoxWorkspaceInputModeError> => {
  const policy = document.policy
  if (
    (document.repository === null) !== (policy.checkout === null) ||
    (document.seed === null) !== (policy.seed === null)
  )
    return failure("policy", "Box workspace input document does not match its policy")
  if (
    document.seed !== null &&
    policy.seed !== null &&
    (document.seed.contentDigest !== policy.seed.archiveDigest ||
      document.seed.sizeBytes !== policy.seed.archiveSizeBytes)
  )
    return failure("policy", "Box workspace input seed does not match its policy")
  return Effect.void
}

const readReceiptText = Effect.fn("BoxWorkspaceInput.readReceiptText")(function* (receiptPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem
    .readFileString(receiptPath)
    .pipe(Effect.catch((error) => (error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error))))
})

const receiptMatches = (policyDigest: string, text: string | null): Effect.Effect<boolean> =>
  text === null
    ? Effect.succeed(false)
    : Schema.decodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))(text).pipe(
        Effect.map((stored) => stored.policyDigest === policyDigest),
        Effect.orElseSucceed(() => false),
      )

const requireFreshWorkspace = Effect.fn("BoxWorkspaceInput.requireFreshWorkspace")(function* (workspace: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fileSystem.readLink(workspace).pipe(Effect.option)))
    return yield* failure("conflict", "Box workspace is already occupied")
  const entries = yield* fileSystem
    .readDirectory(workspace)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(failure("conflict", "Box workspace could not be inspected")),
      ),
    )
  if (entries.length > 0) return yield* failure("conflict", "Box workspace is already occupied")
})

const assembleSource = Effect.fn("BoxWorkspaceInput.assembleSource")(function* (input: {
  readonly policy: BoxWorkspaceInputPolicy
  readonly directory: string
  readonly source: "repository" | "seed"
  readonly descriptor: BoxWorkspaceInputArchive
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const descriptor = input.descriptor
  const count = Math.ceil(descriptor.sizeBytes / workspaceInputChunkBytes)
  if (count > workspaceInputMaxParts)
    return yield* failure("archive", "Box workspace input archive exceeds the allowed size")
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (let part = 0; part < count; part += 1) {
    const chunk = yield* fileSystem
      .readFile(
        boxWorkspaceInputPartPath({ policy: input.policy, source: input.source, part, directory: input.directory }),
      )
      .pipe(Effect.mapError(() => failure("transport", "Box workspace input part is missing")))
    chunks.push(chunk)
    total += chunk.byteLength
    if (total > descriptor.sizeBytes) return yield* failure("archive", "Box workspace input archive is invalid")
  }
  if (total !== descriptor.sizeBytes) return yield* failure("archive", "Box workspace input archive is invalid")
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const digest = yield* crypto
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => failure("process", "Box workspace input digest could not be computed")))
  if (`sha256:${Encoding.encodeHex(digest)}` !== descriptor.contentDigest)
    return yield* failure("archive", "Box workspace input archive digest is invalid")
  return Archive.make({ bytes, contentDigest: descriptor.contentDigest, sizeBytes: descriptor.sizeBytes })
})

const repositoryReason = (kind: RepositoryInputError["kind"]): BoxWorkspaceInputModeError["reason"] => {
  switch (kind) {
    case "workspace":
      return "conflict"
    case "input":
      return "policy"
    default:
      return "archive"
  }
}

const stageWorkspace = Effect.fn("BoxWorkspaceInput.stageWorkspace")(function* (input: {
  readonly directory: string
  readonly staging: string
  readonly checkout: BoxWorkspaceInputPolicy["checkout"]
  readonly repositoryArchive: Archive | null
  readonly seedArchive: Archive | null
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const staging = input.staging
  yield* fileSystem
    .remove(staging, { recursive: true, force: true })
    .pipe(Effect.mapError(() => failure("process", "Box workspace input staging could not be prepared")))
  yield* fileSystem
    .makeDirectory(input.directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => failure("process", "Box workspace input staging could not be prepared")))
  const checkout = input.checkout
  if (input.repositoryArchive !== null && checkout !== null)
    yield* restoreRepositoryInput({
      workspace: staging,
      input: RepositoryInput.make({
        format: RepositoryInputFormat,
        metadata: {
          version: 1,
          source: { owner: checkout.owner, name: checkout.name },
          commitSha: checkout.commitSha,
          gitIdentity: checkout.gitIdentity,
        },
        archive: input.repositoryArchive,
      }),
    }).pipe(
      Effect.mapError((error) =>
        failure(repositoryReason(error.kind), "Box workspace repository input could not be restored"),
      ),
    )
  if (input.seedArchive !== null)
    yield* restoreArchive(staging, input.seedArchive).pipe(
      Effect.mapError(() => failure("archive", "Box workspace seed could not be restored")),
    )
  if (input.repositoryArchive === null && input.seedArchive === null)
    yield* fileSystem
      .makeDirectory(staging, { mode: 0o700 })
      .pipe(Effect.mapError(() => failure("process", "Box workspace input staging could not be prepared")))
})

const stageReceipt = Effect.fn("BoxWorkspaceInput.stageReceipt")(function* (staging: string, encodedReceipt: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stagedReceipt = `${staging}/${workspaceInputReceiptRelativePath}`
  yield* fileSystem
    .makeDirectory(path.dirname(stagedReceipt), { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => failure("process", "Box workspace input receipt could not be staged")))
  yield* fileSystem
    .writeFileString(stagedReceipt, encodedReceipt, { mode: 0o600 })
    .pipe(Effect.mapError(() => failure("process", "Box workspace input receipt could not be staged")))
})

export const runWorkspaceInput = (
  options: BoxWorkspaceInputOptions = {},
): Effect.Effect<BoxWorkspaceInputReceipt, BoxWorkspaceInputFailure, BoxWorkspaceInputRequirements> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const stdio = yield* Stdio.Stdio
    const inputDirectory = options.inputDirectory ?? workspaceInputDirectory
    const workspace = options.workspace ?? workspaceInputWorkspace

    const document = yield* readDocument
    const paths = boxWorkspaceInputPaths(document.policy, inputDirectory)
    const receipt = BoxWorkspaceInputReceipt.make({ version: 1, policyDigest: paths.policyDigest })
    const encodedReceipt = yield* Schema.encodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))(receipt).pipe(
      Effect.mapError(() => failure("process", "Box workspace input receipt could not be encoded")),
    )
    const printReceipt = Stream.run(Stream.make(encodedReceipt), stdio.stdout()).pipe(
      Effect.mapError(() => failure("process", "Box workspace input receipt could not be written")),
    )
    const receiptPath = `${workspace}/${workspaceInputReceiptRelativePath}`

    yield* validatePolicy(document)

    const storedText = yield* readReceiptText(receiptPath).pipe(
      Effect.mapError(() => failure("conflict", "Box workspace input receipt could not be inspected")),
    )
    if (storedText !== null) {
      if (!(yield* receiptMatches(paths.policyDigest, storedText)))
        return yield* failure("conflict", "Box workspace input receipt does not match the materialization policy")
      yield* printReceipt
      return receipt
    }

    yield* requireFreshWorkspace(workspace)

    const repositoryArchive =
      document.repository === null
        ? null
        : yield* assembleSource({
            policy: document.policy,
            directory: inputDirectory,
            source: "repository",
            descriptor: document.repository,
          })
    const seedArchive =
      document.seed === null
        ? null
        : yield* assembleSource({
            policy: document.policy,
            directory: inputDirectory,
            source: "seed",
            descriptor: document.seed,
          })

    const staging = `${paths.directory}/staging`
    yield* stageWorkspace({
      directory: paths.directory,
      staging,
      checkout: document.policy.checkout,
      repositoryArchive,
      seedArchive,
    })
    yield* stageReceipt(staging, encodedReceipt)

    const published = yield* fileSystem.rename(staging, workspace).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (!published) {
      const landed = yield* receiptMatches(
        paths.policyDigest,
        yield* readReceiptText(receiptPath).pipe(Effect.orElseSucceed(() => null)),
      )
      if (!landed) return yield* failure("conflict", "Box workspace became occupied before publication")
    }
    yield* printReceipt
    yield* fileSystem.remove(paths.directory, { recursive: true, force: true }).pipe(Effect.ignore)
    return receipt
  })
