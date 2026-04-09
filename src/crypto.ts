/**
 * Ed25519 crypto primitives for Wire agents.
 *
 * Pure functions — no filesystem access. Keys are provided by the caller
 * (from env vars, generated in memory, etc.).
 * Uses Web Crypto API — works in Node, Bun, and Deno.
 */

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

/**
 * Import a private key from a base64 PKCS8 string (e.g. CREW_PRIVATE_KEY env var).
 */
export async function importPrivateKey(base64Pkcs8: string): Promise<CryptoKey> {
  const pkcs8 = Uint8Array.from(atob(base64Pkcs8), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
}

/**
 * Import a base64 PKCS8 private key and derive the full KeyPair.
 */
export async function importKeyPair(base64Pkcs8: string): Promise<KeyPair> {
  const privateKey = await importPrivateKey(base64Pkcs8);
  const publicKey = await derivePublicKeyB64(privateKey);
  return { publicKey, privateKey };
}

export async function signBody(
  privateKey: CryptoKey,
  body: string,
): Promise<string> {
  const data = new TextEncoder().encode(body);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data);
  return Buffer.from(sig).toString("base64");
}

// --- JWT auth for Wire REST API ---

function base64urlEncode(data: Uint8Array): string {
  let str = "";
  for (const b of data) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const JWT_HEADER_B64 = base64urlEncode(
  new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })),
);

export async function hashBody(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a JWT for Wire REST API authentication.
 * Claims: iss (agent ID), iat, body_hash (SHA-256 of request body).
 */
export async function createAuthJwt(
  privateKey: CryptoKey,
  agentId: string,
  body: string,
): Promise<string> {
  const claims = {
    iss: agentId,
    iat: Math.floor(Date.now() / 1000),
    body_hash: await hashBody(body),
  };
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`;
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
}
