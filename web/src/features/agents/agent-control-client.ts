import { makeNip98AuthHeader } from "@/shared/lib/nip98";

// The control service can spend 5s + 15s + 5s on is-active/start/is-active before responding.
// The remaining 10s of headroom also covers an operator proxy in front of the control service.
const START_TIMEOUT_MS = 35_000;

export async function startRelayAgent(controlUrl: string, pubkey: string): Promise<void> {
  const url = `${controlUrl.replace(/\/$/, "")}/start`;
  const body = JSON.stringify({ pubkey: pubkey.toLowerCase() });
  const authorization = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
  }
}
