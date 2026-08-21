export interface Migration {
  readonly id: string
  readonly url: URL
  readonly checksum: string
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: "product/0001_hosted_authority",
    checksum: "9e9385f2865144ed34684ba13fa3f5100772635af24d50293a2936dfe86b0dcd",
    url: new URL("../../migrations/postgres/0001-hosted-authority.sql", import.meta.url),
  },
  {
    id: "product/0002_hosted_identity_ancestry",
    checksum: "9115ef8107f3ffcae24c3c81ff066161336846a1314c380136a958fc751debf2",
    url: new URL("../../migrations/postgres/0002-hosted-identity-ancestry.sql", import.meta.url),
  },
  {
    id: "product/0003_hosted_authority_fences",
    checksum: "bc902e5c1c1ebef9eb2da1d00fcf3f8b4f7e8e1391324f5f65eca1eedd7c171a",
    url: new URL("../../migrations/postgres/0003-hosted-authority-fences.sql", import.meta.url),
  },
  {
    id: "product/0004_local_executor",
    checksum: "3a96fa290c683d877cbf6608d2275a84a5cdf47ee746ae29e73f768f9bffaa91",
    url: new URL("../../migrations/postgres/0004-local-executor.sql", import.meta.url),
  },
  {
    id: "product/0005_local_executor_recovery",
    checksum: "5f8c77195f9479471379539a6f75e902aec4de05bf89c53f7ad1ec72958f49f4",
    url: new URL("../../migrations/postgres/0005-local-executor-recovery.sql", import.meta.url),
  },
  {
    id: "product/0006_product_state",
    checksum: "c8414d553f8eb3775b6930944f07cdf76a9ac857c324d24d71e0e66816741f29",
    url: new URL("../../migrations/postgres/0006-product-state.sql", import.meta.url),
  },
  {
    id: "product/0007_hosted_prompt_admission",
    checksum: "7acbef20b49d79185a1da7bcb00138c509966f2a0fe0dff5e8f614932f490442",
    url: new URL("../../migrations/postgres/0007-hosted-prompt-admission.sql", import.meta.url),
  },
  {
    id: "product/0008_hosted_turn_worker",
    checksum: "c9616cd9fecf1cb3b8115acdc3d0b03ada1cd0cbe189111aac2c0ad84ce79dd3",
    url: new URL("../../migrations/postgres/0008-hosted-turn-worker.sql", import.meta.url),
  },
  {
    id: "product/0009_provider_credentials",
    checksum: "5511abe15bfa0da11a07637c9f84f802b0f0a2417cd98fe9cd0f55de33547fc1",
    url: new URL("../../migrations/postgres/0009-provider-credentials.sql", import.meta.url),
  },
  {
    id: "product/0010_logical_workspace_identity",
    checksum: "f278641b3e6d72ec086518569ad7373f9b197d8a9ade4073ecc4a14e8a3f771f",
    url: new URL("../../migrations/postgres/0010-logical-workspace-identity.sql", import.meta.url),
  },
  {
    id: "product/0011_executor_operation_identity",
    checksum: "513d0d28cac6b127c22490bb0e04f6d49f926a569c9c3e0b94b3f150429edd4b",
    url: new URL("../../migrations/postgres/0011-executor-operation-identity.sql", import.meta.url),
  },
  {
    id: "product/0012_executor_operation_lifecycle",
    checksum: "ce55d4ca510832e84ac77f80a245fdcd8b9818c932b7cd283d8c8eb442bdbc47",
    url: new URL("../../migrations/postgres/0012-executor-operation-lifecycle.sql", import.meta.url),
  },
  {
    id: "product/0013_thread_protocol",
    checksum: "8030a7e690ce8ff46aba12667c820fa083482922f8785e09c86da86fb03ee948",
    url: new URL("../../migrations/postgres/0013-thread-protocol.sql", import.meta.url),
  },
  {
    id: "product/0014_local_runner_registration",
    checksum: "c3b4774eafa26939c91cd00822e82373964e9d373309ae63c7df4ee5dd95f175",
    url: new URL("../../migrations/postgres/0014-local-runner-registration.sql", import.meta.url),
  },
  {
    id: "product/0015_environment_and_egress",
    checksum: "1d4c818cce92dcd01b5b020cb05bb4cad95a95eb624e0bca1563577bb655d0a2",
    url: new URL("../../migrations/postgres/0015-environment-and-egress.sql", import.meta.url),
  },
  {
    id: "product/0016_authority_revocation",
    checksum: "057e350b553c3deaab26ae860cff5841de39544a698fbcc426b6a8e1328dc085",
    url: new URL("../../migrations/postgres/0016-authority-revocation.sql", import.meta.url),
  },
  {
    id: "product/0017_executor_recovery_capabilities",
    checksum: "7dda258e69b81e87662ebe8aeed01769bf456c829f50589e5b77d953e0d3b549",
    url: new URL("../../migrations/postgres/0017-executor-recovery-capabilities.sql", import.meta.url),
  },
  {
    id: "product/0018_workspace_preparation",
    checksum: "fd7d1d0c8353e78599de0745f450dc19a55df575ecfb70083acd909571a006bf",
    url: new URL("../../migrations/postgres/0018-workspace-preparation.sql", import.meta.url),
  },
  {
    id: "product/0019_approved_repository_publication",
    checksum: "208b2958e8c09ac1e449735c31c22f19face3761c875c004d0d60968acb8ce0a",
    url: new URL("../../migrations/postgres/0019-approved-repository-publication.sql", import.meta.url),
  },
  {
    id: "product/0020_tool_policy_audit",
    checksum: "bc29391d7b468ab7500ebea279ef917da2e42259879041231aba3aea0a86d3f1",
    url: new URL("../../migrations/postgres/0020-tool-policy-audit.sql", import.meta.url),
  },
  {
    id: "product/0021_independent_assignment_identity",
    checksum: "e41396ab9b388fe0120f76c798cc59313684c7b7481b6fe7269802438bf3dc98",
    url: new URL("../../migrations/postgres/0021-independent-assignment-identity.sql", import.meta.url),
  },
]
