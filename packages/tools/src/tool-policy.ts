import { Function, Schema } from "effect"

export const Permission = Schema.Literals(["allow", "ask"])
export type Permission = typeof Permission.Type

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type

export const ProductPermission = Schema.Literals(["thread.read", "thread.coordinate", "thread.control"])
export type ProductPermission = typeof ProductPermission.Type

export const PermissionRule = Schema.Struct({
  actions: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  productPermission: ProductPermission,
  idempotency: Idempotency,
})
export type PermissionRule = typeof PermissionRule.Type

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  failedLabel: Schema.optionalKey(Schema.String),
  rowDisplay: Schema.optionalKey(Schema.Literal("continuation")),
  outputDisplay: Schema.optionalKey(Schema.Literals(["hidden", "expandable"])),
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "review",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const Policy = Schema.Struct({
  permission: Permission,
  productPermission: Schema.optionalKey(ProductPermission),
  permissionRules: Schema.optionalKey(Schema.Array(PermissionRule).check(Schema.isMinLength(1))),
  idempotency: Idempotency,
  timeoutMillis: PositiveInt,
  outputLimit: PositiveInt,
  presentation: Presentation,
})
export type Policy = typeof Policy.Type

export interface RegisteredTool {
  readonly name: string
  readonly description?: string | undefined
}

export interface Registration {
  readonly tool: RegisteredTool
  readonly policy: Policy
}

export const allow: {
  (
    idempotency: Idempotency,
    timeoutMillis: number,
    outputLimit: number,
    presentation: Presentation,
    productPermission?: ProductPermission,
    permissionRules?: ReadonlyArray<PermissionRule>,
  ): Policy
  (timeoutMillis: number, outputLimit: number, presentation: Presentation): (idempotency: Idempotency) => Policy
} = Function.dual(
  (args) => args.length >= 4,
  (
    idempotency: Idempotency,
    timeoutMillis: number,
    outputLimit: number,
    presentation: Presentation,
    productPermission?: ProductPermission,
    permissionRules?: ReadonlyArray<PermissionRule>,
  ): Policy => ({
    permission: "allow",
    ...(productPermission === undefined ? {} : { productPermission }),
    ...(permissionRules === undefined ? {} : { permissionRules }),
    idempotency,
    timeoutMillis,
    outputLimit,
    presentation,
  }),
)

export const register: {
  (tool: RegisteredTool, policy: Policy): Registration
  (policy: Policy): (tool: RegisteredTool) => Registration
} = Function.dual(2, (tool: RegisteredTool, policy: Policy): Registration => ({ tool, policy }))
