import { protocolVersion, ServerFrame } from "@rika/product/client-protocol"
import { Effect, Option, Schema, type SchemaIssue } from "effect"
import { HostedError } from "../contract"

const metadata = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.Finite),
  payload: Schema.optionalKey(
    Schema.Struct({
      _tag: Schema.optionalKey(
        Schema.Literals([
          "ThreadAttached",
          "ThreadSnapshot",
          "ThreadEvent",
          "ThreadHistory",
          "ThreadPreview",
          "ThreadPreviewReset",
          "CommandAccepted",
          "CommandAdmitted",
          "CommandRejected",
          "Heartbeat",
          "PresenceSnapshot",
          "WorkspaceFileInspected",
          "PortalOpened",
        ]),
      ),
    }),
  ),
})
const inspect = Schema.decodeOption(Schema.fromJsonString(metadata))
const inspectVersion = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ protocolVersion: Schema.Finite })))
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))
// Unknown/dynamic keys and refinement messages can contain user data. Never log them.
const safeKeys = new Set([
  "protocolVersion",
  "payload",
  "_tag",
  "event",
  "events",
  "snapshot",
  "checkpoint",
  "view",
  "thread",
  "turns",
  "turn",
  "units",
  "content",
  "block",
  "status",
  "revision",
  "source",
  "order",
  "text",
  "patch",
  "upsert",
  "remove",
  "turnChanges",
  "header",
  "usage",
  "preview",
  "requestId",
  "threadId",
  "turnId",
  "cursor",
  "threadVersion",
  "pending",
  "hasOlder",
  "hasNewer",
  "result",
  "input",
  "output",
  "reason",
  "details",
])
const safeKey = (key: PropertyKey): string => {
  if (Schema.is(Schema.Finite)(key)) return "[]"
  return Schema.is(Schema.String)(key) && safeKeys.has(key) ? key : "<key>"
}
export const safeFrameIssues = (issue: SchemaIssue.Issue): ReadonlyArray<string> => {
  const issues: Array<string> = []
  const visit = (current: SchemaIssue.Issue, path: ReadonlyArray<string>, depth: number) => {
    if (issues.length >= 12 || depth > 32) return
    if (current._tag === "Pointer") return visit(current.issue, [...path, ...current.path.map(safeKey)], depth + 1)
    if (current._tag === "Encoding" || current._tag === "Filter") return visit(current.issue, path, depth + 1)
    if (current._tag === "Composite" || current._tag === "AnyOf") {
      for (const child of current.issues) visit(child, path, depth + 1)
      return
    }
    issues.push(`${path.join(".") || "frame"}: ${current._tag}${"ast" in current ? ` (${current.ast._tag})` : ""}`)
  }
  visit(issue, [], 0)
  return issues
}

export const decodeThreadFrame = (value: string) =>
  decode(value).pipe(
    Effect.catch((error) => {
      const inspected = Option.getOrUndefined(inspect(value))
      const received = inspected?.protocolVersion ?? Option.getOrUndefined(inspectVersion(value))?.protocolVersion
      const mismatch = received !== undefined && received !== protocolVersion
      return Effect.logWarning("hosted.frame.decode_failed").pipe(
        Effect.annotateLogs({
          "rika.protocol.expected": protocolVersion,
          "rika.protocol.received": received ?? "unknown",
          "rika.frame.tag": inspected?.payload?._tag ?? "unknown",
          "rika.frame.bytes": new TextEncoder().encode(value).byteLength,
          "rika.frame.issues": safeFrameIssues(error.issue).join("; "),
        }),
        Effect.andThen(
          Effect.fail(
            HostedError.make({
              kind: "protocol",
              message: mismatch
                ? "Thread protocol version mismatch; update rika and reconnect"
                : "Thread server sent an invalid frame; diagnostic details recorded",
            }),
          ),
        ),
      )
    }),
  )
