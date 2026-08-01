import { migration004 } from "./product-migration-004-execution-extension-pins"
import { migration007 } from "./product-migration-007-execution-route-pins"
import { migration008 } from "./product-migration-008-review-fan-out-owners"
import { migration013 } from "./product-migration-013-provider-execution-routes"
import { productRouteSnapshot } from "./product-migration-028-product-route-snapshot"

export const executionMigrations: Record<number, any> = {
  4: migration004,
  7: migration007,
  8: migration008,
  13: migration013,
  28: productRouteSnapshot,
} as const
