import type { Archive } from "@rika/workspace-input/contract"
import { Effect, Encoding, Redacted, Schema } from "effect"
import { bootstrapHttp, FileMissingResponse, FileReadResponse, FileWriteResponse } from "./bootstrap-http"
import { BoxId } from "./contract"
import type { BoxTransport } from "./provider"
import {
  BoxWorkspaceInputDocument,
  BoxWorkspaceInputError,
  BoxWorkspaceInputPolicy,
  BoxWorkspaceInputReceipt,
  boxWorkspaceInputPartPath,
  boxWorkspaceInputPaths,
  workspaceInputChunkBytes,
  workspaceInputDirectory,
} from "./workspace-input-contract"

export interface BoxWorkspaceInputClient {
  readonly inspect: (input: { readonly boxId: BoxId; readonly policy: BoxWorkspaceInputPolicy }) =>
    Effect.Effect<boolean, BoxWorkspaceInputError>
  readonly materialize: (input: {
    readonly boxId: BoxId
    readonly policy: BoxWorkspaceInputPolicy
    readonly repository: Archive | null
    readonly seed: Archive | null
  }) => Effect.Effect<BoxWorkspaceInputReceipt, BoxWorkspaceInputError>
}

const failure = (reason: BoxWorkspaceInputError["reason"]) => BoxWorkspaceInputError.make({
  reason,
  message: "Box workspace input could not be materialized safely",
})
const FileWrite = Schema.Struct({ path: Schema.String, content: Schema.String, encoding: Schema.Literals(["utf8", "base64"]) })
const Command = Schema.Struct({ command: Schema.String, detached: Schema.Literal(false), timeoutSeconds: Schema.Literal(120) })
const CommandResult = Schema.Struct({ success: Schema.Literal(true), exitCode: Schema.Literal(0), timedOut: Schema.Literal(false), stdout: Schema.String })
const descriptor = (archive: Archive | null) => archive === null ? null : ({
  contentDigest: archive.contentDigest,
  sizeBytes: archive.sizeBytes,
})

