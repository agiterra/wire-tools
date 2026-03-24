/**
 * Stateless HTTP helpers for Exchange REST API.
 *
 * Core protocol operations only. IPC-specific helpers (webhook registration,
 * signed message sending) belong in @agiterra/exchange-ipc.
 */

export type ExchangeEvent = {
  seq: number;
  source: string;
  topic: string;
  payload: unknown;
  dest?: string | null;
  created_at: number;
};

export async function register(
  url: string,
  agentId: string,
  displayName: string,
  publicKey: string,
  subscriptions: string[] = ["*"],
): Promise<void> {
  const res = await fetch(`${url}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: agentId,
      display_name: displayName,
      pubkey: publicKey,
      subscriptions: subscriptions.map((topic) => ({ topic })),
    }),
  });
  if (!res.ok) {
    throw new Error(`Exchange register failed (${res.status}): ${await res.text()}`);
  }
}

export async function connect(
  url: string,
  agentId: string,
): Promise<string> {
  const res = await fetch(`${url}/agents/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) {
    throw new Error(`Exchange connect failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

export async function disconnect(
  url: string,
  sessionId: string,
): Promise<void> {
  await fetch(`${url}/agents/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
}

export async function ack(
  url: string,
  sessionId: string,
  seq: number,
): Promise<void> {
  const res = await fetch(`${url}/agents/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, seq }),
  });
  if (!res.ok) {
    throw new Error(`Exchange ack failed (${res.status}): ${await res.text()}`);
  }
}

export async function heartbeat(
  url: string,
  agentId: string,
  sessionId: string,
): Promise<void> {
  await fetch(
    `${url}/agents/${agentId}/sessions/${sessionId}/heartbeat`,
    { method: "POST" },
  ).catch(() => {});
}
