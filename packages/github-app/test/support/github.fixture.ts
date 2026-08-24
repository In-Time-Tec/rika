import type * as GitHub from "../../src/model"

export const organization = {
  id: 7,
  login: "octo-org",
  type: "Organization",
} as const satisfies GitHub.GitHubAccount

export const otherOrganization = {
  id: 8,
  login: "spoofed-org",
  type: "Organization",
} as const satisfies GitHub.GitHubAccount

export const repository = (id: number): GitHub.Repository => ({
  id,
  name: `repository-${id}`,
  full_name: `octo-org/repository-${id}`,
  private: true,
  archived: false,
  html_url: `https://github.test/octo-org/repository-${id}`,
  owner: organization,
})

export const installation = {
  id: 42,
  app_id: 123,
  account: organization,
  repository_selection: "selected",
  permissions: { metadata: "read", contents: "read" },
  suspended_at: null,
} as const satisfies GitHub.Installation