export const makeBoxWorkspaceInputClient = (options: {
  readonly baseUrl: string | URL
  readonly apiKey: Redacted.Redacted<string>
  readonly transport: BoxTransport
}): BoxWorkspaceInputClient => {
  const base = new URL(options.baseUrl)
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0
  )
    throw new Error("Box workspace input endpoint is invalid")
  const key = Redacted.value(options.apiKey)
  if (key.length === 0) throw new Error("Box workspace input credential is missing")
  const responseText = (response: Response) =>
    bootstrapHttp.responseText(response, "enroll", 131_072).pipe(Effect.mapError(() => failure("transport")))
  const send = (input: { readonly method: string; readonly path: string; readonly body?: string; readonly query?: Record<string, string> }) => {
    if (input.body !== undefined && input.body.includes(key)) return Effect.fail(failure("policy"))
    const url = new URL(input.path, `${base.toString().replace(/\/$/, "")}/`)
    for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value)
    const headers = new Headers({ authorization: `Bearer ${key}` })
    if (input.body !== undefined) headers.set("content-type", "application/json")
    const init: RequestInit = { method: input.method, headers }
    if (input.body !== undefined) init.body = input.body
    const request = new Request(url.toString(), init)
    return options.transport.request(request).pipe(
      Effect.flatMap((response) => responseText(response).pipe(Effect.map((text) => ({ status: response.status, text })))),
      Effect.timeout("150 seconds"),
      Effect.mapError(() => failure("transport")),
    )
  }
  const write = (boxId: BoxId, body: typeof FileWrite.Type) => Schema.encodeEffect(Schema.fromJsonString(FileWrite))(body).pipe(
    Effect.flatMap((encoded) => send({ method: "PUT", path: `boxes/${boxId}/files`, body: encoded })),
    Effect.flatMap((response) => response.status >= 200 && response.status < 300
      ? Schema.decodeEffect(Schema.fromJsonString(FileWriteResponse))(response.text).pipe(Effect.mapError(() => failure("transport")))
      : Effect.fail(failure("transport"))),
    Effect.asVoid,
    Effect.mapError(() => failure("transport")),
  )
  const command = (boxId: BoxId, value: string) => Schema.encodeEffect(Schema.fromJsonString(Command))({
    command: value, detached: false, timeoutSeconds: 120,
  }).pipe(
    Effect.flatMap((body) => send({ method: "POST", path: `boxes/${boxId}/commands`, body })),
    Effect.flatMap((response) => response.status >= 200 && response.status < 300
      ? Schema.decodeEffect(Schema.fromJsonString(CommandResult))(response.text).pipe(Effect.mapError(() => failure("process")))
      : Effect.fail(failure("transport"))),
    Effect.map((result) => result.stdout),
    Effect.mapError(() => failure("process")),
  )
  const inspect: BoxWorkspaceInputClient["inspect"] = (input) => Effect.gen(function* () {
    const boxId = yield* Schema.decodeEffect(BoxId)(input.boxId)
    const policy = yield* Schema.decodeEffect(BoxWorkspaceInputPolicy)(input.policy)
    const paths = boxWorkspaceInputPaths(policy)
    const response = yield* send({ method: "GET", path: `boxes/${boxId}/files`, query: { path: paths.receipt, encoding: "utf8" } })
    if (response.status === 404) return false
    if (response.status === 400) {
      const missing = yield* Schema.decodeEffect(Schema.fromJsonString(FileMissingResponse))(response.text)
      if (missing.message === `ENOENT: no such file or directory, stat '${paths.receipt}'`) return false
      return yield* failure("transport")
    }
    if (response.status < 200 || response.status >= 300) return yield* failure("transport")
    const read = yield* Schema.decodeEffect(Schema.fromJsonString(FileReadResponse))(response.text)
    // The Box files API acknowledges the requested path, relativized to the workspace home: paths outside it keep
    // the `../..` escape form while paths beneath it collapse to their home-relative form.
    const homePrefix = "/home/user/"
    const homeRelative = paths.receipt.startsWith(homePrefix) ? paths.receipt.slice(homePrefix.length) : undefined
    if (read.path !== paths.receipt && read.path !== `../..${paths.receipt}` && read.path !== homeRelative)
      return yield* failure("transport")
    const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))(read.content)
    if (receipt.policyDigest !== paths.policyDigest) return yield* failure("conflict")
    return true
  }).pipe(Effect.mapError(() => failure("policy")))

  const materialize: BoxWorkspaceInputClient["materialize"] = (input) => Effect.gen(function* () {
    const boxId = yield* Schema.decodeEffect(BoxId)(input.boxId)
    const policy = yield* Schema.decodeEffect(BoxWorkspaceInputPolicy)(input.policy)
    const paths = boxWorkspaceInputPaths(policy)
    if (yield* inspect({ boxId, policy })) return BoxWorkspaceInputReceipt.make({ version: 1, policyDigest: paths.policyDigest })
    const document = yield* Schema.decodeEffect(BoxWorkspaceInputDocument)({
      _tag: "Materialize", version: 1, policy,
      repository: descriptor(input.repository), seed: descriptor(input.seed),
    })
    if ((policy.checkout === null) !== (input.repository === null) || (policy.seed === null) !== (input.seed === null))
      return yield* failure("policy")
    if (input.seed !== null && (input.seed.contentDigest !== policy.seed?.archiveDigest || input.seed.sizeBytes !== policy.seed.archiveSizeBytes))
      return yield* failure("archive")
    yield* command(boxId, `mkdir -p -- '${paths.directory}'`)
    for (const source of ["repository", "seed"] as const) {
      const archive = input[source]
      if (archive === null) continue
      if (archive.bytes.byteLength !== archive.sizeBytes) return yield* failure("archive")
      const count = Math.ceil(archive.sizeBytes / workspaceInputChunkBytes)
      for (let part = 0; part < count; part += 1) {
        const bytes = archive.bytes.subarray(part * workspaceInputChunkBytes, (part + 1) * workspaceInputChunkBytes)
        yield* write(boxId, { path: boxWorkspaceInputPartPath({ policy, source, part }), content: Encoding.encodeBase64(bytes), encoding: "base64" })
      }
    }
    yield* write(boxId, { path: paths.document, content: yield* Schema.encodeEffect(Schema.fromJsonString(BoxWorkspaceInputDocument))(document), encoding: "utf8" })
    const stdout = yield* command(boxId,
      `flock -n '${workspaceInputDirectory}/materialize.lock' /usr/local/bin/rika-executor workspace-input --stdin < '${paths.document}'`,
    )
    const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(BoxWorkspaceInputReceipt))(stdout)
    if (receipt.policyDigest !== paths.policyDigest || !(yield* inspect({ boxId, policy }))) return yield* failure("process")
    return receipt
  }).pipe(Effect.mapError(() => failure("process")))
  return { inspect, materialize }
}
