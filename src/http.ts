/**
 * Stateless HTTP helpers for Wire REST API.
 *
 * All mutating endpoints require an Ed25519 signing key. The request body
 * is signed and sent via X-Wire-Signature header.
 *
 * Core protocol operations only. IPC-specific helpers (webhook registration,
 * signed message sending) belong in @agiterra/wire-ipc.
 */

import { join } from "path";
import { signBody } from "./crypto.js";
import { createLogger } from "./logger.js";

const WIRE_LOG = join(process.env.HOME ?? "/tmp", ".wire", "wire-connection.jsonl");
const log = createLogger("wire-http", WIRE_LOG);

export type WireEvent = {
  seq: number;
  source: string;
  topic: string;
  payload: unknown;
  dest?: string | null;
  created_at: number;
};

async function signedHeaders(
  body: string,
  signingKey: CryptoKey,
): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    "X-Wire-Signature": await signBody(signingKey, body),
  };
}

export async function register(
  url: string,
  agentId: string,
  displayName: string,
  publicKey: string,
  signingKey: CryptoKey,
  subscriptions: string[] = ["*"],
): Promise<void> {
  const body = JSON.stringify({
    id: agentId,
    display_name: displayName,
    pubkey: publicKey,
    subscriptions: subscriptions.map((topic) => ({ topic })),
  });
  const res = await fetch(`${url}/agents/register`, {
    method: "POST",
    headers: await signedHeaders(body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire register failed (${res.status}): ${await res.text()}`);
  }
}

export async function connect(
  url: string,
  agentId: string,
  signingKey: CryptoKey,
  ccSessionId?: string,
): Promise<string> {
  const payload: Record<string, string> = { agent_id: agentId };
  if (ccSessionId) payload.cc_session_id = ccSessionId;
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/agents/connect`, {
    method: "POST",
    headers: await signedHeaders(body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire connect failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

export async function disconnect(
  url: string,
  agentId: string,
  sessionId: string,
  signingKey: CryptoKey,
): Promise<void> {
  const body = JSON.stringify({ session_id: sessionId, agent_id: agentId });
  try {
    const res = await fetch(`${url}/agents/disconnect`, {
      method: "POST",
      headers: await signedHeaders(body, signingKey),
      body,
    });
    if (!res.ok) {
      log.error({ event: "disconnect_rejected", agentId, sessionId, status: res.status }, "disconnect rejected");
    }
  } catch (e) {
    log.error({ event: "disconnect_failed", agentId, sessionId, err: e }, "disconnect failed");
  }
}

export async function ack(
  url: string,
  agentId: string,
  sessionId: string,
  seq: number,
  signingKey: CryptoKey,
): Promise<void> {
  const body = JSON.stringify({ session_id: sessionId, seq, agent_id: agentId });
  const res = await fetch(`${url}/agents/ack`, {
    method: "POST",
    headers: await signedHeaders(body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire ack failed (${res.status}): ${await res.text()}`);
  }
}

export async function setPlan(
  url: string,
  agentId: string,
  plan: string,
  signingKey: CryptoKey,
): Promise<void> {
  const body = JSON.stringify({ plan });
  const res = await fetch(`${url}/agents/${agentId}/plan`, {
    method: "PUT",
    headers: await signedHeaders(body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire set_plan failed (${res.status}): ${await res.text()}`);
  }
}

export async function heartbeat(
  url: string,
  agentId: string,
  sessionId: string,
  signingKey: CryptoKey,
): Promise<void> {
  const body = JSON.stringify({ agent_id: agentId, session_id: sessionId });
  try {
    const res = await fetch(
      `${url}/agents/${agentId}/sessions/${sessionId}/heartbeat`,
      {
        method: "POST",
        headers: await signedHeaders(body, signingKey),
        body,
      },
    );
    if (!res.ok) {
      log.error({ event: "heartbeat_rejected", agentId, sessionId, status: res.status }, "heartbeat rejected");
    } else {
      log.debug({ event: "heartbeat_ok", agentId, sessionId }, "heartbeat ok");
    }
  } catch (e) {
    log.error({ event: "heartbeat_failed", agentId, sessionId, err: e }, "heartbeat failed");
  }
}
