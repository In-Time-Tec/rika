import {
  HandshakeEvidence,
  WorkspaceBinding,
  sameBinding,
  sameEvidence,
  type WorkspaceBinding as WorkspaceBindingValue,
} from "@rika/execution"
import { Clock, Effect, Redacted, Schema } from "effect"
import { Pins } from "generalist"

import { BoxId, type BoxId as BoxIdValue } from "./contract"
import { WorkspaceEnrollmentError, type WorkspaceEnrollmentService } from "./enrollment"
import {
  bootstrapHttp,
  CommandStartedResponse,
  FileMissingResponse,
  FileReadResponse,
  FileWriteResponse,
} from "./bootstrap-http"
import type { BoxTransport } from "./provider"

export const maxBootstrapResponseBytes = 131_072
export const maxBootstrapDocumentBytes = 32_768
export const boxBootstrapDirectory = "/tmp/rika-box-executor-v2"
export const boxBootstrapLockPath = `${boxBootstrapDirectory}/runner.lock`
export const boxBootstrapPaths = (binding: WorkspaceBindingValue) => {
  const directory = `${boxBootstrapDirectory}/${Pins.digest(binding)}`
  return { directory, documentPath: `${directory}/enrollment.json`, statePath: `${directory}/state.json` }
}

const EpochMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const BoundedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))

const BoxBootstrapState = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "starting", "failed"]),
  binding: WorkspaceBinding,
  workspacePath: BoundedString,
})
type BoxBootstrapState = typeof BoxBootstrapState.Type

export const BoxBootstrapDocument = Schema.Struct({
  version: Schema.Literal(1),
  boxId: BoxId,
  binding: WorkspaceBinding,
  workspacePath: BoundedString,
  enrollment: Schema.Struct({
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    ticket: BoundedString,
    expiresAtMillis: EpochMillis,
  }),
})
export type BoxBootstrapDocument = typeof BoxBootstrapDocument.Type

const FileWriteRequest = Schema.Struct({
  path: BoundedString,
  content: Schema.String,
  encoding: Schema.Literal("utf8"),
})

const CommandRequest = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  detached: Schema.Literal(true),
})

const encodeFileWriteRequest = Schema.encodeEffect(Schema.fromJsonString(FileWriteRequest))
const encodeCommandRequest = Schema.encodeEffect(Schema.fromJsonString(CommandRequest))
const encodeBootstrapDocument = Schema.encodeEffect(Schema.fromJsonString(BoxBootstrapDocument))
const encodeBootstrapState = Schema.encodeEffect(Schema.fromJsonString(BoxBootstrapState))
const decodeBootstrapState = Schema.decodeUnknownEffect(Schema.fromJsonString(BoxBootstrapState))

export interface BoxBootstrapGrant {
  readonly url: string
  readonly ticket: Redacted.Redacted<string>
  readonly expiresAtMillis: number
}

export interface BoxBootstrapAuthority {
  readonly issue: (
    boxId: BoxIdValue,
    binding: WorkspaceBindingValue,
  ) => Effect.Effect<BoxBootstrapGrant, WorkspaceEnrollmentError>
  readonly ready: (
    boxId: BoxIdValue,
    binding: WorkspaceBindingValue,
  ) => Effect.Effect<HandshakeEvidence | undefined, WorkspaceEnrollmentError>
}

export interface BoxRunnerCommand {
  readonly buildId: string
  readonly command: readonly [string, ...Array<string>]
}

export interface BoxWorkspaceEnrollmentOptions {
  readonly baseUrl: string | URL
  readonly apiKey: Redacted.Redacted<string>
  readonly transport: BoxTransport
  readonly authority: BoxBootstrapAuthority
  readonly runner: BoxRunnerCommand
  readonly workspacePath: string
  readonly requestTimeoutMillis?: number
  readonly readinessAttempts?: number
  readonly readinessDelayMillis?: number
}

