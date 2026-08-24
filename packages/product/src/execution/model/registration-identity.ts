import { Schema } from "effect"

export const ModelRegistrationIdentity = Schema.String.pipe(Schema.brand("ModelRegistrationIdentity"))
export type ModelRegistrationIdentity = typeof ModelRegistrationIdentity.Type
export const modelRegistrationIdentity = (value: string): ModelRegistrationIdentity =>
  value as ModelRegistrationIdentity
