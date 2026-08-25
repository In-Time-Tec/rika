import { Template, type TemplateBuildStatusResponse, type TemplateClass } from "e2b"
import { Function, Schema } from "effect"
import { createHash } from "node:crypto"

export const DevelopmentTemplateIdentity = Schema.Struct({
  sourceDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  templateId: Schema.NonEmptyString,
  buildId: Schema.NonEmptyString,
})

export type DevelopmentTemplateIdentity = typeof DevelopmentTemplateIdentity.Type

export const developmentTemplate = (repositoryRoot: string): TemplateClass =>
  Template({ fileContextPath: repositoryRoot })
    .fromDockerfile(`${repositoryRoot}/infra/e2b/executor-v1/e2b.Dockerfile`)
    .setStartCmd("/opt/rika/start.sh", "curl --fail --silent http://127.0.0.1:7070/health")

const digestTemplateSourcePromise = (source: ReturnType<typeof Template.toJSON>) =>
  source["then"]((value) => `sha256:${createHash("sha256").update(value).digest("hex")}`)

export const developmentTemplateSourceDigest = (repositoryRoot: string) =>
  digestTemplateSourcePromise(Template.toJSON(developmentTemplate(repositoryRoot), true))

const isReadyDevelopmentTemplateImpl = (
  identity: DevelopmentTemplateIdentity,
  sourceDigest: string,
  status: TemplateBuildStatusResponse,
) =>
  identity.sourceDigest === sourceDigest &&
  identity.templateId === status.templateID &&
  identity.buildId === status.buildID &&
  status.status === "ready"

export const isReadyDevelopmentTemplate: {
  (sourceDigest: string, status: TemplateBuildStatusResponse): (identity: DevelopmentTemplateIdentity) => boolean
  (identity: DevelopmentTemplateIdentity, sourceDigest: string, status: TemplateBuildStatusResponse): boolean
} = Function.dual(3, isReadyDevelopmentTemplateImpl)
