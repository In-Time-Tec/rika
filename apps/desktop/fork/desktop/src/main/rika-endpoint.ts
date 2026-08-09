import * as ServerEndpoint from "@rika/server/server-endpoint"
import { Effect } from "effect"
import type { RikaReadyData } from "../preload/types"

export const makeDiscoverRikaReadyData = (readPublished: typeof ServerEndpoint.readPublished) =>
  Effect.fn("DesktopRikaEndpoint.discover")(function* (input: { readonly profile: string; readonly dataRoot: string }) {
    const published = yield* readPublished(input)
    return {
      url: published.endpoint.url,
      token: published.token,
      identity: published.endpoint.identity,
    } satisfies RikaReadyData
  })

export const discoverRikaReadyData = makeDiscoverRikaReadyData(ServerEndpoint.readPublished)
