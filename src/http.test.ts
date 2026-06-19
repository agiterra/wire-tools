import { describe, test, expect } from "bun:test";
import { deriveScreenName } from "./http";

describe("deriveScreenName — durable self-report screen name", () => {
  test("derives name as everything after the first dot of STY", () => {
    expect(deriveScreenName({ STY: "12345.fondant" })).toBe("fondant");
  });

  test("keeps dots that appear after the first one (e.g. hostnames)", () => {
    expect(deriveScreenName({ STY: "999.eclair2.mac-mini" })).toBe("eclair2.mac-mini");
  });

  test("WIRE_SCREEN_NAME overrides STY derivation", () => {
    expect(deriveScreenName({ STY: "12345.derived", WIRE_SCREEN_NAME: "explicit" })).toBe("explicit");
  });

  test("WIRE_SCREEN_NAME works even when STY is absent", () => {
    expect(deriveScreenName({ WIRE_SCREEN_NAME: "explicit" })).toBe("explicit");
  });

  test("returns undefined when STY is unset and no override", () => {
    expect(deriveScreenName({})).toBeUndefined();
  });

  test("returns undefined when STY is empty", () => {
    expect(deriveScreenName({ STY: "" })).toBeUndefined();
  });

  test("returns undefined when STY has no dot", () => {
    expect(deriveScreenName({ STY: "nodothere" })).toBeUndefined();
  });

  test("returns undefined when STY ends with a dot (empty name)", () => {
    expect(deriveScreenName({ STY: "12345." })).toBeUndefined();
  });
});
