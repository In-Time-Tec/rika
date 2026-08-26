import { Context, Effect, Schema } from "effect"

export const AccountSchema = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    emailVerified: Schema.Boolean,
    image: Schema.NullOr(Schema.String),
  }),
  memberships: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      createdAt: Schema.String,
      organization: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        slug: Schema.String,
        logo: Schema.NullOr(Schema.String),
      }),
    }),
  ),
})

export type Account = typeof AccountSchema.Type

export type AccountAccess =
  | { readonly _tag: "account"; readonly account: Account }
  | { readonly _tag: "anonymous" }
  | { readonly _tag: "unavailable" }

export interface AccountGatewayRequest {
  readonly cookie: string | undefined
  readonly signal: AbortSignal
}

export class AccountGateway extends Context.Service<
  AccountGateway,
  { readonly account: (input: AccountGatewayRequest) => Effect.Effect<AccountAccess> }
>()("@rika/web/account/gateway/AccountGateway") {}
