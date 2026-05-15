/**
 * Stateless HTTP helpers for Wire REST API.
 *
 * All mutating endpoints use JWT Bearer auth (EdDSA/Ed25519).
 * The JWT iss claim identifies the calling agent; body_hash ensures integrity.
 *
 * Core protocol operations + channel-agnostic message sending.
 */

import { join } from "path";
import { createAuthJwt, generateKeyPair, exportPrivateKey, derivePublicKeyB64 } from "./crypto.js";
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

async function jwtHeaders(
  agentId: string,
  body: string,
  signingKey: CryptoKey,
): Promise<Record<string, string>> {
  const token = await createAuthJwt(signingKey, agentId, body);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export async function register(
  url: string,
  callerAgentId: string,
  newAgentId: string,
  displayName: string,
  publicKey: string,
  signingKey: CryptoKey,
  options?: { force_rotate?: boolean },
): Promise<void> {
  const body = JSON.stringify({
    id: newAgentId,
    display_name: displayName,
    pubkey: publicKey,
    ...(options?.force_rotate ? { force_rotate: true } : {}),
  });
  const res = await fetch(`${url}/agents/register`, {
    method: "POST",
    headers: await jwtHeaders(callerAgentId, body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire register failed (${res.status}): ${await res.text()}`);
  }
}

export type RegisterMode = "fresh" | "byo" | "refresh-existing";

export type RegisterOrRefreshResult = {
  agentId: string;
  displayName: string;
  pubkey: string;
  privateKey?: string; // base64 PKCS8, only present in `fresh` mode
  mode: RegisterMode;
};

/**
 * Higher-level registration that handles three sponsor flows in one call:
 *
 *   - `byo`              — caller supplied a pubkey, just register it.
 *   - `refresh-existing` — no pubkey supplied, but Wire already has a row
 *                          at this id. Reuse the existing pubkey so the
 *                          live agent process (which still holds the
 *                          matching private key) keeps working.
 *   - `fresh`            — no pubkey supplied and id is unknown. Mint a
 *                          fresh keypair and return the private key so the
 *                          caller can hand it to the spawn flow.
 *
 * `force_rotate: true` skips the existing-row probe and always mints a
 * fresh keypair, permanently locking out any process still holding the
 * old key. Use only when you've confirmed no live process holds it.
 *
 * The smart-refresh path was added 2026-05-15 (Tim): "If the Wire has the
 * pub key in hand, then brioche should just be able to re-register
 * eclair2 without sending the pub key, and The Wire should just mark her
 * as active."
 */
export async function registerOrRefresh(
  url: string,
  callerAgentId: string,
  callerSigningKey: CryptoKey,
  newAgentId: string,
  displayName: string,
  options?: { pubkey?: string; force_rotate?: boolean },
): Promise<RegisterOrRefreshResult> {
  const providedPubkey = options?.pubkey;
  const forceRotate = options?.force_rotate === true;

  let pubkey: string | undefined = providedPubkey;
  let privateKey: string | undefined;
  let mode: RegisterMode;

  if (providedPubkey) {
    mode = "byo";
  } else if (!forceRotate) {
    // Probe for existing row; if found, reuse its pubkey.
    try {
      const res = await fetch(`${url}/agents?kind=all`);
      if (res.ok) {
        const all = (await res.json()) as Array<{ id: string; pubkey: string }>;
        const existing = all.find((a) => a.id === newAgentId);
        if (existing) {
          pubkey = existing.pubkey;
          mode = "refresh-existing";
        }
      }
    } catch {
      // Network blip — fall through to keypair generation. Worst case is a
      // pubkey-mismatch error from /agents/register, which surfaces clearly.
    }
  }

  if (!pubkey) {
    const kp = await generateKeyPair();
    privateKey = await exportPrivateKey(kp.privateKey);
    pubkey = await derivePublicKeyB64(kp.privateKey);
    mode = "fresh";
  }

  await register(
    url,
    callerAgentId,
    newAgentId,
    displayName,
    pubkey,
    callerSigningKey,
    forceRotate ? { force_rotate: true } : undefined,
  );

  return { agentId: newAgentId, displayName, pubkey, privateKey, mode: mode! };
}

export async function connect(
  url: string,
  agentId: string,
  signingKey: CryptoKey,
  ccSessionId?: string,
): Promise<string> {
  const payload: Record<string, string> = {};
  if (ccSessionId) payload.cc_session_id = ccSessionId;
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/agents/connect`, {
    method: "POST",
    headers: await jwtHeaders(agentId, body, signingKey),
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
  const body = JSON.stringify({ session_id: sessionId });
  try {
    const res = await fetch(`${url}/agents/disconnect`, {
      method: "POST",
      headers: await jwtHeaders(agentId, body, signingKey),
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
  const body = JSON.stringify({ session_id: sessionId, seq });
  const res = await fetch(`${url}/agents/ack`, {
    method: "POST",
    headers: await jwtHeaders(agentId, body, signingKey),
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
    headers: await jwtHeaders(agentId, body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire set_plan failed (${res.status}): ${await res.text()}`);
  }
}

export type HeartbeatResult =
  | { ok: true }
  | { ok: false; sessionInvalid: boolean; status?: number; err?: unknown };

export async function heartbeat(
  url: string,
  agentId: string,
  sessionId: string,
  signingKey: CryptoKey,
): Promise<HeartbeatResult> {
  const body = "{}";
  try {
    const res = await fetch(
      `${url}/agents/${agentId}/sessions/${sessionId}/heartbeat`,
      {
        method: "POST",
        headers: await jwtHeaders(agentId, body, signingKey),
        body,
      },
    );
    if (!res.ok) {
      log.error({ event: "heartbeat_rejected", agentId, sessionId, status: res.status }, "heartbeat rejected");
      // 403 (session does not belong to agent) and 404 (agent or session not
      // found) both mean our local sessionId is stale — server purged the
      // session row but we kept using it. Caller must trigger a reconnect.
      const sessionInvalid = res.status === 403 || res.status === 404;
      return { ok: false, sessionInvalid, status: res.status };
    }
    log.debug({ event: "heartbeat_ok", agentId, sessionId }, "heartbeat ok");
    return { ok: true };
  } catch (e) {
    log.error({ event: "heartbeat_failed", agentId, sessionId, err: e }, "heartbeat failed");
    // Network/transport errors are not session-invalid — they're transient.
    return { ok: false, sessionInvalid: false, err: e };
  }
}

/**
 * Send a JWT-signed message to an agent via a Wire webhook channel.
 * Channel-agnostic — the topic determines which plugin channel receives it.
 */
export async function sendSignedMessage(
  url: string,
  agentId: string,
  signingKey: CryptoKey,
  topic: string,
  payload: unknown,
  dest?: string,
): Promise<{ seq: number }> {
  const body = JSON.stringify(payload);
  const endpoint = dest
    ? `${url}/webhooks/${dest}/${topic}`
    : `${url}/broadcast/${topic}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: await jwtHeaders(agentId, body, signingKey),
    body,
  });
  if (!res.ok) {
    throw new Error(`Wire send failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { seq: number };
}
