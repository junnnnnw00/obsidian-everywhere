import express from "express";
import rateLimit from "express-rate-limit";
import { renderErrorPage } from "./provider.js";
import type { SingleUserOAuthProvider } from "./provider.js";

// `completeLogin` already burns the specific authzId on a wrong guess (see
// D11 in DECISIONS.md), but that alone doesn't stop a script from minting
// fresh authzIds and brute-forcing the shared login secret indefinitely.
// This is the one route in the OAuth flow the SDK's own auth router (which
// rate-limits its own endpoints) doesn't cover, since it's ours, not theirs.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/** The one non-SDK route in the OAuth flow: the login form submission. */
export function createLoginRouter(provider: SingleUserOAuthProvider): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.post("/login", loginRateLimit, (req, res) => {
    const { authzId, secret } = (req.body ?? {}) as { authzId?: unknown; secret?: unknown };
    if (typeof authzId !== "string" || typeof secret !== "string") {
      res.status(400).type("html").send(renderErrorPage("Malformed login submission."));
      return;
    }
    const result = provider.completeLogin(authzId, secret);
    if ("error" in result) {
      res.status(401).type("html").send(renderErrorPage(result.error));
      return;
    }
    res.redirect(result.redirectTo);
  });

  return router;
}
