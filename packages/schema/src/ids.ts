import { Schema } from "effect"

const id = <const Name extends string>(name: Name) => {
  const schema = Schema.String.pipe(Schema.brand(name)).annotate({ identifier: name })
  return Object.assign(schema, {
    make: Schema.decodeUnknownSync(schema),
  })
}

export const ActorId = id("Rika.ActorId")
export type ActorId = typeof ActorId.Type

export const ArtifactId = id("Rika.ArtifactId")
export type ArtifactId = typeof ArtifactId.Type

export const EventId = id("Rika.EventId")
export type EventId = typeof EventId.Type

export const IdeClientId = id("Rika.IdeClientId")
export type IdeClientId = typeof IdeClientId.Type

export const MessageId = id("Rika.MessageId")
export type MessageId = typeof MessageId.Type

export const OrbId = id("Rika.OrbId")
export type OrbId = typeof OrbId.Type

export const ProjectId = id("Rika.ProjectId")
export type ProjectId = typeof ProjectId.Type

export const ThreadId = id("Rika.ThreadId")
export type ThreadId = typeof ThreadId.Type

export const ToolCallId = id("Rika.ToolCallId")
export type ToolCallId = typeof ToolCallId.Type

export const TurnId = id("Rika.TurnId")
export type TurnId = typeof TurnId.Type

export const UserId = id("Rika.UserId")
export type UserId = typeof UserId.Type

export const WorkspaceId = id("Rika.WorkspaceId")
export type WorkspaceId = typeof WorkspaceId.Type
