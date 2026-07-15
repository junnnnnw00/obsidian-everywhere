import express from "express";
import { renderErrorPage } from "./provider.js";
import type { SingleUserOAuthProvider } from "./provider.js";

/** The one non-SDK route in the OAuth flow: the login form submission. */
export function createLoginRouter(provider: SingleUserOAuthProvider): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.post("/login", (req, res) => {
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
