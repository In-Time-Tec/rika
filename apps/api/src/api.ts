import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { HttpDependencies } from "./server/http"
import { authorizationLayer } from "./http-api/access"
import { RikaApi } from "./http-api/contract"
import { publicHandlers } from "./http-api/public/controller"
import { identityHandlers, publicIdentityHandlers } from "./http-api/identity/controller"
import { runnersHandlers } from "./http-api/runners/controller"
import { recoveryHandlers } from "./http-api/recovery/controller"
import { publicationHandlers } from "./http-api/publication/controller"
import { modelsHandlers } from "./http-api/models/controller"
import { environmentHandlers } from "./http-api/environment/controller"
import { auditHandlers } from "./http-api/audit/controller"

export { RikaApi } from "./http-api/contract"

export const isRikaApiPath = (pathname: string) =>
  pathname === "/healthz" || pathname === "/readyz" || pathname === "/api/account" || pathname.startsWith("/api/v1/")

export const makeRikaApiHandler = (dependencies: HttpDependencies) => {
  const authenticated = Layer.mergeAll(
    identityHandlers(dependencies),
    runnersHandlers(dependencies),
    recoveryHandlers(dependencies),
    publicationHandlers(dependencies),
    modelsHandlers(dependencies),
    environmentHandlers(dependencies),
    auditHandlers(dependencies),
  ).pipe(Layer.provide(authorizationLayer(dependencies)))
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(RikaApi).pipe(
      Layer.provide(Layer.mergeAll(publicHandlers(dependencies), publicIdentityHandlers(dependencies), authenticated)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
}
