import type { HostedOwner } from "./model"

export type ProductRole = "viewer" | "controller" | "operator" | "owner"

export interface ProductProject {
  readonly id: string
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly name: string
  readonly role: ProductRole
}
