/**
 * Synthetic smart-HTTP Git server for browser tests.
 *
 * The browser runs the real isomorphic-git clone/fetch/tree/blob path; this
 * module only answers Relay-shaped transport requests using the local git CLI.
 * No network, no Relay, no credentials.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const README_MARKER_A = "CACHE_ISOLATION_MARKER_A";
export const README_MARKER_B = "CACHE_ISOLATION_MARKER_B";
export const FILE_MARKER_A = "CACHE_ISOLATION_FILE_MARKER_A";
export const FILE_MARKER_B = "CACHE_ISOLATION_FILE_MARKER_B";
export const HTML_MARKER_A = "CACHE_ISOLATION_HTML_MARKER_A";
export const BINARY_BYTES = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 255]);

const FIXED_DATE = "2000-01-01T00:00:00Z";

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Cache Fixture",
    GIT_AUTHOR_EMAIL: "fixture@buzz.example.com",
    GIT_COMMITTER_NAME: "Cache Fixture",
    GIT_COMMITTER_EMAIL: "fixture@buzz.example.com",
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
    ...extra,
  };
}

type GitResult = { stdout: Buffer; stderr: string; code: number };

function runGit(
  args: string[],
  options: { cwd?: string; stdin?: Buffer; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: gitEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    // Commands that never read stdin can exit before the end() write flushes.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      }),
    );
    child.stdin.end(options.stdin ?? Buffer.alloc(0));
  });
}

async function expectGit(args: string[], cwd?: string): Promise<Buffer> {
  const result = await runGit(args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout;
}

export interface FixtureRepo {
  /** Bare repository served over the synthetic smart-HTTP endpoint. */
  repoDir: string;
  /** Working checkout used to add later commits. */
  workDir: string;
  /** Temp root; removed by `removeFixtureRepo`. */
  root: string;
  head: string;
}

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await mkdtemp(path.join(tmpdir(), "buzz-git-fixture-"));
  const workDir = path.join(root, "work");
  const repoDir = path.join(root, "origin.git");
  await expectGit(["init", "-b", "main", workDir]);
  await writeFile(
    path.join(workDir, "README.md"),
    `# Cache isolation fixture\n\n${README_MARKER_A}\n`,
  );
  await mkdir(path.join(workDir, "src"), { recursive: true });
  await writeFile(path.join(workDir, "src/marker.txt"), `${FILE_MARKER_A}\n`);
  await writeFile(
    path.join(workDir, "preview.html"),
    `<!doctype html><html><body><h1>${HTML_MARKER_A}</h1></body></html>\n`,
  );
  await writeFile(path.join(workDir, "asset.bin"), BINARY_BYTES);
  await expectGit(["add", "README.md", "src/marker.txt", "preview.html", "asset.bin"], workDir);
  await expectGit(["commit", "-m", "initial fixture commit"], workDir);
  const head = (await expectGit(["rev-parse", "HEAD"], workDir)).toString("utf8").trim();
  await expectGit(["clone", "--bare", workDir, repoDir]);
  return { repoDir, workDir, root, head };
}

/**
 * Advance the served branch so a later clone provably reads newly-served bytes
 * instead of another identity's older cache.
 */
export async function advanceFixtureRepo(fixture: FixtureRepo): Promise<string> {
  await writeFile(
    path.join(fixture.workDir, "README.md"),
    `# Cache isolation fixture\n\n${README_MARKER_B}\n`,
  );
  await writeFile(path.join(fixture.workDir, "src/marker.txt"), `${FILE_MARKER_B}\n`);
  await expectGit(["add", "README.md", "src/marker.txt"], fixture.workDir);
  await expectGit(["commit", "-m", "second fixture commit"], fixture.workDir);
  const head = (await expectGit(["rev-parse", "HEAD"], fixture.workDir)).toString("utf8").trim();
  await expectGit(["push", "--force", fixture.repoDir, "main"], fixture.workDir);
  return head;
}

export async function removeFixtureRepo(fixture: FixtureRepo): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Answer one smart-HTTP Git request. `repoDir` is the bare repository; the
 * upload-pack commands run with the request body on stdin.
 */
export async function answerGitRequest(
  repoDir: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<GitResponse> {
  const parsed = new URL(url);
  const protocol = headerValue(headers, "git-protocol") ? "version=2" : "";
  const env = protocol ? { GIT_PROTOCOL: protocol } : {};

  if (method === "GET" && parsed.pathname.endsWith("/info/refs")) {
    if (parsed.searchParams.get("service") !== "git-upload-pack") {
      return { status: 403, headers: {}, body: Buffer.from("unsupported service") };
    }
    const result = await runGit(["upload-pack", "--stateless-rpc", "--advertise-refs", repoDir], {
      env,
    });
    if (result.code !== 0) throw new Error(`upload-pack advertise failed: ${result.stderr}`);
    const prefix = Buffer.from("001e# service=git-upload-pack\n0000");
    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-upload-pack-advertisement",
        "Cache-Control": "no-cache",
      },
      body: Buffer.concat([prefix, result.stdout]),
    };
  }

  if (method === "POST" && parsed.pathname.endsWith("/git-upload-pack")) {
    const result = await runGit(["upload-pack", "--stateless-rpc", repoDir], {
      stdin: body,
      env,
    });
    if (result.code !== 0) throw new Error(`upload-pack failed: ${result.stderr}`);
    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
      body: result.stdout,
    };
  }

  return { status: 404, headers: {}, body: Buffer.from("not found") };
}

/** Decode the NIP-98 signer pubkey from an `Authorization: Nostr <base64>` header. */
export function authPubkey(headers: Record<string, string>): string | null {
  const raw = headerValue(headers, "authorization");
  if (!raw?.startsWith("Nostr ")) return null;
  try {
    const event = JSON.parse(
      Buffer.from(raw.slice("Nostr ".length), "base64").toString("utf8"),
    ) as {
      pubkey?: unknown;
    };
    return typeof event.pubkey === "string" ? event.pubkey : null;
  } catch {
    return null;
  }
}

/** Same FNV-1a-derived key as `relayCacheKey` in git-client.ts. */
export function relayCacheKey(relayUrl: string): string {
  let hash = 2_166_136_261;
  for (const character of relayUrl) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/** The pre-fix, viewer-less IndexedDB name. Production must never open it. */
export function legacyGitDbName(relayUrl: string, owner: string, repoName: string): string {
  return `buzz-git-${relayCacheKey(relayUrl)}-${owner}-${repoName}`;
}

/** The v2, viewer-scoped IndexedDB name used by the browser client. */
export function viewerGitDbName(
  relayUrl: string,
  viewer: string,
  owner: string,
  repoName: string,
): string {
  return `buzz-git-v2-${relayCacheKey(relayUrl)}-${viewer}-${owner}-${repoName}`;
}
