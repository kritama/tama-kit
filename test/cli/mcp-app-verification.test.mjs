import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyListenerAddress,
  createHttpHostMappedFetch,
  defaultProviderListenerInspector,
} from "../../cli/bootstrap/mcp-app-verify.mjs";
import { parseComposeHostGatewayAddress } from "../../cli/bootstrap/start.mjs";
import { generateOAuthKeyPair } from "../../cli/shared/oauth-key.mjs";
import {
  buildVerifiedRoot,
  clientAssertionIsValid,
  enforcingIntrospection,
  JWT_PATTERN,
  jwksDocument,
  noContainerInspection,
  providerMetadata,
  verifyMcpApp,
} from "../helpers/mcp-app.mjs";

test("verifyMcpApp verifies both JWKS and the inactive introspection probe", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const calls = [];
  const fetch = async (input, init) => {
    const url = input.href;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.endsWith("/auth/introspections")) {
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("client_assertion");
      if (!(await clientAssertionIsValid({ root, plan }, assertion))) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(providerMetadata(plan));
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      const body = url.startsWith(plan.tamaOrigin)
        ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
        : jwksDocument(plan.providerSigningKeyId, providerJwk);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ active: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await verifyMcpApp({
    root,
    plan,
    fetch,
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.mode, "prepared");
  assert.equal(result.providerReachable, true);
  assert.equal(result.tamaReachable, true);
  assert.equal(result.verified, true);
  assert.deepEqual(
    result.probes.map(({ name, ok }) => ({ name, ok })),
    [
      { name: "provider_metadata", ok: true },
      { name: "provider_prepared_lifecycle", ok: true },
      { name: "provider_jwks", ok: true },
      { name: "provider_container_reachability", ok: true },
      { name: "tama_jwks", ok: true },
      { name: "inactive_introspection", ok: true },
    ],
  );
  const introspectionCalls = calls.filter((call) => call.url.endsWith("/auth/introspections"));
  assert.equal(introspectionCalls.length, 2);
  const controlBody = new URLSearchParams(String(introspectionCalls[0]?.body));
  assert.equal(controlBody.get("client_id"), plan.introspectionClientId);
  // The negative control is structurally valid — a real JWT shape — but
  // signed by an unrelated key, so only signature verification rejects it.
  assert.match(String(controlBody.get("client_assertion")), JWT_PATTERN);
  assert.equal(
    await clientAssertionIsValid({ root, plan }, String(controlBody.get("client_assertion"))),
    false,
  );
  const body = new URLSearchParams(String(introspectionCalls[1]?.body));
  assert.equal(body.get("token"), "tama-kit-bootstrap-inactive-probe");
  assert.equal(body.get("client_id"), plan.introspectionClientId);
  assert.equal(
    body.get("client_assertion_type"),
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  );
  assert.equal(
    await clientAssertionIsValid({ root, plan }, String(body.get("client_assertion"))),
    true,
  );
});

test("verifyMcpApp rejects a live enabled provider during the prepared checkpoint", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const result = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            ...providerMetadata(plan),
            protected_resources: [plan.resource],
          });
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.verified, false);
  assert.equal(result.probes.find(({ name }) => name === "provider_prepared_lifecycle")?.ok, false);
});

test("verifyMcpApp rejects an introspection endpoint that skips assertion signature verification", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const result = await verifyMcpApp({
    root,
    plan,
    // A public endpoint answers the wrong-key negative control exactly like
    // the authenticated request — it parses JWTs but never verifies the
    // signature — so the probe must fail before trusting it.
    fetch: async (input) => {
      const url = input.href;
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json(providerMetadata(plan));
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json(
          url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId, providerJwk),
        );
      }
      return Response.json({ active: false });
    },
    inspectProviderListener: noContainerInspection,
  });
  const probe = result.probes.find(({ name }) => name === "inactive_introspection");
  assert.equal(probe?.ok, false);
  assert.match(probe?.reason ?? "", /signed by an unrelated key/u);
  assert.equal(result.verified, false);
});

