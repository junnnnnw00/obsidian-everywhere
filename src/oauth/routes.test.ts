import express from "express";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SingleUserOAuthProvider } from "./provider.js";
import { createLoginRouter } from "./routes.js";

function rawRequest(port: number, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/login",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("POST /login rate limiting", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const provider = new SingleUserOAuthProvider("irrelevant-for-this-test");
    const app = express();
    app.use(createLoginRouter(provider));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  it("rejects brute-force-style repeated attempts with 429 once the limit is exceeded", async () => {
    // Malformed body -> 400 from the route handler itself, cheap to repeat.
    // What matters here is that the rate limiter kicks in before that, not
    // whether any individual login attempt would have succeeded.
    const body = new URLSearchParams({ authzId: "x", secret: "guess" }).toString();

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await rawRequest(port, body);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
