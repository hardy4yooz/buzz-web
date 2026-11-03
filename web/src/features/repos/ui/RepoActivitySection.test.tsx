import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRepoActivity, type RepoActivity } from "@/features/repos/use-repo-activity";
import type { Repo } from "@/features/repos/use-repos";
import { RepoActivitySection } from "./RepoActivitySection";

const OWNER = "a".repeat(64);
const AUTHOR = "c".repeat(64);
const REPO_ID = "activity-fixture";

const repo: Repo = {
  id: REPO_ID,
  name: REPO_ID,
  description: "",
  cloneUrls: [],
  webUrl: null,
  channelId: null,
  owner: OWNER,
  contributors: [],
  createdAt: 1_700_000_000,
};

function root(id: string, repoId = REPO_ID) {
  return {
    id: id.repeat(64).slice(0, 64),
    pubkey: AUTHOR,
    created_at: 1_700_000_100,
    kind: 1621,
    tags: [["a", `30617:${OWNER}:${repoId}`]],
    content: "",
    sig: "0".repeat(128),
  };
}

function activity(overrides: Partial<RepoActivity> = {}): RepoActivity {
  return { issues: [], pullRequests: [], truncated: false, complete: true, ...overrides };
}

function render(options: {
  activity?: RepoActivity;
  isLoading?: boolean;
  kind?: "issues" | "pull-requests";
}) {
  return renderToStaticMarkup(
    <RepoActivitySection
      activity={options.activity}
      error={null}
      isLoading={options.isLoading ?? false}
      kind={options.kind ?? "issues"}
      onOpenRepo={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("RepoActivitySection empty states", () => {
  it("claims absence only when the join was complete", () => {
    const html = render({ activity: activity() });

    expect(html).toContain("No issues published to this Relay");
    expect(html).not.toContain("No issues or pull requests from the loaded repositories");
  });

  it("does not claim absence when the Relay filled the window", () => {
    const html = render({ activity: activity({ truncated: true, complete: false }) });

    expect(html).toContain("The newest 200 Relay events were checked");
    expect(html).not.toContain("No issues published to this Relay");
    expect(html).toContain("No issues or pull requests from the loaded repositories");
  });

  it("does not claim absence when an activity root has no loaded announcement", () => {
    const unjoined = buildRepoActivity([root("1", "not-loaded")], [repo]);
    const html = render({ activity: unjoined, kind: "pull-requests" });

    expect(unjoined.issues).toEqual([]);
    expect(html).not.toContain("No pull requests published to this Relay");
    expect(html).toContain("No issues or pull requests from the loaded repositories");
  });

  it("shows the loading state, not an absence claim, before data is available", () => {
    const loading = render({ isLoading: true });
    expect(loading).toContain("Loading recent activity");
    expect(loading).not.toContain("No issues published to this Relay");

    const unavailable = render({});
    expect(unavailable).toContain("Activity is not loaded for this view.");
    expect(unavailable).not.toContain("No issues published to this Relay");
  });

  it("localizes the qualified empty state in Chinese", () => {
    vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });

    const html = render({ activity: activity({ truncated: true, complete: false }) });

    expect(html).toContain("在近期 Relay 活动中，没有来自已加载仓库的 Issue 或 Pull Request。");
    expect(html).not.toContain("当前 Relay 暂无 Issue");
  });
});
