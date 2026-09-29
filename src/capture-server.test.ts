import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCaptureServer } from "./capture-server.js";

describe("capture-server", () => {
  let tempDir: string;
  let server: ReturnType<typeof makeCaptureServer>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capture-test-"));
    server = makeCaptureServer({
      port: 0,
      host: "127.0.0.1",
      captureDir: tempDir,
      modelId: "test-sink",
      responseText: "sink-acknowledged",
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves /v1/models for Kilo model discovery", async () => {
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(data.object).toBe("list");
    expect(data.data[0].id).toBe("test-sink");
  });

  it("captures non-streaming chat completions and writes to disk", async () => {
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const payload = {
      model: "test-sink",
      messages: [{ role: "user", content: "hello with 🔒token_1🔓" }],
      stream: false,
    };
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(reply.choices[0].message.content).toBe("sink-acknowledged");

    // Inspect in-memory
    expect(server.history).toHaveLength(1);
    expect(server.history[0].body).toEqual(payload);

    // Inspect via HTTP endpoint
    const latestRes = await fetch(`http://127.0.0.1:${address.port}/v1/captures/latest`);
    const latest = (await latestRes.json()) as { body: typeof payload };
    expect(latest.body).toEqual(payload);
  });

  it("handles streaming SSE completions", async () => {
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const payload = {
      model: "test-sink",
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
    };
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("sink-acknowledged");
    expect(text).toContain("data: [DONE]");
  });
});
