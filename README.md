# @agiterra/wire-tools

Shared primitives for The Wire ecosystem. Used by the server, adapters,
and channel plugins.

## What's included

| Module | What it does |
|--------|-------------|
| `crypto` | Ed25519 key management, signing, key derivation |
| `http` | Stateless REST helpers: register, connect, disconnect, ack, heartbeat |
| `sse` | SSE chunk parser |
| `reconnect` | Exponential backoff retry helper |
| `connection` | `WireConnection` class — lifecycle + message pipeline |

## WireConnection

The main interface for adapter authors. Manages:
- Key loading, agent registration, session management
- SSE streaming with auto-reconnect and re-registration
- Heartbeat
- Inbound message pipeline: channel handlers → enrichment → delivery

```typescript
import { WireConnection } from "@agiterra/wire-tools";

const conn = new WireConnection({
  url: "http://localhost:9800",
  agentId: "my-agent",
  agentName: "My Agent",
  deliver(payload) {
    // payload.raw — original Wire event
    // payload.channel — { text, metadata } from channel handler
    // payload.enrichment — results from enrichment pipeline
    console.log(payload.channel.text);
  },
});

// Register a channel handler (e.g. from @agiterra/wire-ipc)
conn.registerChannel("ipc", myIpcHandler);

// Configure enrichment pipeline per channel
conn.setEnrichmentPipeline("ipc", [
  slackContextEnricher,  // fetches recent Slack messages
  personaiEnricher,      // searches agent's memory vault
]);

await conn.start();
```

## Message Pipeline

```
SSE event
  → channel handler (registered by topic)
    → returns { text, metadata }
  → enrichment pipeline (ordered stages, each sees prior results)
    → returns scored results
  → deliver callback (adapter formats for its runtime)
```

## Building an adapter

An adapter is ~100 lines that:
1. Creates a `WireConnection` with a `deliver` callback
2. Registers channel handlers (e.g. IPC)
3. Wires the deliver callback to the runtime (MCP, Open Claw, etc.)
4. Handles process lifecycle (signals, stdin detection)

See `@agiterra/wire-claude-code` and `@agiterra/wire-openclaw` as
reference implementations.

## Enrichment

Enrichment is an agent-configured pipeline, not a built-in feature. Each
stage is an async function that receives the channel result, the raw event,
and the prior stages' results:

```typescript
const personaiEnricher = async (ctx) => {
  // ctx.channel.text — what to search against
  // ctx.prior — results from earlier pipeline stages
  const results = await runAssociationSearch(ctx.channel.text);
  return results.map(r => ({
    source: `personai://vault/${r.path}`,
    content: r.summary,
    score: r.score,
  }));
};
```

Agents compose pipelines per channel. See Personai and Wire docs for
wiring examples.
