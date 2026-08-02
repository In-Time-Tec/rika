import { Function } from "effect"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"

const eventImpl = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<TranscriptSourceEvent.SourceEvent> = {},
): TranscriptSourceEvent.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

export const event: {
  (
    arg0: Parameters<typeof eventImpl>[0],
    arg1: Parameters<typeof eventImpl>[1],
    arg2: Parameters<typeof eventImpl>[2],
    arg3?: Parameters<typeof eventImpl>[3],
  ): ReturnType<typeof eventImpl>
  (
    arg1: Parameters<typeof eventImpl>[1],
    arg2: Parameters<typeof eventImpl>[2],
  ): (arg0: Parameters<typeof eventImpl>[0]) => ReturnType<typeof eventImpl>
} = Function.dual((args) => args.length > 0, eventImpl)
