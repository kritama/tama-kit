import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLocalDomain,
  renderLocalCaDockerfile,
  renderLocalHttpsCaddyfile,
  resolveLocalHttpsNames,
  resolveLocalHttpsTopology,
  usesLocalHttpsTopology,
} from "../../cli/bootstrap/local-https.mjs";

test("local HTTPS topology derives stable public identities and private upstreams", () => {
  const topology = resolveLocalHttpsTopology({ providerPort: 4100 });

  assert.equal(topology.providerOrigin, "https://app.localhost");
  assert.equal(topology.tamaOrigin, "https://tama.app.localhost");
  assert.equal(topology.resource, "https://tama.app.localhost/mcp/app");
  assert.equal(topology.introspectionClientId, "https://tama.app.localhost/mcp/app/introspection");
  assert.equal(topology.providerUpstream, "http://host.docker.internal:4100");
  assert.equal(topology.tamaUpstream, "http://tama:4000");
  assert.deepEqual(topology.certificateNames, ["app.localhost", "tama.app.localhost"]);
  assert.deepEqual(topology.allowedOrigins, ["https://app.localhost"]);
});

test("local domain validation rejects multicast DNS names and IP literals", () => {
  assert.equal(normalizeLocalDomain("Example.Localhost."), "example.localhost");
  assert.throws(() => normalizeLocalDomain("service.local"), /must not use \.local/u);
  assert.throws(() => normalizeLocalDomain("127.0.0.1"), /invalid --local-domain/u);
  assert.throws(() => normalizeLocalDomain("bad..localhost"), /invalid --local-domain/u);
});

test("fresh MCP App runs use HTTPS while explicit origins retain the legacy path", () => {
  assert.equal(usesLocalHttpsTopology({ requested: true }), true);
  assert.equal(
    usesLocalHttpsTopology({ requested: true, providerOrigin: "http://host.docker.internal:4000" }),
    false,
  );
  assert.equal(usesLocalHttpsTopology({ requested: true, migrateLocalHttps: true }), true);
});

test("local HTTPS names must resolve only to loopback addresses", async () => {
  const topology = resolveLocalHttpsTopology();
  const lookup = async (hostname) =>
    hostname === "app.localhost"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "::1", family: 6 }];
  const addresses = await resolveLocalHttpsNames(topology, lookup);

  assert.deepEqual(addresses, {
    "app.localhost": ["127.0.0.1"],
    "tama.app.localhost": ["::1"],
  });
  await assert.rejects(
    resolveLocalHttpsNames(topology, async () => [{ address: "192.0.2.10", family: 4 }]),
    /resolves outside loopback/u,
  );
});

test("generated proxy and trust-layer templates keep public and private routing separate", () => {
  const topology = resolveLocalHttpsTopology();
  const caddyfile = renderLocalHttpsCaddyfile(topology);
  const dockerfile = renderLocalCaDockerfile("ghcr.io/upmaru/tama:0.13.1-server");

  assert.match(caddyfile, /app\.localhost \{/u);
  assert.match(caddyfile, /tama\.app\.localhost \{/u);
  assert.match(caddyfile, /reverse_proxy http:\/\/host\.docker\.internal:4000/u);
  assert.match(caddyfile, /reverse_proxy http:\/\/tama:4000/u);
  assert.match(caddyfile, /header_up Host \{host\}/u);
  assert.doesNotMatch(caddyfile, /:80/u);
  assert.match(dockerfile, /COPY tls\/rootCA\.pem/u);
  assert.doesNotMatch(dockerfile, /local-key|rootCA\.key|private/u);
});
