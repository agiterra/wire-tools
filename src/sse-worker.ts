/**
 * SSE worker — Bun Worker entry. Thin shim around SseRunner.
 *
 * All the actual logic lives in sse-runner.ts. This file exists only to host
 * the Bun Worker postMessage/onmessage glue so connection.ts can talk to the
 * runner over a structured-clone channel and the streaming fetch stays
 * isolated from the main event loop (see sse-runner.ts for why).
 *
 * Under Node/tsx, connection.ts skips this file entirely and constructs an
 * SseRunner directly on the main thread (Node's fetch doesn't block the
 * event loop the way Bun's does, so the worker isolation isn't needed).
 *
 * Protocol — unchanged from v2.3.1:
 *   main → worker: {type:"boot", url, agentId, agentName, ccSessionId?, privateKeyB64}
 *   main → worker: {type:"reset"}
 *   main → worker: {type:"stop"}
 *   worker → main: {type:"stream_live", sessionId}
 *   worker → main: {type:"stream_dead", reason?}
 *   worker → main: {type:"event", event}
 *   worker → main: {type:"give_up", reason}
 *   worker → main: {type:"log", level, fields, msg}
 */

import { SseRunner, type SseRunnerOutMsg, type SseRunnerBootMsg } from "./sse-runner.js";

declare const self: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
};

const runner = new SseRunner((msg: SseRunnerOutMsg) => self.postMessage(msg));

self.onmessage = (ev) => {
  const data = ev.data as { type?: string } & Record<string, unknown>;
  if (data?.type === "boot") {
    void runner.boot(data as SseRunnerBootMsg);
  } else if (data?.type === "reset") {
    runner.reset();
  } else if (data?.type === "stop") {
    runner.stop();
  }
};
