import { Effect, Schema } from "effect"

export interface MailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html: string
}

export class MailDeliveryError extends Schema.TaggedError<MailDeliveryError>()("MailDeliveryError", {
  status: Schema.optionalKey(Schema.Finite),
}) {}

export interface MailSender {
  readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryError>
}

export const noOpMailSender: MailSender = { send: () => Effect.void }

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const linkMessage = (to: string, subject: string, introduction: string, action: string, url: string): MailMessage => ({
  to,
  subject,
  text: `${introduction}\n\n${action}: ${url}\n`,
  html: `<p>${escapeHtml(introduction)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p>`,
})

export const verificationEmail = (input: { readonly to: string; readonly url: string }) =>
  linkMessage(
    input.to,
    "Verify your Rika email",
    "Verify this email address to finish creating your Rika account.",
    "Verify email",
    input.url,
  )

export const passwordResetEmail = (input: { readonly to: string; readonly url: string }) =>
  linkMessage(
    input.to,
    "Reset your Rika password",
    "A password reset was requested for your Rika account.",
    "Reset password",
    input.url,
  )

export const invitationEmail = (input: {
  readonly to: string
  readonly inviter: string
  readonly organization: string
  readonly url: string
}) =>
  linkMessage(
    input.to,
    `Join ${input.organization} on Rika`,
    `${input.inviter} invited you to join ${input.organization} on Rika.`,
    "Review invitation",
    input.url,
  )
