import { Schema } from "effect"

export class OpenRouterAuthError extends Schema.TaggedError<OpenRouterAuthError>()(
  "@rika/product/authentication/openrouter-auth-service/OpenRouterAuthError",
  {
    kind: Schema.Literals(["invalid-key", "network", "store"]),
    message: Schema.String,
  },
) {}
