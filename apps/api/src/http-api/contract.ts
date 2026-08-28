import { HttpApi } from "effect/unstable/httpapi"
import { AuditGroup } from "./audit/routes"
import { EnvironmentGroup } from "./environment/routes"
import { IdentityGroup, PublicIdentityGroup } from "./identity/routes"
import { ModelsGroup } from "./models/routes"
import { PublicGroup } from "./public/routes"
import { PublicationGroup } from "./publication/routes"
import { RecoveryGroup } from "./recovery/routes"
import { RunnersGroup } from "./runners/routes"
import { WorkspaceSeedsGroup } from "./workspace-seeds/routes"

export class RikaApi extends HttpApi.make("rika-api")
  .add(PublicGroup)
  .add(PublicIdentityGroup)
  .add(IdentityGroup)
  .add(RunnersGroup)
  .add(WorkspaceSeedsGroup)
  .add(RecoveryGroup)
  .add(PublicationGroup)
  .add(ModelsGroup)
  .add(EnvironmentGroup)
  .add(AuditGroup) {}
