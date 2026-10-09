import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentActivityStore, parseObserverFrame } from "@/features/chat/lib/agent-activity";
import { AgentActivityIndicator } from "@/features/chat/ui/AgentActivityIndicator";
import { AgentActivityPanel } from "@/features/chat/ui/AgentActivityPanel";

const AGENT = "2".repeat(64);
const CHANNEL = "channel-one";
const profiles = {
  [AGENT]: {
    pubkey: AGENT,
    name: "Fixture Agent",
    about: "",
    picture: null,
    isAgent: true,
  },
};

function activityStore() {
  const store = new AgentActivityStore();
  const frame = parseObserverFrame({
    seq: 1,
    timestamp: "2026-08-09T12:00:00.000Z",
    kind: "acp_read",
    channelId: CHANNEL,
    sessionId: "session-fixture",
    turnId: "turn-fixture",
    payload: {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          title: "shell",
          rawInput: { command: "npm test" },
          rawOutput: "private fixture output",
        },
      },
    },
  });
  if (!frame) throw new Error("fixture frame must be valid");
  store.ingest(AGENT, frame, 1_000);
  return store;
}

describe("agent activity UI", () => {
  it("shows the concrete current command in the compact indicator", () => {
    const store = activityStore();
    const statuses = store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_100);
    const html = renderToStaticMarkup(
      <AgentActivityIndicator
        itemCount={1}
        profiles={profiles}
        statuses={statuses}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain("Fixture Agent: Using a tool — npm test");
    expect(html).toContain("View activity");
  });

  it("shows redacted semantic activity without raw output or JSON", () => {
    const store = activityStore();
    const items = store.getItems(CHANNEL, [AGENT]);
    const statuses = store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_100);
    const html = renderToStaticMarkup(
      <AgentActivityPanel
        items={items}
        maximumWidth={720}
        minimumWidth={320}
        panelWidth={420}
        profiles={profiles}
        statuses={statuses}
        onClose={() => undefined}
        onResize={() => undefined}
      />,
    );

    expect(html).toContain("npm test");
    expect(html).not.toContain("private fixture output");
    expect(html).not.toContain("JSON");
  });

  it("suppresses raw protocol-only frames from Activity mode", () => {
    const store = new AgentActivityStore();
    const frame = parseObserverFrame({
      seq: 9,
      timestamp: "2026-08-09T12:00:00.000Z",
      kind: "raw_json_rpc",
      channelId: CHANNEL,
      sessionId: "session-fixture",
      turnId: "turn-fixture",
      payload: { fixtureSecret: "visible-only-in-json-mode" },
    });
    if (!frame) throw new Error("fixture frame must be valid");
    store.ingest(AGENT, frame, 1_000);

    const html = renderToStaticMarkup(
      <AgentActivityPanel
        items={store.getItems(CHANNEL, [AGENT])}
        maximumWidth={720}
        minimumWidth={320}
        panelWidth={420}
        profiles={profiles}
        statuses={[]}
        onClose={() => undefined}
        onResize={() => undefined}
      />,
    );

    expect(html).toContain("No summarized activity yet");
    expect(html).not.toContain("visible-only-in-json-mode");
  });
});
