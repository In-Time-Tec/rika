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
]