test("verifyMcpApp reports each failed probe independently", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();

  const wrongProvider = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        const body = url.startsWith(plan.tamaOrigin)
          ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
          : jwksDocument("wrong-kid");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(wrongProvider.mode, "prepared");
  assert.equal(wrongProvider.providerReachable, false);
  assert.equal(wrongProvider.tamaReachable, true);
  assert.equal(wrongProvider.verified, false);
  assert.equal(wrongProvider.probes.find(({ name }) => name === "provider_metadata")?.ok, true);
  assert.equal(wrongProvider.probes.find(({ name }) => name === "provider_jwks")?.ok, false);

  const activeToken = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return new Response(
            JSON.stringify(
              url.startsWith(plan.tamaOrigin)
                ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
                : jwksDocument(plan.providerSigningKeyId, providerJwk),
            ),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ active: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(activeToken.verified, false);

  const unreachable = await verifyMcpApp({
    root,
    plan,
    fetch: async (input) => {
      const url = input.href;
      if (url.startsWith(plan.tamaOrigin)) {
        return new Response(JSON.stringify(jwksDocument(plan.introspectionSigningKeyId, tamaJwk)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("ECONNREFUSED");
    },
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(unreachable.mode, "prepared");
  assert.equal(unreachable.providerReachable, false);
  assert.equal(unreachable.tamaReachable, true);
  assert.equal(unreachable.verified, false);
  assert.equal(unreachable.probes.find(({ name }) => name === "provider_metadata")?.ok, false);
});

test("verifyMcpApp gates enabled metadata, route, and exact provider advertisement", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const enabledPlan = { ...plan, lifecycle: "enabled", providerLifecycle: "enabled" };
  const result = await verifyMcpApp({
    root,
    plan: enabledPlan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            ...providerMetadata(enabledPlan),
            protected_resources: [enabledPlan.resource],
          });
        }
        if (url.endsWith("/.well-known/oauth-protected-resource/mcp/app")) {
          return Response.json({
            resource: enabledPlan.resource,
            authorization_servers: [enabledPlan.providerOrigin],
          });
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(enabledPlan.tamaOrigin)
              ? jwksDocument(enabledPlan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(enabledPlan.providerSigningKeyId, providerJwk),
          );
        }
        if (url === enabledPlan.resource) {
          return Response.json({ error: "missing_token" }, { status: 401 });
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(
    result.probes.map(({ name }) => name),
    [
      "provider_metadata",
      "provider_jwks",
      "provider_container_reachability",
      "tama_jwks",
      "inactive_introspection",
      "tama_protected_resource_metadata",
      "tama_resource_route",
      "provider_resource_advertisement",
    ],
  );
});

test("verifyMcpApp rejects a JWKS whose key material does not match the persisted key", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();

  const staleProvider = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId),
          );
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(staleProvider.verified, false);
  assert.equal(staleProvider.providerReachable, false);
  assert.equal(staleProvider.tamaReachable, true);
  const staleProbe = staleProvider.probes.find(({ name }) => name === "provider_jwks");
  assert.equal(staleProbe?.ok, false);
  assert.match(staleProbe?.reason ?? "", /different key under the expected identifier/u);

  const staleTama = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(staleTama.verified, false);
  assert.equal(staleTama.providerReachable, true);
  assert.equal(staleTama.tamaReachable, false);
  const staleTamaProbe = staleTama.probes.find(({ name }) => name === "tama_jwks");
  assert.equal(staleTamaProbe?.ok, false);
  assert.match(
    staleTamaProbe?.reason ?? "",
    /different introspection key under the expected identifier/u,
  );
});

test("verifyMcpApp rejects a JWKS that exposes private members under the expected identifier", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const leaked = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          const body = url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId, providerJwk);
          body.keys[0].d = "leaked-private-exponent";
          return Response.json(body);
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(leaked.verified, false);
  assert.equal(leaked.providerReachable, false);
  const leakedProbe = leaked.probes.find(({ name }) => name === "provider_jwks");
  assert.equal(leakedProbe?.ok, false);
  assert.match(leakedProbe?.reason ?? "", /different key under the expected identifier/u);
});

