/**
 * The local server.
 *
 * It serves the single page from `public/` and three endpoints:
 *   GET  /api/chains          the chain list the entry screen offers
 *   GET  /api/analyze/stream  Server-Sent Events: progress, then one result
 *   POST /api/analyze         the same analysis as one JSON answer
 *
 * Two rules hold here, and each exists because this process holds a paid RPC
 * key and answers expensive questions:
 *
 *   1. The socket binds the loopback address unless an operator names a host.
 *   2. `AUTH_TOKEN` gates every `/api/` route when it is set, and a non
 *      loopback host without a token refuses to start.
 */

import { CHAINS, hasRpcEndpoint, MISSING_ENDPOINT_MESSAGE, PORT } from "./src/config";
import { analyzeContract } from "./src/pipeline";
import type { Depth } from "./src/types";

/* Every user brings their own RPC endpoint, from any provider. Refuse to
 * start without one, so the failure arrives here with instructions instead of
 * inside the first analysis as a provider error. */
if (!hasRpcEndpoint()) {
  console.error(MISSING_ENDPOINT_MESSAGE);
  process.exit(1);
}

const DEPTHS: Depth[] = ["quick", "standard", "deep"];

function parseRequest(params: URLSearchParams): { address: string; chainKey: string; depth: Depth } {
  const raw = (params.get("depth") ?? "standard").trim() as Depth;
  return {
    address: (params.get("address") ?? "").trim(),
    chainKey: (params.get("chain") ?? "ethereum").trim(),
    depth: DEPTHS.includes(raw) ? raw : "standard",
  };
}

const AUTH_TOKEN = process.env.AUTH_TOKEN?.trim();
const HOST = process.env.HOST?.trim() ?? "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

if (!LOOPBACK.has(HOST) && !AUTH_TOKEN) {
  console.error(
    `Refusing to start. HOST is ${HOST}, so this server would answer other machines, ` +
      "and it holds an RPC key with no authentication. Set AUTH_TOKEN, or leave HOST unset to stay on the loopback address.",
  );
  process.exit(1);
}

/** `true` when the caller may use the API. */
function authorised(request: Request, params: URLSearchParams): boolean {
  if (!AUTH_TOKEN) return true;
  const header = request.headers.get("x-auth-token")?.trim();
  const query = params.get("token")?.trim();
  return header === AUTH_TOKEN || query === AUTH_TOKEN;
}

const UNAUTHORISED = { message: "This server needs a token. Send it as the X-Auth-Token header or the token query parameter." };

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
};

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "/index.html" : pathname;
  if (relative.includes("..")) return new Response("Bad path", { status: 400 });
  const file = Bun.file(`${import.meta.dir}/public${relative}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const extension = relative.split(".").pop() ?? "";
  return new Response(file, { headers: { "content-type": MIME[extension] ?? "application/octet-stream" } });
}

function streamAnalysis(params: URLSearchParams): Response {
  const request = parseRequest(params);
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* the client closed the stream */
        }
      };
      try {
        const result = await analyzeContract({
          address: request.address,
          chainKey: request.chainKey,
          depth: request.depth,
          onProgress: (stage, detail, pct) => send("progress", { stage, detail, pct }),
        });
        send("result", result);
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  /* Bun binds every interface by default. This server holds no auth by
   * default and spends an RPC key on each request, so it stays on the
   * loopback address unless an operator names a different host. */
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && !authorised(request, url.searchParams)) {
      return Response.json(UNAUTHORISED, { status: 401 });
    }

    if (url.pathname === "/api/chains") {
      return Response.json({ chains: CHAINS, authRequired: !!AUTH_TOKEN });
    }

    if (url.pathname === "/api/analyze/stream" && request.method === "GET") {
      return streamAnalysis(url.searchParams);
    }

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      const payload = (await request.json().catch(() => ({}))) as Record<string, string>;
      const parsed = parseRequest(
        new URLSearchParams({
          address: payload.address ?? "",
          chain: payload.chain ?? "ethereum",
          depth: payload.depth ?? "standard",
        }),
      );
      try {
        return Response.json(await analyzeContract(parsed));
      } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }

    return await serveStatic(url.pathname);
  },
});

console.log(`Contract execution explorer on http://${HOST}:${server.port}`);
console.log(AUTH_TOKEN ? "Authentication is on. Send AUTH_TOKEN with every API request." : "Authentication is off. The socket is on the loopback address only.");
