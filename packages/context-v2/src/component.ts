import { Pins } from "generalist"
import * as Components from "generalist/components"
import { Schema } from "effect"
import { SessionMaterialization, SessionMaterializationCommand } from "./contract"
import { transition } from "./materializer"

export const sessionMaterializationDescriptor = Schema.decodeSync(Components.Descriptor)({
  version: "1",
  key: "rika.context-v2.session-materialization",
  instance: "session",
  schemaVersion: "1",
  handler: "rika.context-v2.session-materialization",
  handlerVersion: "1",
  scope: "session",
  access: "session-owner",
  inheritance: "none",
  branch: "restore",
  redaction: "visible",
  maxStateBytes: 1_048_576,
  maxCommandBytes: 262_144,
  maxReceiptBytes: 262_144,
})

export const makeSessionMaterializationComponent = (
  initial: SessionMaterialization,
): Components.Declaration<SessionMaterialization, SessionMaterializationCommand> =>
  Components.make({
    descriptor: sessionMaterializationDescriptor,
    state: SessionMaterialization,
    command: SessionMaterializationCommand,
    initial,
    transition,
  })

export const sessionMaterializationCapability = Pins.makeCapability(sessionMaterializationDescriptor)
