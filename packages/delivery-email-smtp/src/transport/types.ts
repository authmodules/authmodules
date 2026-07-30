import type { DeliveryAddress, DeliveryMessage } from '@authmodules/contracts/delivery'
import type { DispatchContext, PublicData } from '@authmodules/contracts/primitives'

export type SmtpRenderInput = {
  readonly context: DispatchContext
  readonly message: DeliveryMessage
  readonly idempotencyKey?: string
  readonly effectiveLocale?: string
  readonly now: Date
}

export type SmtpRenderedMessage = {
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly replyTo?: string
  readonly headers?: Readonly<Record<string, string>>
}

export type SmtpSenderInput = {
  readonly context: DispatchContext
  readonly to: DeliveryAddress
  readonly templateId: string
  readonly metadata?: PublicData
  readonly idempotencyKey?: string
  readonly effectiveLocale?: string
  readonly now: Date
}

export type SmtpClientSendInput = SmtpRenderedMessage & {
  readonly from: string
  readonly to: string
  readonly idempotencyKey?: string
}

export type SmtpClientSendResult = {
  readonly providerMessageId?: string
  readonly acceptedAt?: Date
}

export type SmtpDeliveryTransportOptions = {
  readonly client: {
    sendMail(input: SmtpClientSendInput): Promise<SmtpClientSendResult | void> | SmtpClientSendResult | void
  }
  readonly from: string | ((input: SmtpSenderInput) => Promise<string> | string)
  readonly render: (input: SmtpRenderInput) => Promise<SmtpRenderedMessage> | SmtpRenderedMessage
  readonly now?: (input: { readonly now: Date }) => Date
}
