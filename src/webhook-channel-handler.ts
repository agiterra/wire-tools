/**
 * Webhook channel handler for WireConnection.
 *
 * Unwraps the Wire server's webhook envelope format:
 *   { plugin, endpoint, headers, body: { source, topic, payload, dest }, validator_result }
 *
 * Extracts verified sender identity from validator_result, unwraps the
 * inner payload, and produces a clean ChannelResult for delivery.
 *
 * This is Wire infrastructure — any webhook-delivered message uses this
 * envelope format, not just IPC.
 */

import type { ChannelHandler, ChannelResult } from "./connection.js";

/**
 * Create a webhook envelope channel handler.
 * Register with: conn.registerChannel("ipc", createWebhookChannelHandler())
 */
export function createWebhookChannelHandler(): ChannelHandler {
  return {
    process(payload: unknown, validatorResult: unknown): ChannelResult | null {
      // Unwrap webhook envelope → body → payload
      let actualPayload: unknown = payload;
      let source = "unknown";
      let metadata: Record<string, unknown> = {};

      // Validator result carries verified sender info
      if (
        typeof validatorResult === "object" &&
        validatorResult !== null
      ) {
        const vr = validatorResult as Record<string, unknown>;
        if (typeof vr.verified_sender === "string") {
          source = vr.verified_sender;
        }
        metadata.verified_sender = vr.verified_sender;
        metadata.sender_display_name = vr.sender_display_name;
      }

      // Unwrap the webhook envelope to get the actual message payload
      if (typeof payload === "object" && payload !== null) {
        const envelope = payload as Record<string, unknown>;
        if (envelope.body && typeof envelope.body === "object") {
          const body = envelope.body as Record<string, unknown>;
          if (body.payload !== undefined) {
            actualPayload = body.payload;
          }
          if (typeof body.source === "string" && source === "unknown") {
            source = body.source;
          }
          if (body.dest) metadata.dest = body.dest;
          if (body.topic) metadata.topic = body.topic;
        }
      }

      metadata.source = source;

      // Extract text from the payload
      let text: string;
      if (typeof actualPayload === "string") {
        text = actualPayload;
      } else if (typeof actualPayload === "object" && actualPayload !== null) {
        const obj = actualPayload as Record<string, unknown>;
        if (typeof obj.text === "string") {
          text = obj.text;
        } else if (typeof obj.message === "string") {
          text = obj.message;
        } else {
          text = JSON.stringify(actualPayload);
        }
        // Carry extra fields as metadata
        for (const [k, v] of Object.entries(obj)) {
          if (k !== "text" && k !== "message") {
            metadata[k] = v;
          }
        }
      } else {
        text = String(actualPayload);
      }

      return { text, metadata };
    },
  };
}
