/**
 * Ed25519 key management and signing for Wire agents.
 *
 * Keys stored as PKCS8 (private) and raw base64 (public) at ~/.wire/keys/.
 * Uses Web Crypto API — works in Node, Bun, and Deno.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type KeyPair = {
  publicKey: string; // base64-encoded raw Ed25519 public key (32 bytes)
  privateKey: CryptoKey;
};

export async function derivePublicKeyB64(
  privateKey: CryptoKey,
): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const pubB64Url = jwk.x!;
  const pubB64 = pubB64Url.replace(/-/g, "+").replace(/_/g, "/");
  return pubB64 + "=".repeat((4 - (pubB64.length % 4)) % 4);
}

export async function loadOrCreateKey(
  agentId: string,
  dir?: string,
): Promise<KeyPair> {
  const keyDir = dir ?? join(homedir(), ".wire", "keys");
  const keyPath = join(keyDir, `${agentId}.key`);

  if (existsSync(keyPath)) {
    const pkcs8 = readFileSync(keyPath);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", pkcs8, "Ed25519", true, ["sign"],
    );
    return { publicKey: await derivePublicKeyB64(privateKey), privateKey };
  }

  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const publicKey = Buffer.from(rawPub).toString("base64");
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(keyPath, Buffer.from(pkcs8), { mode: 0o600 });

  return { publicKey, privateKey: kp.privateKey };
}

/**
 * Generate a new Ed25519 keypair. Returns public key (base64) and private key (CryptoKey).
 * Pure function — no filesystem access.
 */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = await derivePublicKeyB64(kp.privateKey);
  return { publicKey, privateKey: kp.privateKey };
}

/**
 * Export a private key as base64 PKCS8 string.
 */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return Buffer.from(pkcs8).toString("base64");
}

export async function signBody(
  privateKey: CryptoKey,
  body: string,
): Promise<string> {
  const data = new TextEncoder().encode(body);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data);
  return Buffer.from(sig).toString("base64");
}
