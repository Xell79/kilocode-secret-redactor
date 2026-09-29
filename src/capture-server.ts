import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

export interface CaptureRecord {
  readonly timestamp: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

export interface CaptureServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly captureDir?: string;
  readonly modelId?: string;
  readonly responseText?: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MODEL = "mock-model";
const DEFAULT_RESPONSE = "Mock response: payload captured locally.";

export function makeCaptureServer(options: CaptureServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const captureDir = resolve(options.captureDir ?? "capture");
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const responseText = options.responseText ?? DEFAULT_RESPONSE;

  let sequence = 0;
  const history: CaptureRecord[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", captured: history.length }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: modelId,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "local-capture",
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/captures/latest") {
      const latest = history[history.length - 1];
      if (!latest) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no captures recorded yet" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(latest, null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/captures") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(history, null, 2));
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/v1/captures") {
      history.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // preserve raw string
      }

      sequence += 1;
      const record: CaptureRecord = {
        timestamp: new Date().toISOString(),
        path: url.pathname,
        method: req.method ?? "POST",
        headers: req.headers,
        body: parsed,
      };
      history.push(record);

      await mkdir(captureDir, { recursive: true });
      const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(sequence).padStart(4, "0")}.json`;
      await writeFile(
        resolve(captureDir, filename),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );

      const isStreaming = isRecord(parsed) && parsed.stream === true;
      const completionId = `chatcmpl-mock-${sequence}`;
      const created = Math.floor(Date.now() / 1000);

      if (isStreaming) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const roleChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        const textChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { content: responseText },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);

        const finishChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: completionId,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseText },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${url.pathname}` }));
  });

  return {
    server,
    history,
    start: () =>
      new Promise<void>((res) => {
        server.listen(port, host, () => res());
      }),
    stop: () =>
      new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
      }),
    url: `http://${host}:${port}`,
  };
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

// Direct CLI entrypoint: `node --import tsx src/capture-server.ts` or after build
if (
  process.argv[1] &&
  (process.argv[1].endsWith("capture-server.ts") ||
    process.argv[1].endsWith("capture-server.js") ||
    process.argv[1].endsWith("capture-server.cjs"))
) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const captureDir = process.env.CAPTURE_DIR ?? "capture";
  const app = makeCaptureServer({ port, captureDir });
  void app.start().then(() => {
    console.log(`[capture-server] listening on ${app.url}/v1`);
    console.log(`[capture-server] saving requests to ${resolve(captureDir)}`);
    console.log(`[capture-server] inspection: curl ${app.url}/v1/captures/latest`);
  });
}
