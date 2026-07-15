import express, { type Express } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mountMcpEndpoint } from "../http/app.js";
import type { VaultEngine } from "../vault-engine.js";
import { SingleUserOAuthProvider } from "./provider.js";
import { createLoginRouter } from "./routes.js";

export interface OAuthHttpAppOptions {
  /** Public HTTPS origin this server is reachable at (e.g. the Cloudflare Tunnel hostname). */
  issuerUrl: URL;
  /** Single pre-shared login secret (see D11 in DECISIONS.md). */
  loginSecret: string;
}

/**
 * Streamable HTTP transport gated by OAuth 2.1 (PKCE + Dynamic Client
 * Registration), for the claude.ai custom-connector flow. This process
 * acts as both the authorization server and the resource server — a
 * deliberate simplification for a single-user deployment (see D11).
 */
export function createOAuthHttpApp(engine: VaultEngine, options: OAuthHttpAppOptions): Express {
  const resourceUrl = new URL("/mcp", options.issuerUrl);
  const provider = new SingleUserOAuthProvider(options.loginSecret);

  const app = express();
  app.use(express.json());

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: options.issuerUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ["mcp:tools"],
    }),
  );
  app.use(createLoginRouter(provider));

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  mountMcpEndpoint(app, engine, requireBearerAuth({ verifier: provider, resourceMetadataUrl }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}