test("verifyMcpApp probes a bridge-bound provider over Tama's resolved host gateway", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const fetchWith = (metadata) =>
    enforcingIntrospection(
      async (/** @type {URL} */ input, /** @type {RequestInit | undefined} */ init) => {
        const url = input.href;
        calls.push({ url, method: init?.method ?? "GET", body: init?.body });
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(metadata);
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          const body = url.startsWith(plan.tamaOrigin)
            ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
            : jwksDocument(plan.providerSigningKeyId, providerJwk);
          return Response.json(body);
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    );
  const calls = [];
  const gatewayFetch = fetchWith(providerMetadata(plan));
  const result = await verifyMcpApp({
    root,
    plan,
    fetch: gatewayFetch,
    providerFetch: gatewayFetch,
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(plan.providerOrigin, "http://host.docker.internal:4000");
  assert.equal(result.verified, true);
  assert.equal(
    calls.find((call) => call.url.endsWith("/.well-known/oauth-authorization-server"))?.url,
    "http://host.docker.internal:4000/.well-known/oauth-authorization-server",
  );
  assert.equal(
    calls.find(
      (call) =>
        call.url.endsWith("/.well-known/jwks.json") && !call.url.startsWith(plan.tamaOrigin),
    )?.url,
    "http://host.docker.internal:4000/.well-known/jwks.json",
  );
  const authenticated = calls.filter((call) => call.url.endsWith("/auth/introspections")).at(-1);
  assert.equal(authenticated?.url, "http://host.docker.internal:4000/auth/introspections");
  const assertion = new URLSearchParams(String(authenticated?.body)).get("client_assertion");
  const payload = JSON.parse(
    Buffer.from(/** @type {string} */ (assertion).split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(payload.aud, "http://host.docker.internal:4000/auth/introspections");

  const mismatched = await verifyMcpApp({
    root,
    plan,
    fetch: gatewayFetch,
    providerFetch: fetchWith({
      ...providerMetadata(plan),
      issuer: "http://127.0.0.1:4000",
    }),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.probes.find(({ name }) => name === "provider_metadata")?.ok, false);
});

test("createHttpHostMappedFetch preserves provider authority on the mapped connection", async () => {
  const http = await import("node:http");
  let received = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received = {
        host: request.headers.host,
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const mappedFetch = createHttpHostMappedFetch("127.0.0.1");
    const response = await mappedFetch(
      new URL(`http://host.docker.internal:${port}/probe?ready=1`),
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "probe-body",
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      host: `host.docker.internal:${port}`,
      method: "POST",
      path: "/probe?ready=1",
      body: "probe-body",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseComposeHostGatewayAddress reads Docker's exact container mapping", () => {
  assert.equal(
    parseComposeHostGatewayAddress(
      "127.0.0.1 localhost\n172.18.0.1 host.docker.internal # generated by Docker\n",
    ),
    "172.18.0.1",
  );
  assert.equal(parseComposeHostGatewayAddress("fd00::1 host.docker.internal\n"), "fd00::1");
  assert.equal(parseComposeHostGatewayAddress("127.0.0.1 localhost\n"), null);
});

test("verifyMcpApp requires provider reachability from the running Tama container", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const containerEndpoints = [];
  const result = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    probeProviderFromContainer: async (endpoint) => {
      containerEndpoints.push(endpoint);
      return false;
    },
    inspectProviderListener: noContainerInspection,
  });
  assert.deepEqual(containerEndpoints, [
    "http://host.docker.internal:4000/.well-known/oauth-authorization-server",
  ]);
  assert.equal(result.verified, false);
  assert.equal(
    result.probes.find(({ name }) => name === "provider_container_reachability")?.ok,
    false,
  );
});

test("verifyMcpApp fails the host-gateway topology when the provider bind is loopback-only", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const withListener = (inspection) =>
    verifyMcpApp({
      root,
      plan,
      fetch: enforcingIntrospection(
        async (input) => {
          const url = input.href;
          if (url.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json(providerMetadata(plan));
          }
          if (url.endsWith("/.well-known/jwks.json")) {
            return Response.json(
              url.startsWith(plan.tamaOrigin)
                ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
                : jwksDocument(plan.providerSigningKeyId, providerJwk),
            );
          }
          return Response.json({ active: false });
        },
        root,
        plan,
      ),
      inspectProviderListener: async () => inspection,
    });

  const loopbackOnly = await withListener("loopback-only");
  assert.equal(loopbackOnly.verified, false);
  const probe = loopbackOnly.probes.find(({ name }) => name === "provider_host_listener");
  assert.equal(probe?.ok, false);
  assert.match(probe?.reason ?? "", /loopback/u);

  const wide = await withListener("wide");
  assert.equal(wide.verified, true);
  assert.equal(wide.probes.find(({ name }) => name === "provider_host_listener")?.ok, true);

  const unknown = await withListener("unknown");
  assert.equal(unknown.verified, true);
  assert.equal(
    unknown.probes.find(({ name }) => name === "provider_host_listener"),
    undefined,
  );
});

test("verifyMcpApp inspects the effective default port for a portless host-gateway origin", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const portlessPlan = { ...plan, providerOrigin: "http://host.docker.internal" };
  /** @type {number[]} */
  const inspectedPorts = [];
  const result = await verifyMcpApp({
    root,
    plan: portlessPlan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(portlessPlan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(portlessPlan.tamaOrigin)
              ? jwksDocument(portlessPlan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(portlessPlan.providerSigningKeyId, providerJwk),
          );
        }
        return Response.json({ active: false });
      },
      root,
      portlessPlan,
    ),
    inspectProviderListener: async (port) => {
      inspectedPorts.push(port);
      return "wide";
    },
  });
  assert.equal(result.verified, true);
  assert.deepEqual(inspectedPorts, [80]);
});

