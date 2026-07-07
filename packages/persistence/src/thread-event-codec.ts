import { Codec, Event } from "@rika/schema"
import { Schema } from "effect"

const EventPayload = Schema.fromJsonString(Event.Event)

export const encodePayload = (event: Event.Event) => Schema.encodeSync(EventPayload)(Codec.decode(Event.Event)(event))
export const decodePayload = (payload: string) => Schema.decodeUnknownSync(EventPayload)(payload)
