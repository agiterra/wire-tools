import { describe, test, expect, afterEach } from "bun:test";
import { generateKeyPair } from "./crypto";
import { listWebhooks, setWebhookFilter } from "./http";

// AGI-103 — the request shapes the `wire` plugin sends to the gateway's
// webhook self-service routes. The gateway verifies an Ed25519 JWT whose
// body_hash covers the EXACT bytes sent, so "shape" here means method, path,
// body and a signature that actually matches that body — a PATCH signed over
// the wrong bytes is rejected with "body hash mismatch", which is precisely
// the failure these tests exist to catch before it reaches a live agent.

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | null };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(response: unknown, status = 200): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), method: init.method ?? "GET", headers, body: init.body ?? null });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

/** Decode the JWT the helper signed, so we can check iss and body_hash. */
function jwtClaims(authorization: string): Record<string, any> {
  const payload = authorization.replace(/^Bearer /, "").split(".")[1];
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("AGI-103 — listWebhooks request shape", () => {
  test("GETs the caller's OWN webhook collection, signed as the caller", async () => {
    const kp = await generateKeyPair();
    const calls = stubFetch({ webhooks: [{ id: 7, agent_id: "papassinos", plugin: "github", name: "pr-9", filter: "true", dedup: null, created_at: 1, meta: null }] });

    const rows = await listWebhooks("http://wire.test", "papassinos", kp.privateKey);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://wire.test/agents/papassinos/webhooks");
    expect(calls[0].body).toBeNull();
    expect(calls[0].headers.authorization).toStartWith("Bearer ");
    const claims = jwtClaims(calls[0].headers.authorization);
    expect(claims.iss).toBe("papassinos");
    // A bodiless request is signed over the empty string.
    expect(claims.body_hash).toBe(await sha256Hex(""));
    // The helper unwraps the { webhooks: [...] } envelope.
    expect(rows.map((r) => r.id)).toEqual([7]);
  });

  test("a non-2xx answer surfaces the gateway's status and text, not an empty list", async () => {
    const kp = await generateKeyPair();
    stubFetch({ error: "JWT issuer does not match agent" }, 403);
    await expect(listWebhooks("http://wire.test", "cannoli", kp.privateKey)).rejects.toThrow(/403/);
  });
});

describe("AGI-103 — setWebhookFilter request shape", () => {
  test("PATCHes the single row, with a body_hash over the exact bytes sent", async () => {
    const kp = await generateKeyPair();
    const expr = `payload.action === "opened"`;
    const calls = stubFetch({ webhook_id: 7, filter: expr, previous_filter: "true" });

    const result = await setWebhookFilter("http://wire.test", "papassinos", 7, expr, kp.privateKey);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("http://wire.test/agents/papassinos/webhooks/7");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].body).toBe(JSON.stringify({ filter: expr }));
    const claims = jwtClaims(calls[0].headers.authorization);
    expect(claims.iss).toBe("papassinos");
    expect(claims.body_hash).toBe(await sha256Hex(calls[0].body!));
    expect(result.previous_filter).toBe("true");
  });

  test("clearing sends an explicit null — NOT an omitted field (the route requires the key)", async () => {
    const kp = await generateKeyPair();
    const calls = stubFetch({ webhook_id: 7, filter: null, previous_filter: "false" });

    await setWebhookFilter("http://wire.test", "papassinos", 7, null, kp.privateKey);

    expect(calls[0].body).toBe(`{"filter":null}`);
    expect(JSON.parse(calls[0].body!)).toHaveProperty("filter");
  });

  test("a rejected filter surfaces the gateway's 400 and its error text", async () => {
    const kp = await generateKeyPair();
    stubFetch({ error: "invalid filter: payloadd is not defined" }, 400);
    await expect(
      setWebhookFilter("http://wire.test", "papassinos", 7, "payloadd.action", kp.privateKey),
    ).rejects.toThrow(/invalid filter: payloadd is not defined/);
  });
});
