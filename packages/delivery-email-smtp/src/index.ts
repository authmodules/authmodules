export { redactDeliveryMessage } from './delivery/redaction.ts'
export { createSmtpDeliveryTransport } from './transport/create-smtp-delivery-transport.ts'
export type {
  SmtpClientSendInput,
  SmtpClientSendResult,
  SmtpDeliveryTransportOptions,
  SmtpRenderedMessage,
  SmtpRenderInput,
  SmtpSenderInput
} from './transport/types.ts'
