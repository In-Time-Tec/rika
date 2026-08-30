import type { RepositoryCheckout } from "@rika/product/executor-assignment"
import type { Access } from "@rika/product/executor-assignments"
import type { RepositoryBinding } from "@rika/product-store/repositories"
import type { CredentialPurpose, CredentialRequest, InstallationPermissions } from "./repository-contract"

interface AssignmentIdentity {
  readonly ownerId: string
  readonly workspaceId: string
  readonly checkout: RepositoryCheckout | null
}

export const assignedCheckout = ({
  assignment,
  input,
}: {
  assignment: AssignmentIdentity
  input: CredentialRequest
}) => {
  const checkout = assignment.checkout
  if (
    assignment.ownerId !== input.ownerId ||
    assignment.workspaceId !== input.workspaceId ||
    checkout === null ||
    checkout.ownerId !== input.ownerId ||
    checkout.repositoryId !== input.repositoryId
  )
    return undefined
  return checkout
}

export const bindingMatchesCheckout = ({
  binding,
  checkout,
}: {
  binding: RepositoryBinding
  checkout: RepositoryCheckout
}) =>
  binding.repositoryId === checkout.repositoryId &&
  binding.installationId === checkout.installationId &&
  binding.repositoryOwner === checkout.owner &&
  binding.repositoryName === checkout.name &&
  binding.private === checkout.private

export const permissionsFor = (purpose: CredentialPurpose): InstallationPermissions => {
  if (purpose === "github-read") return { contents: "read", issues: "read", pull_requests: "read" }
  if (purpose === "branch-push") return { contents: "write" }
  return { contents: "read" }
}

export const tokenKey = ({
  access,
  purpose,
  publicationId,
}: {
  access: Access
  purpose: CredentialPurpose
  publicationId: string | undefined
}) => `${access.assignmentId}:${access.assignmentGeneration}:${access.leaseEpoch}:${purpose}:${publicationId ?? ""}`
