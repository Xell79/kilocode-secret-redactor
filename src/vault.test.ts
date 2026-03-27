import { describe, expect, it } from "vitest";
import { createVault } from "./vault.js";

describe("vault", () => {
  it("stores a secret and returns a redacted token", () => {
    const vault = createVault();
    const token = vault.store("api_key", "sk-secret-123");

    expect(token).toBe("<<REDACTED:api_key>>");
  });

  it("returns the same token for duplicate values", () => {
    const vault = createVault();
    const first = vault.store("key_a", "same-value");
    const second = vault.store("key_b", "same-value");

    expect(first).toBe(second);
  });

  it("scrubs known secrets from text", () => {
    const vault = createVault();
    vault.store("db_pass", "hunter2");

    const result = vault.scrubText("password is hunter2 ok");

    expect(result).toBe("password is <<REDACTED:db_pass>> ok");
  });

  it("unscrubs redacted tokens back to real values", () => {
    const vault = createVault();
    vault.store("db_pass", "hunter2");

    const result = vault.unscrubText("password is <<REDACTED:db_pass>> ok");

    expect(result).toBe("password is hunter2 ok");
  });

  it("round-trips scrub then unscrub", () => {
    const vault = createVault();
    vault.store("token", "abc123xyz");
    const original = "use abc123xyz for auth";

    const scrubbed = vault.scrubText(original);
    const restored = vault.unscrubText(scrubbed);

    expect(restored).toBe(original);
    expect(scrubbed).not.toBe(original);
  });

  it("tracks size correctly", () => {
    const vault = createVault();

    expect(vault.size).toBe(0);

    vault.store("a", "value-a");
    vault.store("b", "value-b");

    expect(vault.size).toBe(2);
  });

  it("handles multiple secrets in one text", () => {
    const vault = createVault();
    vault.store("user", "admin");
    vault.store("pass", "s3cret");

    const result = vault.scrubText("login admin with s3cret");

    expect(result).toBe("login <<REDACTED:user>> with <<REDACTED:pass>>");
  });
});