const enrollmentFailure = (phase: "enroll" | "handshake", message: string) =>
  WorkspaceEnrollmentError.make({ phase, message })

const boundedInteger = (
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const configured = value ?? fallback
  if (!Number.isSafeInteger(configured) || configured < minimum || configured > maximum)
    throw new RangeError(`Box ${name} must be an integer between ${minimum} and ${maximum}`)
  return configured
}

const validatedBaseUrl = (input: string | URL): URL => {
  const base = new URL(input)
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0
  )
    throw new RangeError("Box bootstrap base URL is invalid")
  return base
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const stateValue = (
  phase: BoxBootstrapState["phase"],
  binding: WorkspaceBindingValue,
  workspacePath: string,
): BoxBootstrapState => ({ version: 1, phase, binding, workspacePath })

const stateShell = (encoded: string, path: string): string =>
  `printf %s ${shellQuote(Buffer.from(encoded, "utf8").toString("base64"))} | base64 -d > ${shellQuote(`${path}.tmp`)}\nmv ${shellQuote(`${path}.tmp`)} ${shellQuote(path)}`

const validWorkspacePath = (path: string): boolean =>
  path.startsWith("/home/user/") && !path.includes("\u0000") && !path.split("/").includes("..") && path.length <= 4_096

const validCommand = (command: ReadonlyArray<string>): command is readonly [string, ...Array<string>] =>
  command.length > 0 &&
  command.length <= 64 &&
  command.every((part) => part.length > 0 && part.length <= 4_096 && !part.includes("\u0000")) &&
  command.reduce((total, part) => total + part.length, 0) <= 32_768

const grantUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (
        (url.protocol !== "ws:" && url.protocol !== "wss:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.hash.length > 0 ||
        value.length > 2_048
      )
        throw new Error("invalid URL")
      return url.toString()
    },
    catch: () => enrollmentFailure("enroll", "Box enrollment grant is invalid"),
  })

