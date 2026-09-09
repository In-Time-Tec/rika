/** Header emitted by Rivet when forwarding the caller's URL into an actor request. */
export const RIVET_ORIGINAL_REQUEST_URL = "x-rivet-internal-original-request-url"

/** Application-owned request context overwritten by the Rika gateway before actor forwarding. */
export const RIKA_ORIGINAL_REQUEST_URL = "x-rika-original-request-url"

/** Original caller method carried across Rivet's internal GET/session probe normalization. */
export const RIKA_ORIGINAL_REQUEST_METHOD = "x-rika-original-request-method"

/** The caller's DPoP authorization before the Rivet bearer transport adapter normalizes its scheme. */
export const RIKA_ORIGINAL_AUTHORIZATION = "x-rika-original-authorization"

/** Opaque process-local credential for an already authenticated actor crossing the Rivet boundary. */
export const RIKA_DOWNSTREAM_CREDENTIAL = "x-rika-downstream-credential"
