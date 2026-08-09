import { Schema } from "effect"

export const RikaCatalog = Schema.Struct({
  settings: Schema.Struct({ providers: Schema.Record(Schema.String, Schema.Unknown) }),
  environment: Schema.Struct({ providerApiKeys: Schema.Record(Schema.String, Schema.String) }),
  model: Schema.Struct({
    route: Schema.Struct({ alias: Schema.String, providerId: Schema.String, model: Schema.String }),
    apiKey: Schema.String,
  }),
})
export type RikaCatalog = typeof RikaCatalog.Type
