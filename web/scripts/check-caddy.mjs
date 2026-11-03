// Regression check for the Web origin routing contract, run against a throwaway
// pinned Caddy container and a temporary static tree. Usage:
//   node ./scripts/check-caddy.mjs [--caddyfile <path>]
// Requires Docker; uses no project dependency outside Node 24.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caddyfileFlag = process.argv.indexOf("--caddyfile");
if (caddyfileFlag !== -1) {
  const value = process.argv[caddyfileFlag + 1];
  if (!value || value.startsWith("--")) {
    console.error("Usage: node ./scripts/check-caddy.mjs [--caddyfile <path>]");
    process.exit(2);
  }
}
const caddyfile = path.resolve(
  caddyfileFlag === -1 ? path.join(projectRoot, "Caddyfile") : process.argv[caddyfileFlag + 1],
);

const CADDY_IMAGE =
  "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const IMMUTABLE = "public, max-age=31536000, immutable";
const SENTINEL = "caddy-spa-fixture-sentinel";
const DOCKER_TIMEOUT_MS = 60_000;
const DOCKER_PULL_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 15_000;
const containerName = `buzz-web-caddy-check-${process.pid}-${Date.now().toString(36)}`;
const validationName = `${containerName}-validate`;
const ownedContainers = new Set([validationName, containerName]);
let fixtureRoot;
let cleanedUp = false;

function docker(args, options = {}) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
    ...options,
  });
}

function cleanupOwnedResources() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const name of ownedContainers) {
    docker(["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
  }
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanupOwnedResources();
    process.exit(code);
  });
}

function responseDetail(response) {
  const header = (name) => response.headers[name] ?? "<none>";
  return [
    `status=${response.status}`,
    `content-type=${header("content-type")}`,
    `cache-control=${header("cache-control")}`,
    `location=${header("location")}`,
    `body=${JSON.stringify(response.body.toString("utf8").slice(0, 120))}`,
  ].join(" ");
}

function expectResponse(response, expected) {
  const detail = responseDetail(response);
  if (expected.status !== undefined && response.status !== expected.status) {
    throw new Error(`status: expected ${expected.status}, got ${response.status} (${detail})`);
  }
  const contentType = response.headers["content-type"] ?? "";
  if (expected.contentType && contentType !== expected.contentType) {
    throw new Error(
      `content-type: expected ${expected.contentType}, got ${contentType || "<none>"} (${detail})`,
    );
  }
  if (expected.contentTypeIncludes && !contentType.includes(expected.contentTypeIncludes)) {
    throw new Error(
      `content-type: expected to include ${expected.contentTypeIncludes}, got ${contentType || "<none>"} (${detail})`,
    );
  }
  if (expected.cacheControl !== undefined) {
    const actual = response.headers["cache-control"] ?? "";
    if (actual !== expected.cacheControl) {
      throw new Error(
        `cache-control: expected ${JSON.stringify(expected.cacheControl)}, got ${JSON.stringify(actual)} (${detail})`,
      );
    }
  }
  if (expected.notImmutable) {
    const actual = response.headers["cache-control"] ?? "";
    if (actual.includes("immutable") || actual.includes("31536000")) {
      throw new Error(`cache-control: expected no immutable caching, got ${actual} (${detail})`);
    }
  }
  if (expected.notSpaHtml) {
    const body = response.body.toString("utf8");
    if (contentType.includes("text/html") || body.includes(SENTINEL)) {
      throw new Error(`body: expected no SPA HTML fallback (${detail})`);
    }
  }
  if (expected.bodyIncludes && !response.body.toString("utf8").includes(expected.bodyIncludes)) {
    throw new Error(
      `body: expected to include ${JSON.stringify(expected.bodyIncludes)} (${detail})`,
    );
  }
}

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
        res.on("close", () => {
          if (!res.complete) reject(new Error(`response aborted: ${requestPath}`));
        });
      },
    );
    req.on("error", (error) =>
      reject(
        error.name === "AbortError"
          ? new Error(`request exceeded ${REQUEST_TIMEOUT_MS}ms: ${requestPath}`)
          : error,
      ),
    );
    req.end();
  });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function makeFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "buzz-web-caddy-"));
  fixtureRoot = fixture;
  const assets = path.join(fixture, "app", "assets");
  await mkdir(path.join(assets, "nested"), { recursive: true });
  const filler = "fixture content ".repeat(120);
  await writeFile(
    path.join(fixture, "app", "index.html"),
    `<!doctype html><html lang="en"><head><title>Fixture</title><meta name="${SENTINEL}"></head><body><main>${filler}</main></body></html>`,
  );
  await writeFile(path.join(assets, "index-deadbeef.js"), "console.log('entry');\n");
  await writeFile(path.join(assets, "nested", "chunk-cafebabe.js"), "console.log('chunk');\n");
  await writeFile(
    path.join(fixture, "app", "config.json"),
    '{"relayUrl":"wss://relay.example.com"}\n',
  );
  return fixture;
}

