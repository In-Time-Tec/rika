import { SkillSource } from "@batonfx/core"
import { Effect, Schema } from "effect"

export interface Options {
  readonly globalRoot: string
  readonly workspaceRoot: string
  readonly descriptionCap?: number
  readonly workspaceTrusted?: boolean
}

export type Origin = "global" | "workspace"

export interface Executable {
  readonly name: string
  readonly importName: string
  readonly digest: string
  readonly origin: Origin
  readonly importable: boolean
}

export interface Resource {
  readonly path: string
  readonly content: string
}

export interface Activation {
  readonly body: string
  readonly resources: ReadonlyArray<Resource>
}

export interface Discovered {
  readonly source: SkillSource.Interface
  readonly listings: ReadonlyArray<string>
  readonly executable: ReadonlyArray<Executable>
  readonly digest: string
  readonly executableDigest: string
  readonly activate: (name: string) => Effect.Effect<Activation, SkillRegistryError>
}

export class SkillRegistryError extends Schema.TaggedErrorClass<SkillRegistryError>()(
  "@rika/extensions/SkillRegistryError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