export const makeBoxWorkspaceEnrollment = (options: BoxWorkspaceEnrollmentOptions): WorkspaceEnrollmentService => {
  const baseUrl = validatedBaseUrl(options.baseUrl)
  const fleetCredential = Redacted.value(options.apiKey)
  if (fleetCredential.length === 0) throw new RangeError("Box bootstrap API credential is empty")
  if (!validWorkspacePath(options.workspacePath)) throw new RangeError("Box workspace path is invalid")
  const requestTimeoutMillis = boundedInteger(
    "bootstrap request timeout",
    options.requestTimeoutMillis,
    30_000,
    1,
    120_000,
  )
  const readinessAttempts = boundedInteger("bootstrap readiness attempts", options.readinessAttempts, 60, 1, 120)
  const readinessDelayMillis = boundedInteger("bootstrap readiness delay", options.readinessDelayMillis, 500, 0, 30_000)
  if (!validCommand(options.runner.command) || options.runner.command.some((part) => part.includes(fleetCredential)))
    throw new RangeError("Box Runner command is invalid")
  if (options.runner.buildId.length === 0 || options.runner.buildId.length > 4_096)
    throw new RangeError("Box Runner build identity is invalid")

  const send = <A, R>(
    phase: "enroll" | "handshake",
    method: "GET" | "PUT" | "POST",
    path: string,
    use: (response: Response) => Effect.Effect<A, WorkspaceEnrollmentError, R>,
    body?: string,
    query?: Readonly<Record<string, string>>,
  ): Effect.Effect<A, WorkspaceEnrollmentError, R> => {
    if (body?.includes(fleetCredential) === true)
      return Effect.fail(enrollmentFailure(phase, "Box provisioning credential reached a bootstrap payload"))
    const url = new URL(path.replace(/^\//, ""), `${baseUrl.toString().replace(/\/$/, "")}/`)
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
    const headers = new Headers({ authorization: `Bearer ${fleetCredential}` })
    if (body !== undefined) headers.set("content-type", "application/json")
    const request = new Request(url.toString(), body === undefined ? { method, headers } : { method, headers, body })
    return options.transport.request(request).pipe(
      Effect.mapError(() => bootstrapHttp.requestFailure(phase)),
      Effect.flatMap(use),
      Effect.timeout(`${requestTimeoutMillis} millis`),
      Effect.catchTag("TimeoutError", () => bootstrapHttp.requestFailure(phase)),
    )
  }

  const writeBoxFile = (boxId: BoxIdValue, path: string, content: string) =>
    encodeFileWriteRequest({ path, content, encoding: "utf8" }).pipe(
      Effect.mapError(() => enrollmentFailure("enroll", "Box bootstrap file request is invalid")),
      Effect.flatMap((body) =>
        send(
          "enroll",
          "PUT",
          `/boxes/${encodeURIComponent(boxId)}/files`,
          (response) =>
            response.ok
              ? bootstrapHttp
                  .decodeResponse(FileWriteResponse, response, "enroll", maxBootstrapResponseBytes)
                  .pipe(Effect.asVoid)
              : bootstrapHttp
                  .responseText(response, "enroll", maxBootstrapResponseBytes)
                  .pipe(Effect.andThen(Effect.fail(enrollmentFailure("enroll", "Box rejected a bootstrap file")))),
          body,
        ),
      ),
    )

  const readState = (phase: "enroll" | "handshake", boxId: BoxIdValue, binding: WorkspaceBindingValue) =>
    send(
      phase,
      "GET",
      `/boxes/${encodeURIComponent(boxId)}/files`,
      (response) => {
        if (response.status === 404)
          return bootstrapHttp.responseText(response, phase, maxBootstrapResponseBytes).pipe(Effect.as(undefined))
        if (response.status === 400)
          return bootstrapHttp
            .decodeResponse(FileMissingResponse, response, phase, maxBootstrapResponseBytes)
            .pipe(
              Effect.flatMap((error) =>
                error.message === `ENOENT: no such file or directory, stat '${boxBootstrapPaths(binding).statePath}'`
                  ? Effect.void.pipe(Effect.as(undefined))
                  : Effect.fail(enrollmentFailure(phase, "Box bootstrap state could not be read")),
              ),
            )
        if (!response.ok)
          return bootstrapHttp
            .responseText(response, phase, maxBootstrapResponseBytes)
            .pipe(Effect.andThen(Effect.fail(enrollmentFailure(phase, "Box bootstrap state could not be read"))))
        return bootstrapHttp.decodeResponse(FileReadResponse, response, phase, maxBootstrapResponseBytes).pipe(
          Effect.flatMap((read) => {
            const statePath = boxBootstrapPaths(binding).statePath
            if (read.path !== statePath && read.path !== `../..${statePath}`)
              return Effect.fail(enrollmentFailure(phase, "Box bootstrap state acknowledgement changed"))
            return decodeBootstrapState(read.content).pipe(
              Effect.mapError(() => enrollmentFailure(phase, "Box bootstrap state is invalid")),
              Effect.flatMap((state) =>
                sameBinding(state.binding, binding) && state.workspacePath === options.workspacePath
                  ? Effect.succeed(state)
                  : Effect.fail(enrollmentFailure(phase, "Box bootstrap state belongs to a changed workspace fence")),
              ),
            )
          }),
        )
      },
      undefined,
      { path: boxBootstrapPaths(binding).statePath, encoding: "utf8" },
    )

  const ready = (phase: "enroll" | "handshake", boxId: BoxIdValue, binding: WorkspaceBindingValue) =>
    options.authority.ready(boxId, binding).pipe(
      Effect.flatMap((candidate) => {
        if (candidate === undefined) return Effect.as(Effect.void, candidate)
        return Schema.decodeEffect(HandshakeEvidence)(candidate).pipe(
          Effect.mapError(() => enrollmentFailure(phase, "Box ready evidence is invalid")),
          Effect.flatMap((evidence) =>
            sameEvidence(binding, evidence)
              ? Effect.succeed(evidence)
              : Effect.fail(enrollmentFailure(phase, "Box ready evidence belongs to a changed workspace fence")),
          ),
        )
      }),
    )

  const validateInput = (phase: "enroll" | "handshake", boxId: BoxIdValue, binding: WorkspaceBindingValue) =>
    Schema.decodeEffect(BoxId)(boxId).pipe(
      Effect.mapError(() => enrollmentFailure(phase, "Box enrollment input is invalid")),
      Effect.zip(Schema.decodeEffect(WorkspaceBinding)(binding)),
      Effect.mapError(() => enrollmentFailure(phase, "Box enrollment input is invalid")),
      Effect.flatMap(([decodedBoxId, decodedBinding]) =>
        decodedBinding.placement._tag === "Orb" &&
        decodedBinding.workspaceId === decodedBinding.placement.workspaceId &&
        decodedBinding.buildId === options.runner.buildId
          ? Effect.succeed([decodedBoxId, decodedBinding] as const)
          : Effect.fail(enrollmentFailure(phase, "Box enrollment input does not match its Runner build or placement")),
      ),
    )

  const startCommand = (binding: WorkspaceBindingValue): Effect.Effect<string, WorkspaceEnrollmentError> =>
    Effect.gen(function* () {
      const paths = boxBootstrapPaths(binding)
      const starting = yield* encodeBootstrapState(stateValue("starting", binding, options.workspacePath))
      const failed = yield* encodeBootstrapState(stateValue("failed", binding, options.workspacePath))
      const command = options.runner.command.map(shellQuote).join(" ")
      const lines = [
        "set -eu",
        "umask 077",
        `mkdir -p ${shellQuote(paths.directory)}`,
        `command -v flock >/dev/null 2>&1 || { rm -f ${shellQuote(paths.documentPath)}; ${stateShell(failed, paths.statePath)}; exit 69; }`,
        `exec 9>${shellQuote(boxBootstrapLockPath)} || { rm -f ${shellQuote(paths.documentPath)}; ${stateShell(failed, paths.statePath)}; exit 70; }`,
        "flock -n 9 || exit 75",
        `exec 3<${shellQuote(paths.documentPath)} || { rm -f ${shellQuote(paths.documentPath)}; ${stateShell(failed, paths.statePath)}; exit 66; }`,
        `rm -f ${shellQuote(paths.documentPath)}`,
        stateShell(starting, paths.statePath),
      ]
      lines.push("status=0", `${command} <&3 || status=$?`, stateShell(failed, paths.statePath), 'exit "$status"')
      const value = lines.join("\n")
      return value
    }).pipe(Effect.mapError(() => enrollmentFailure("enroll", "Box bootstrap state could not be encoded")))

  const start = (boxId: BoxIdValue, binding: WorkspaceBindingValue) =>
    startCommand(binding).pipe(
      Effect.flatMap((command) =>
        encodeCommandRequest({ command, detached: true }).pipe(
          Effect.mapError(() => enrollmentFailure("enroll", "Box Runner start request is invalid")),
        ),
      ),
      Effect.flatMap((body) =>
        send(
          "enroll",
          "POST",
          `/boxes/${encodeURIComponent(boxId)}/commands`,
          (response) =>
            response.ok
              ? bootstrapHttp
                  .decodeResponse(CommandStartedResponse, response, "enroll", maxBootstrapResponseBytes)
                  .pipe(Effect.asVoid)
              : bootstrapHttp
                  .responseText(response, "enroll", maxBootstrapResponseBytes)
                  .pipe(Effect.andThen(Effect.fail(enrollmentFailure("enroll", "Box rejected the Runner start")))),
          body,
        ),
      ),
      Effect.catch((error) =>
        readState("enroll", boxId, binding).pipe(
          Effect.flatMap((state) => {
            if (state?.phase === "starting") return Effect.void
            return Effect.fail(error)
          }),
        ),
      ),
    )

  const prepare = (boxId: BoxIdValue, binding: WorkspaceBindingValue) =>
    Effect.gen(function* () {
      const grant = yield* options.authority.issue(boxId, binding)
      const now = yield* Clock.currentTimeMillis
      const ticket = Redacted.value(grant.ticket)
      if (
        ticket.length === 0 ||
        ticket.length > 4_096 ||
        ticket === fleetCredential ||
        grant.expiresAtMillis <= now ||
        grant.expiresAtMillis > now + 300_000
      )
        return yield* enrollmentFailure("enroll", "Box enrollment grant is invalid")
      const url = yield* grantUrl(grant.url)
      if (url.includes(fleetCredential))
        return yield* enrollmentFailure("enroll", "Box enrollment grant contains a provisioning credential")
      const document = yield* encodeBootstrapDocument({
        version: 1,
        boxId,
        binding,
        workspacePath: options.workspacePath,
        enrollment: { url, ticket, expiresAtMillis: grant.expiresAtMillis },
      }).pipe(Effect.mapError(() => enrollmentFailure("enroll", "Box enrollment grant could not be encoded")))
      if (new TextEncoder().encode(document).byteLength > maxBootstrapDocumentBytes)
        return yield* enrollmentFailure("enroll", "Box enrollment grant exceeds its byte bound")
      const paths = boxBootstrapPaths(binding)
      yield* writeBoxFile(boxId, paths.documentPath, document)
      const prepared = yield* encodeBootstrapState(stateValue("prepared", binding, options.workspacePath)).pipe(
        Effect.mapError(() => enrollmentFailure("enroll", "Box bootstrap state could not be encoded")),
      )
      yield* writeBoxFile(boxId, paths.statePath, prepared)
    })

  return {
    enroll: (unvalidatedBoxId, unvalidatedBinding) =>
      validateInput("enroll", unvalidatedBoxId, unvalidatedBinding).pipe(
        Effect.flatMap(([boxId, binding]) =>
          ready("enroll", boxId, binding).pipe(
            Effect.flatMap((evidence) => {
              if (evidence !== undefined) return Effect.void
              return readState("enroll", boxId, binding).pipe(
                Effect.flatMap((observed) => {
                  if (observed === undefined) return prepare(boxId, binding).pipe(Effect.andThen(start(boxId, binding)))
                  if (observed.phase === "starting") return Effect.void
                  if (observed.phase === "failed")
                    return Effect.fail(enrollmentFailure("enroll", "Box Runner startup failed"))
                  return start(boxId, binding)
                }),
              )
            }),
          ),
        ),
      ),
    handshake: (unvalidatedBoxId, unvalidatedBinding) =>
      validateInput("handshake", unvalidatedBoxId, unvalidatedBinding).pipe(
        Effect.flatMap(([boxId, binding]) => {
          const poll = (attempt: number): Effect.Effect<HandshakeEvidence, WorkspaceEnrollmentError> =>
            ready("handshake", boxId, binding).pipe(
              Effect.flatMap((evidence) => {
                if (evidence !== undefined) return Effect.succeed(evidence)
                return readState("handshake", boxId, binding).pipe(
                  Effect.flatMap((observed) => {
                    if (observed === undefined)
                      return Effect.fail(enrollmentFailure("handshake", "Box bootstrap state disappeared"))
                    if (observed.phase === "failed")
                      return Effect.fail(enrollmentFailure("handshake", "Box Runner startup failed"))
                    if (attempt >= readinessAttempts)
                      return Effect.fail(
                        enrollmentFailure("handshake", "Box Runner did not complete its ready handshake"),
                      )
                    return Effect.sleep(readinessDelayMillis).pipe(Effect.andThen(poll(attempt + 1)))
                  }),
                )
              }),
            )
          return poll(1)
        }),
      ),
  }
}
