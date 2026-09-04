#!/usr/bin/env node

import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";

const fragment = process.argv[2];
if (!fragment) throw new Error("provider fragment path is required");

function environment() {
  return parseEnv(readFileSync(fragment, "utf8"));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function validAssertion(assertion, values) {
  try {
    const [encodedHeader, encodedPayload, encodedSignature, extra] = assertion.split(".");
    if (extra !== undefined) return false;
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      payload.iss !== values.FIXTURE_TAMA_INTROSPECTION_CLIENT_ID ||
      payload.sub !== values.FIXTURE_TAMA_INTROSPECTION_CLIENT_ID ||
      payload.aud !== `${values.FIXTURE_OAUTH_ISSUER}/auth/introspections` ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return false;
    }
    const response = await fetch(values.FIXTURE_TAMA_INTROSPECTION_JWKS_URI);
    if (!response.ok) return false;
    const jwks = await response.json();
    const jwk = jwks.keys?.find((entry) => entry.kid === header.kid);
    if (!jwk) return false;
    return verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const values = environment();
  if (request.url === "/.well-known/oauth-authorization-server") {
    json(response, 200, {
      issuer: values.FIXTURE_OAUTH_ISSUER,
      jwks_uri: `${values.FIXTURE_OAUTH_ISSUER}/.well-known/jwks.json`,
      ...(values.FIXTURE_TAMA_MCP_APP_MODE === "enabled"
        ? { protected_resources: [values.FIXTURE_TAMA_MCP_APP_RESOURCE] }
        : {}),
    });
    return;
  }
  if (request.url === "/.well-known/jwks.json") {
    const privateJwk = JSON.parse(values.FIXTURE_OAUTH_PRIVATE_SIGNING_KEY);
    const publicJwk = createPublicKey(createPrivateKey({ key: privateJwk, format: "jwk" })).export({
      format: "jwk",
    });
    json(response, 200, {
      keys: [
        {
          ...publicJwk,
          kid: values.FIXTURE_OAUTH_SIGNING_KEY_ID,
          alg: "RS256",
          use: "sig",
        },
      ],
    });
    return;
  }
  if (request.url === "/auth/introspections" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (!(await validAssertion(form.get("client_assertion") ?? "", values))) {
      json(response, 401, { error: "invalid_client" });
      return;
    }
    json(response, 200, { active: false });
    return;
  }
  json(response, 404, { error: "not_found" });
});

const port = Number(environment().FIXTURE_TAMA_LOCAL_HTTPS_UPSTREAM_PORT);
server.listen(port, "0.0.0.0", () => process.stdout.write(`ready:${port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
