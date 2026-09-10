/**
 * AGI-30 client side — createAuthJwt must mint iat + a SHORT exp + a unique jti.
 *
 * Self-contained, so it runs unchanged against the pristine wire-tools tree
 * (BEFORE: fails) and the patched one (AFTER: passes).
 * Copy to <tree>/src/crypto-agi30.test.ts and run `bun test src/crypto-agi30.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import * as cryptoMod from "./crypto";
const { createAuthJwt, generateKeyPair } = cryptoMod;
// Read defensively so this same file also LOADS against the pristine tree
// (which exports no such constant) and fails on assertions rather than on import.
const DEFAULT_JWT_TTL_SEC: number = (cryptoMod as any).DEFAULT_JWT_TTL_SEC ?? 60;

function claimsOf(jwt: string): Record<string, any> {
  const p = jwt.split(".")[1]!;
  const b64 = p.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

describe("AGI-30 — createAuthJwt claims", () => {
  test("mints iss, iat, body_hash, exp and jti", async () => {
    const kp = await generateKeyPair();
    const c = claimsOf(await createAuthJwt(kp.privateKey, "sericaia", '{"a":1}'));
    expect(c.iss).toBe("sericaia");
    expect(typeof c.iat).toBe("number");
    expect(typeof c.body_hash).toBe("string");
    expect(typeof c.exp).toBe("number");
    expect(typeof c.jti).toBe("string");
  });

  test("exp is SHORT — inside the gateway's 300s max-age window", async () => {
    const kp = await generateKeyPair();
    const c = claimsOf(await createAuthJwt(kp.privateKey, "sericaia", ""));
    expect(c.exp - c.iat).toBe(DEFAULT_JWT_TTL_SEC);
    expect(c.exp - c.iat).toBeLessThanOrEqual(300);
    expect(c.exp - c.iat).toBeGreaterThan(0);
  });

  test("jti is unique per call — even for the same issuer and the same body", async () => {
    const kp = await generateKeyPair();
    const jtis = new Set<string>();
    for (let i = 0; i < 200; i++) {
      jtis.add(claimsOf(await createAuthJwt(kp.privateKey, "sericaia", "")).jti);
    }
    expect(jtis.size).toBe(200);
  });

  test("two same-second, same-body tokens are NOT byte-identical any more", async () => {
    // This is the collision that makes the gateway's no-jti (iss, signature)
    // fallback key unsafe. Once jti is minted, it cannot happen.
    const kp = await generateKeyPair();
    const a = await createAuthJwt(kp.privateKey, "sericaia", "");
    const b = await createAuthJwt(kp.privateKey, "sericaia", "");
    expect(a).not.toBe(b);
  });

  test("the TTL is overridable per call, for a slow signed upload", async () => {
    const kp = await generateKeyPair();
    const c = claimsOf(await createAuthJwt(kp.privateKey, "sericaia", "", { ttlSec: 120 }));
    expect(c.exp - c.iat).toBe(120);
  });

  test("body_hash still binds the body (unchanged, defence in depth)", async () => {
    const kp = await generateKeyPair();
    const a = claimsOf(await createAuthJwt(kp.privateKey, "sericaia", '{"a":1}'));
    const b = claimsOf(await createAuthJwt(kp.privateKey, "sericaia", '{"a":2}'));
    expect(a.body_hash).not.toBe(b.body_hash);
    expect(a.body_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the JWT still verifies against the agent's public key", async () => {
    const kp = await generateKeyPair();
    const jwt = await createAuthJwt(kp.privateKey, "sericaia", '{"x":1}');
    const [h, p, s] = jwt.split(".");
    const raw = Uint8Array.from(atob(kp.publicKey), (ch) => ch.charCodeAt(0));
    const pub = await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
    const sig = Uint8Array.from(
      atob(s!.replace(/-/g, "+").replace(/_/g, "/")),
      (ch) => ch.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      pub,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});