async function main() {
  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  if (version.error || !version.stdout?.trim()) {
    console.error(
      version.error
        ? `Caddy check requires a working Docker daemon: ${version.error.message}`
        : "Caddy check requires a working Docker daemon.",
    );
    process.exit(1);
  }
  const inspection = docker(["image", "inspect", CADDY_IMAGE], { stdio: "ignore" });
  if (inspection.error) {
    console.error(`Docker image inspection failed: ${inspection.error.message}`);
    process.exit(1);
  }
  if (inspection.status !== 0) {
    console.log(`Pulling ${CADDY_IMAGE}`);
    const pull = docker(["pull", CADDY_IMAGE], {
      stdio: "inherit",
      timeout: DOCKER_PULL_TIMEOUT_MS,
    });
    if (pull.error || pull.status !== 0) {
      console.error(
        pull.error
          ? `Docker image pull failed: ${pull.error.message}`
          : "Docker image pull failed.",
      );
      process.exit(pull.status ?? 1);
    }
  }

  const fixture = await makeFixture();
  const volumes = ["-v", `${fixture}:/srv:ro`, "-v", `${caddyfile}:/etc/caddy/Caddyfile:ro`];

  try {
    console.log(`Caddyfile: ${caddyfile}`);
    const validation = docker([
      "run",
      "--name",
      validationName,
      "--label",
      "org.buzz-web.check=caddy-regression",
      ...volumes,
      CADDY_IMAGE,
      "caddy",
      "validate",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ]);
    docker(["rm", "-f", validationName], { stdio: "ignore" });
    if (validation.error || validation.status !== 0) {
      console.error(validation.stdout ?? "");
      console.error(validation.stderr ?? "");
      throw new Error(
        validation.error
          ? `Caddyfile validation timed out or failed to run: ${validation.error.message}`
          : "Caddyfile validation failed",
      );
    }
    console.log("ok - caddy validate");

    const started = docker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--label",
      "org.buzz-web.check=caddy-regression",
      "-p",
      "127.0.0.1::8080",
      ...volumes,
      CADDY_IMAGE,
    ]);
    if (started.error || started.status !== 0) {
      console.error(started.stderr ?? started.stdout ?? "");
      throw new Error(
        started.error
          ? `could not start Caddy container: ${started.error.message}`
          : "could not start Caddy container",
      );
    }

    let port = 0;
    for (let attempt = 0; attempt < 100 && !port; attempt += 1) {
      const mapping = docker(["port", containerName, "8080/tcp"]).stdout?.trim() ?? "";
      const match = mapping.match(/127\.0\.0\.1:(\d+)/);
      if (match) port = Number(match[1]);
      else await sleep(100);
    }
    if (!port) {
      console.error(docker(["logs", containerName]).stdout ?? "");
      throw new Error("could not resolve the container's loopback port");
    }

    let ready = false;
    const readyDeadline = Date.now() + READY_TIMEOUT_MS;
    while (!ready && Date.now() < readyDeadline) {
      try {
        ready = (await request(port, "/app/healthz")).status === 200;
      } catch {
        // Caddy is still starting.
      }
      if (!ready) await sleep(100);
    }
    if (!ready) {
      console.error(docker(["logs", containerName]).stdout ?? "");
      throw new Error(`Caddy did not become ready within ${READY_TIMEOUT_MS}ms`);
    }

    const failures = [];
    const check = async (name, verify) => {
      try {
        await verify();
        console.log(`ok - ${name}`);
      } catch (error) {
        failures.push(name);
        console.error(`not ok - ${name}: ${error.message}`);
      }
    };

    await check("GET /app redirects to /app/", async () => {
      expectResponse(await request(port, "/app"), { status: 308 });
      const response = await request(port, "/app");
      if (response.headers.location !== "/app/") {
        throw new Error(
          `location: expected /app/, got ${response.headers.location} (${responseDetail(response)})`,
        );
      }
    });

    await check("GET /app/healthz returns 200 ok", async () => {
      expectResponse(await request(port, "/app/healthz"), { status: 200, bodyIncludes: "ok" });
    });

    await check("GET /app/ serves the SPA shell", async () => {
      const response = await request(port, "/app/");
      expectResponse(response, {
        status: 200,
        contentTypeIncludes: "text/html",
        bodyIncludes: SENTINEL,
      });
    });

    await check("GET /app/non-asset path falls back to the SPA shell", async () => {
      const response = await request(port, "/app/settings/devices");
      expectResponse(response, {
        status: 200,
        contentTypeIncludes: "text/html",
        bodyIncludes: SENTINEL,
      });
    });

    await check("GET /app/config.json keeps no-store", async () => {
      const response = await request(port, "/app/config.json");
      expectResponse(response, {
        status: 200,
        contentTypeIncludes: "application/json",
        cacheControl: "no-store, no-cache, must-revalidate",
      });
    });

    await check("existing /app/assets entry is immutable", async () => {
      const response = await request(port, "/app/assets/index-deadbeef.js");
      expectResponse(response, {
        status: 200,
        contentTypeIncludes: "javascript",
        cacheControl: IMMUTABLE,
        bodyIncludes: "entry",
      });
    });

    await check("existing nested asset is immutable", async () => {
      const response = await request(port, "/app/assets/nested/chunk-cafebabe.js");
      expectResponse(response, {
        status: 200,
        contentTypeIncludes: "javascript",
        cacheControl: IMMUTABLE,
        bodyIncludes: "chunk",
      });
    });

    await check("missing /app/assets/*.js returns 404 without immutable or SPA HTML", async () => {
      const response = await request(port, "/app/assets/index-NkGiGQV1.js");
      expectResponse(response, {
        status: 404,
        notImmutable: true,
        notSpaHtml: true,
      });
    });

    await check("missing /app/assets/*.css returns 404 without immutable or SPA HTML", async () => {
      const response = await request(port, "/app/assets/index-missing12.css");
      expectResponse(response, { status: 404, notImmutable: true, notSpaHtml: true });
    });

    await check("missing nested /app/assets/nested/*.js returns 404", async () => {
      const response = await request(port, "/app/assets/nested/chunk-missing.js");
      expectResponse(response, { status: 404, notImmutable: true, notSpaHtml: true });
    });

    await check("paths outside /app return 404", async () => {
      expectResponse(await request(port, "/"), { status: 404, notSpaHtml: true });
      expectResponse(await request(port, "/app-other"), { status: 404, notSpaHtml: true });
    });

    await check("security headers are present on HTML and assets", async () => {
      const responses = [
        await request(port, "/app/"),
        await request(port, "/app/assets/index-deadbeef.js"),
        await request(port, "/app/assets/index-NkGiGQV1.js"),
      ];
      const required = {
        "content-security-policy": "default-src 'self'",
        "permissions-policy": "camera=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      };
      for (const response of responses) {
        for (const [name, prefix] of Object.entries(required)) {
          const value = response.headers[name] ?? "";
          if (!value.startsWith(prefix)) {
            throw new Error(
              `${name}: expected ${prefix}, got ${value || `<none> (${responseDetail(response)})`}`,
            );
          }
        }
        if (response.headers.server !== undefined) {
          throw new Error(`server header must be removed (${responseDetail(response)})`);
        }
      }
    });

    await check("HTML is still compressed", async () => {
      const response = await request(port, "/app/", { "accept-encoding": "gzip" });
      if (response.headers["content-encoding"] !== "gzip") {
        throw new Error(`content-encoding: expected gzip (${responseDetail(response)})`);
      }
    });

    if (failures.length) {
      console.error(`\n${failures.length} Caddy contract check(s) failed.`);
      process.exitCode = 1;
    } else {
      console.log("\nAll Caddy contract checks passed.");
    }
  } finally {
    cleanupOwnedResources();
  }
}

await main();
