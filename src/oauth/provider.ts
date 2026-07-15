import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface AccessTokenData {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshTokenData {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

export function renderLoginPage(authzId: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Obsidian Everywhere — Sign in</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a;}
input{width:100%;padding:0.6rem;font-size:1rem;box-sizing:border-box;margin-top:0.75rem;border:1px solid #ccc;border-radius:6px;}
button{margin-top:1rem;padding:0.6rem 1.2rem;font-size:1rem;cursor:pointer;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#fff;}
</style></head>
<body>
<h1>Obsidian Everywhere</h1>
<p>Enter the connector secret to link this client to your vault. This secret was set by whoever deployed this server (<code>OAUTH_LOGIN_SECRET</code>).</p>
<form method="POST" action="/login">
<input type="hidden" name="authzId" value="${authzId}" />
<input type="password" name="secret" placeholder="Connector secret" autofocus required />
<button type="submit">Sign in</button>
</form>
</body></html>`;
}

export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Obsidian Everywhere — Sign-in failed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;">
<h1>Sign-in failed</h1>
<p>${message}</p>
<p>Go back to Claude and try connecting again.</p>
</body></html>`;
}

/**
 * Minimal single-user OAuth 2.1 provider (PKCE + Dynamic Client
 * Registration) for the claude.ai custom-connector flow. There is exactly
 * one user, authenticated by a single pre-shared secret string entered on
 * an HTML form — deliberately not a general-purpose multi-tenant identity
 * provider (see DECISIONS.md D11).
 */
export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, PendingAuthorization>();
  private accessTokens = new Map<string, AccessTokenData>();
  private refreshTokens = new Map<string, RefreshTokenData>();

  constructor(private readonly loginSecret: string) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    const authzId = randomUUID();
    this.pending.set(authzId, { client, params });
    res.type("html").send(renderLoginPage(authzId));
  }

  /** Invoked by the (non-SDK) POST /login route once the secret form is submitted. */
  completeLogin(authzId: string, secret: string): { redirectTo: string } | { error: string } {
    const pending = this.pending.get(authzId);
    this.pending.delete(authzId); // one-shot, whether or not the secret is correct
    if (!pending) {
      return { error: "This login link has expired or was already used." };
    }
    if (secret !== this.loginSecret) {
      return { error: "Incorrect secret." };
    }

    const code = randomUUID();
    this.codes.set(code, pending);
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
    return { redirectTo: target.toString() };
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new InvalidGrantError("Invalid authorization code");
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new InvalidGrantError("Invalid authorization code");
    if (codeData.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const scopes = codeData.params.scopes ?? [];
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: codeData.params.resource,
    });
    this.refreshTokens.set(refreshToken, { clientId: client.client_id, scopes, resource: codeData.params.resource });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");

    const accessToken = randomUUID();
    const grantedScopes = scopes ?? data.scopes;
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: grantedScopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: data.resource,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: grantedScopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.accessTokens.get(token);
    if (!data || data.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      resource: data.resource,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }
}