test("defaultProviderListenerInspector classifies host listening sockets", async () => {
  if (process.platform !== "linux") {
    return;
  }
  const net = await import("node:net");
  const listen = (host) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, host, () => resolve(server));
    });
  const close = (server) => new Promise((resolve) => server.close(resolve));
  const portOf = (server) => /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  const loopbackServer = await listen("127.0.0.1");
  try {
    assert.equal(await defaultProviderListenerInspector(portOf(loopbackServer)), "loopback-only");

    // A mapped loopback bind is still unreachable from the Docker bridge.
    const mappedServer = await listen("::ffff:127.0.0.1");
    try {
      assert.equal(await defaultProviderListenerInspector(portOf(mappedServer)), "loopback-only");
    } finally {
      await close(mappedServer);
    }

    const wideServer = await listen("0.0.0.0");
    const widePort = portOf(wideServer);
    try {
      assert.equal(await defaultProviderListenerInspector(widePort), "wide");
    } finally {
      await close(wideServer);
    }
    assert.equal(await defaultProviderListenerInspector(widePort), "unknown");
  } finally {
    await close(loopbackServer);
  }
});

test("classifyListenerAddress classifies IPv4-mapped IPv6 listeners", () => {
  // Native v6 forms.
  assert.equal(classifyListenerAddress("00000000000000000000000000000000", "v6"), "wide");
  assert.equal(classifyListenerAddress("00000000000000000000000001000000", "v6"), "loopback");
  assert.equal(classifyListenerAddress("00000000000000000000000002000000", "v6"), "specific");
  // IPv4-mapped forms, as the kernel prints them: the marker group
  // 0000ffff appears as FFFF0000 and the IPv4 group little-endian.
  assert.equal(classifyListenerAddress("0000000000000000FFFF00000100007F", "v6"), "loopback");
  assert.equal(classifyListenerAddress("0000000000000000FFFF000000000000", "v6"), "wide");
  assert.equal(classifyListenerAddress("0000000000000000FFFF000008080808", "v6"), "specific");
  // Plain v4 forms.
  assert.equal(classifyListenerAddress("00000000", "v4"), "wide");
  assert.equal(classifyListenerAddress("0100007F", "v4"), "loopback");
  assert.equal(classifyListenerAddress("020012AC", "v4"), "specific");
});

