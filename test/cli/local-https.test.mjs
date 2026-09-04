import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  certificateHasNames,
  ensureMkcertLocalCa,
  localHttpsPaths,
  normalizeLocalDomain,
  planLocalHttpsCertificates,
  renderLocalCaDockerfile,
  renderLocalHttpsCaddyfile,
  resolveLocalHttpsNames,
  resolveLocalHttpsTopology,
  usesLocalHttpsTopology,
} from "../../cli/bootstrap/local-https.mjs";
import { createLocalHttpsFetch } from "../../cli/bootstrap/mcp-app-verify.mjs";

function certificateFixture() {
  const root = mkdtempSync(join(tmpdir(), "tama-kit-local-https-test-"));
  const paths = localHttpsPaths(root);
  mkdirSync(paths.directory, { recursive: true });
  const rootKey = join(root, "root-key.pem");
  const request = join(root, "leaf.csr");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Tama Kit Test Root",
      "-keyout",
      rootKey,
      "-out",
      paths.rootCertificate,
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=app.localhost",
      "-addext",
      "subjectAltName=DNS:app.localhost,DNS:tama.app.localhost",
      "-keyout",
      paths.privateKey,
      "-out",
      request,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      paths.rootCertificate,
      "-CAkey",
      rootKey,
      "-CAcreateserial",
      "-copy_extensions",
      "copy",
      "-out",
      paths.certificate,
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  chmodSync(paths.privateKey, 0o600);
  return { root, paths, rootKey };
}

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

test("local HTTPS topology rejects a provider port reserved by Caddy", () => {
  assert.throws(
    () => resolveLocalHttpsTopology({ providerPort: 443 }),
    /provider-port must not use port 443/u,
  );
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
  const legacy = { providerOrigin: "http://host.docker.internal:4000" };
  assert.equal(usesLocalHttpsTopology({ requested: true, providerPort: 4100 }, legacy), false);
  assert.equal(
    usesLocalHttpsTopology({ requested: true, localDomain: "app.localhost" }, legacy),
    false,
  );
  assert.equal(usesLocalHttpsTopology({ requested: true, migrateLocalHttps: true }, legacy), true);
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
  const dockerfile = renderLocalCaDockerfile("ghcr.io/upmaru/tama:0.13.2-server");

  assert.match(caddyfile, /app\.localhost \{/u);
  assert.match(caddyfile, /tama\.app\.localhost \{/u);
  assert.match(caddyfile, /reverse_proxy http:\/\/host\.docker\.internal:4000/u);
  assert.match(caddyfile, /reverse_proxy http:\/\/tama:4000/u);
  assert.match(caddyfile, /header_up Host \{host\}/u);
  assert.doesNotMatch(caddyfile, /:80/u);
  assert.match(dockerfile, /COPY tls\/rootCA\.pem/u);
  assert.match(dockerfile, /USER tama\s*$/u);
  assert.doesNotMatch(dockerfile, /local-key|rootCA\.key|private/u);
});

test("mkcert CA installation runs only when explicitly authorized", () => {
  const existing = { path: "mkcert", caRoot: "/ca", rootCertificate: "/ca/rootCA.pem" };
  let installs = 0;
  assert.equal(
    ensureMkcertLocalCa(false, {
      discover: () => existing,
      install: () => {
        installs += 1;
      },
    }),
    existing,
  );
  assert.equal(installs, 0);

  let discoveries = 0;
  assert.equal(
    ensureMkcertLocalCa(true, {
      discover: () => {
        discoveries += 1;
        return existing;
      },
      install: () => {
        installs += 1;
      },
    }),
    existing,
  );
  assert.equal(installs, 1);
  assert.equal(discoveries, 1);
});

test("certificate reuse validates file type, key permissions, key pairing, and issuer", () => {
  const fixture = certificateFixture();
  const topology = resolveLocalHttpsTopology();
  const options = {
    discoverLocalCa: () => ({
      path: "mkcert",
      caRoot: fixture.root,
      rootCertificate: fixture.paths.rootCertificate,
    }),
  };
  try {
    assert.deepEqual(planLocalHttpsCertificates(fixture.root, topology, options).operations, []);

    let installs = 0;
    assert.deepEqual(
      planLocalHttpsCertificates(fixture.root, topology, {
        ...options,
        installLocalCa: true,
        ensureLocalCa: (authorized) => {
          assert.equal(authorized, true);
          installs += 1;
          return options.discoverLocalCa();
        },
      }).operations,
      [],
    );
    assert.equal(installs, 1);

    chmodSync(fixture.paths.privateKey, 0o644);
    assert.throws(
      () => planLocalHttpsCertificates(fixture.root, topology, options),
      /private key must have mode 0600/u,
    );
    chmodSync(fixture.paths.privateKey, 0o600);

    unlinkSync(fixture.paths.privateKey);
    symlinkSync(fixture.rootKey, fixture.paths.privateKey);
    assert.throws(
      () => planLocalHttpsCertificates(fixture.root, topology, options),
      /must be a regular file/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("certificate SAN validation uses Node's X509 parser", () => {
  const fixture = certificateFixture();
  try {
    assert.equal(
      certificateHasNames(fixture.paths.certificate, ["app.localhost", "tama.app.localhost"]),
      true,
    );
    assert.equal(certificateHasNames(fixture.paths.certificate, ["missing.localhost"]), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("local HTTPS fetch trusts only the generated CA and keeps hostname verification", async () => {
  const fixture = certificateFixture();
  const server = createServer(
    {
      cert: readFileSync(fixture.paths.certificate),
      key: readFileSync(fixture.paths.privateKey),
    },
    (_request, response) => response.end("ok"),
  );
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const trustedFetch = createLocalHttpsFetch(readFileSync(fixture.paths.rootCertificate), {
      connectHost: "127.0.0.1",
    });
    const response = await trustedFetch(new URL(`https://app.localhost:${address.port}/`));
    assert.equal(await response.text(), "ok");
    await assert.rejects(
      trustedFetch(new URL(`https://localhost:${address.port}/`)),
      /hostname|certificate|altname/i,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
