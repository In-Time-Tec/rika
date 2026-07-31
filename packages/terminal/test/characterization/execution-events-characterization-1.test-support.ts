import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import { expect, it } from "vitest"
import { ExecutionEvents, ViewState } from "../../src/state/model/terminal-state"
import { renderTranscriptStyled } from "../../src/opentui/surface/opentui-surface"
import {
  unitId as transcriptUnitId,
  rows as transcriptUnits,
} from "../../src/presentation/transcript/terminal-transcript-presentation"









export const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<TranscriptSourceEvent.SourceEvent> = {},
): TranscriptSourceEvent.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })





















