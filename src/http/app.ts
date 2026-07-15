import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../mcp/server.js";
import type { VaultEngine } from "../vault-engine.js";

export interface HttpAppOptions {
  /** Static bearer token required on every /mcp request. */
  bearerToken: string;
}

function bearerAuth(bearerToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ") || header.slice("Bearer ".length) !== bearerToken) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Streamable HTTP transport exposing the same tool layer as the stdio
 * server, gated by a static bearer token. One StreamableHTTPServerTransport
 * (and MCP server instance) is created per session, keyed by
 * Mcp-Session-Id, per the SDK's stateful-session pattern.
 */
export function createHttpApp(engine: VaultEngine, options: HttpAppOptions): Express {
  const app = express();
  app.use(express.json());

  const auth = bearerAuth(options.bearerToken);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handle = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(sessionId ? 404 : 400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session (send an initialize request first)" },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };

      const mcpServer = createServer(engine);
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", auth, handle);
  app.get("/mcp", auth, handle);
  app.delete("/mcp", auth, handle);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}
