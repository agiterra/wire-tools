/**
 * Webhook channel handler for WireConnection.
 *
 * Unwraps the Wire server's webhook envelope:
 *   { from, from_name, topic, dest, plugin, payload }
 *
 * Extracts sender identity and message payload, produces a clean
 * ChannelResult for delivery.
 */

import type { ChannelHandler, ChannelResult } from "./connection.js";

/**
 * Create a webhook envelope channel handler.
 * Register with: conn.registerChannel("ipc", createWebhookChannelHandler())
 */
export function createWebhookChannelHandler(): ChannelHandler {
  return {
    process(payload: unknown, _validatorResult: unknown): ChannelResult | null {
      if (typeof payload !== "object" || payload === null) {
        return { text: String(payload), metadata: {} };
      }

      const envelope = payload as Record<string, unknown>;
      const source = (envelope.from as string) ?? "unknown";
      const metadata: Record<string, unknown> = {
        source,
        from_name: envelope.from_name ?? source,
        dest: envelope.dest,
        topic: envelope.topic,
        plugin: envelope.plugin,
      };

      // The actual message content
      const inner = envelope.payload;

      let text: string;
      if (typeof inner === "string") {
        text = inner;
      } else if (typeof inner === "object" && inner !== null) {
        const obj = inner as Record<string, unknown>;
        if (typeof obj.text === "string") {
          text = obj.text;
        } else if (typeof obj.message === "string") {
          text = obj.message;
        } else {
          text = JSON.stringify(inner);
        }
      } else {
        text = String(inner);
      }

      return { text, metadata };
    },
  };
}
