import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../mcp/server.js";
import type { VaultEngine } from "../vault-engine.js";

export interface HttpAppOptions {
  /** Static bearer token required on every /mcp request. */
  bearerToken: string;
  /** Register all write tools. Defaults to true. */
  enableWriteTools?: boolean;
}

function bearerAuth(bearerToken: string): RequestHandler {
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
 * Mounts GET/POST/DELETE /mcp on `app`, gated by `authMiddleware`. One
 * StreamableHTTPServerTransport (and MCP server instance) is created per
 * session, keyed by Mcp-Session-Id, per the SDK's stateful-session pattern.
 * Shared by both the static-bearer app (Phase 3) and the OAuth app
 * (Phase 4) so the transport/session bookkeeping only lives in one place.
 */
export function mountMcpEndpoint(
  app: Express,
  engine: VaultEngine,
  authMiddleware: RequestHandler,
  options: { enableWriteTools?: boolean } = {},
): void {
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

      const mcpServer = createServer(engine, { enableWriteTools: options.enableWriteTools });
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", authMiddleware, handle);
  app.get("/mcp", authMiddleware, handle);
  app.delete("/mcp", authMiddleware, handle);
}

/** Streamable HTTP transport gated by a static bearer token (remote Claude Code over Tailscale). */
export function createHttpApp(engine: VaultEngine, options: HttpAppOptions): Express {
  const app = express();
  app.use(express.json());

  mountMcpEndpoint(app, engine, bearerAuth(options.bearerToken), { enableWriteTools: options.enableWriteTools });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}