test("verifyMcpApp requires the protected route to reject anonymous requests", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const enabledPlan = { ...plan, lifecycle: "enabled", providerLifecycle: "prepared" };
  const withRouteStatus = (status) =>
    verifyMcpApp({
      root,
      plan: enabledPlan,
      fetch: enforcingIntrospection(
        async (input) => {
          const url = input.href;
          if (url.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json(providerMetadata(plan));
          }
          if (url.endsWith("/.well-known/oauth-protected-resource/mcp/app")) {
            return Response.json({
              resource: plan.resource,
              authorization_servers: [plan.providerOrigin],
            });
          }
          if (url.endsWith("/.well-known/jwks.json")) {
            return Response.json(
              url.startsWith(plan.tamaOrigin)
                ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
                : jwksDocument(plan.providerSigningKeyId, providerJwk),
            );
          }
          if (url === plan.resource) {
            return new Response(null, { status });
          }
          return Response.json({ active: false });
        },
        root,
        plan,
      ),
      inspectProviderListener: noContainerInspection,
    });
  for (const status of [200, 400, 404, 503]) {
    const result = await withRouteStatus(status);
    const routeProbe = result.probes.find(({ name }) => name === "tama_resource_route");
    assert.equal(routeProbe?.ok, false, `HTTP ${status} must not count as a protected route`);
    assert.match(routeProbe?.reason ?? "", /401 or 403/u);
  }
  for (const status of [401, 403]) {
    const result = await withRouteStatus(status);
    assert.equal(result.probes.find(({ name }) => name === "tama_resource_route")?.ok, true);
  }
});

test("verifyMcpApp does not follow redirects from the protected route", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const enabledPlan = { ...plan, lifecycle: "enabled", providerLifecycle: "prepared" };
  let redirectMode;
  const result = await verifyMcpApp({
    root,
    plan: enabledPlan,
    fetch: enforcingIntrospection(
      async (input, init) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/oauth-protected-resource/mcp/app")) {
          return Response.json({
            resource: plan.resource,
            authorization_servers: [plan.providerOrigin],
          });
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : jwksDocument(plan.providerSigningKeyId, providerJwk),
          );
        }
        if (url === plan.resource) {
          redirectMode = init?.redirect;
          return new Response(null, {
            status: 302,
            headers: { location: `${plan.tamaOrigin}/login` },
          });
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(redirectMode, "manual");
  assert.equal(result.verified, false);
  const routeProbe = result.probes.find(({ name }) => name === "tama_resource_route");
  assert.equal(routeProbe?.ok, false);
  assert.match(routeProbe?.reason ?? "", /HTTP 302/u);
});

test("verifyMcpApp requires an RSA signing member for the expected identifier", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const providerKey = JSON.parse(providerJwk);
  const variants = [
    { kid: plan.providerSigningKeyId, n: providerKey.n, e: providerKey.e },
    { kid: plan.providerSigningKeyId, kty: "EC", n: providerKey.n, e: providerKey.e },
    {
      kid: plan.providerSigningKeyId,
      kty: "RSA",
      alg: "HS256",
      n: providerKey.n,
      e: providerKey.e,
    },
    { kid: plan.providerSigningKeyId, kty: "RSA", use: "enc", n: providerKey.n, e: providerKey.e },
    {
      kid: plan.providerSigningKeyId,
      kty: "RSA",
      key_ops: ["encrypt"],
      n: providerKey.n,
      e: providerKey.e,
    },
    {
      kid: plan.providerSigningKeyId,
      kty: "RSA",
      key_ops: ["verify", 12],
      n: providerKey.n,
      e: providerKey.e,
    },
  ];
  for (const member of variants) {
    const result = await verifyMcpApp({
      root,
      plan,
      fetch: enforcingIntrospection(
        async (input) => {
          const url = input.href;
          if (url.endsWith("/.well-known/oauth-authorization-server")) {
            return Response.json(providerMetadata(plan));
          }
          if (url.endsWith("/.well-known/jwks.json")) {
            const body = url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : { keys: [member] };
            return Response.json(body);
          }
          return Response.json({ active: false });
        },
        root,
        plan,
      ),
      inspectProviderListener: noContainerInspection,
    });
    assert.equal(result.providerReachable, false, JSON.stringify(member));
    assert.equal(result.probes.find(({ name }) => name === "provider_jwks")?.ok, false);
  }
});

