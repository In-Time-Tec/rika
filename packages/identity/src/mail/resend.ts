import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { IdentityConfig } from "../config"
import { MailDeliveryError, type MailMessage, type MailSender } from "./service"

const sendMail = Effect.fn("ResendMail.send")(function* (
  config: IdentityConfig,
  client: HttpClient.HttpClient,
  message: MailMessage,
) {
  const response = yield* client.execute(
    HttpClientRequest.post("https://api.resend.com/emails", {
      headers: {
        authorization: `Bearer ${Redacted.value(config.resendApiKey)}`,
      },
    }).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        from: config.emailFrom,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    ),
  )
  if (response.status < 200 || response.status >= 300) return yield* MailDeliveryError.make({ status: response.status })
})

export const makeResendMailSender = (input: {
  readonly config: IdentityConfig
  readonly client: HttpClient.HttpClient
}): MailSender => ({
  send: (message) =>
    sendMail(input.config, input.client, message).pipe(
      Effect.mapError((error) => (Schema.is(MailDeliveryError)(error) ? error : MailDeliveryError.make({}))),
    ),
})
