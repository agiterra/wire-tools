// Connection + pipeline types (most adapter authors start here)
export {
  WireConnection,
  type ConnectionOptions,
  type WireEvent,
  type ChannelResult,
  type ChannelHandler,
  type EnrichmentResult,
  type EnrichmentContext,
  type Enricher,
  type DeliveryPayload,
  type DeliverFn,
} from "./connection.js";

// Channel handlers
export { createWebhookChannelHandler } from "./webhook-channel-handler.js";

// Logging
export { createLogger, type Logger } from "./logger.js";

// Low-level tools (for custom adapters or channel plugins)
export { generateKeyPair, exportPrivateKey, importPrivateKey, importKeyPair, signBody, derivePublicKeyB64, createAuthJwt, hashBody, type KeyPair } from "./crypto.js";
export { register, connect, disconnect, ack, heartbeat, setPlan, sendSignedMessage } from "./http.js";
export { parseSSEChunk } from "./sse.js";
export { retryWithBackoff } from "./reconnect.js";
