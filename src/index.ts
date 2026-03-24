// Connection + pipeline types (most adapter authors start here)
export {
  ExchangeConnection,
  type ConnectionOptions,
  type ExchangeEvent,
  type ChannelResult,
  type ChannelHandler,
  type EnrichmentResult,
  type EnrichmentContext,
  type Enricher,
  type DeliveryPayload,
  type DeliverFn,
} from "./connection.js";

// Low-level tools (for custom adapters or channel plugins)
export { loadOrCreateKey, signBody, derivePublicKeyB64, type KeyPair } from "./crypto.js";
export { register, connect, disconnect, ack, heartbeat } from "./http.js";
export { parseSSEChunk } from "./sse.js";
export { retryWithBackoff } from "./reconnect.js";