test("verifyMcpApp rejects duplicate live keys with the current identifier", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const currentProviderKey = jwksDocument(plan.providerSigningKeyId, providerJwk).keys[0];
  const conflicting = JSON.parse(generateOAuthKeyPair("conflicting").publicJwk);
  conflicting.kid = plan.providerSigningKeyId;
  const result = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(
      async (input) => {
        const url = input.href;
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json(providerMetadata(plan));
        }
        if (url.endsWith("/.well-known/jwks.json")) {
          return Response.json(
            url.startsWith(plan.tamaOrigin)
              ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
              : { keys: [currentProviderKey, conflicting] },
          );
        }
        return Response.json({ active: false });
      },
      root,
      plan,
    ),
    inspectProviderListener: noContainerInspection,
  });
  assert.equal(result.providerReachable, false);
  assert.equal(result.probes.find(({ name }) => name === "provider_jwks")?.ok, false);
});

test("verifyMcpApp rejects redirects from both introspection requests", async () => {
  const { root, plan, providerJwk, tamaJwk } = await buildVerifiedRoot();
  const redirectingFetch = (calls) => async (input, init) => {
    const url = input.href;
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(providerMetadata(plan));
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      return Response.json(
        url.startsWith(plan.tamaOrigin)
          ? jwksDocument(plan.introspectionSigningKeyId, tamaJwk)
          : jwksDocument(plan.providerSigningKeyId, providerJwk),
      );
    }
    if (url.endsWith("/auth/introspections")) {
      calls.push(init?.redirect);
      return new Response(null, {
        status: 307,
        headers: { location: "http://untrusted.example.test/introspections" },
      });
    }
    return Response.json({ active: false });
  };

  const controlCalls = [];
  const redirectedControl = await verifyMcpApp({
    root,
    plan,
    fetch: redirectingFetch(controlCalls),
    inspectProviderListener: noContainerInspection,
  });
  assert.deepEqual(controlCalls, ["manual"]);
  assert.match(
    redirectedControl.probes.find(({ name }) => name === "inactive_introspection")?.reason ?? "",
    /redirected the negative control \(HTTP 307\)/u,
  );

  const authenticatedCalls = [];
  const redirectedAuthenticated = await verifyMcpApp({
    root,
    plan,
    fetch: enforcingIntrospection(redirectingFetch(authenticatedCalls), root, plan),
    inspectProviderListener: noContainerInspection,
  });
  assert.deepEqual(authenticatedCalls, ["manual"]);
  assert.match(
    redirectedAuthenticated.probes.find(({ name }) => name === "inactive_introspection")?.reason ??
      "",
    /redirected the authenticated request \(HTTP 307\)/u,
  );
});
