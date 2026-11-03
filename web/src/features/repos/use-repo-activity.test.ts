import { describe, expect, it } from "vitest";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { activityCount, activityQueryEnabled, buildRepoActivity } from "./use-repo-activity";
import type { Repo } from "./use-repos";

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const ISSUE_AUTHOR = "c".repeat(64);
const PR_AUTHOR = "d".repeat(64);
const STRANGER = "e".repeat(64);
const REPO_ID = "activity-fixture";

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
    name: "activity-fixture",
    description: "",
    cloneUrls: [],
    webUrl: null,
    channelId: null,
    owner: OWNER,
    contributors: [],
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

let sequence = 0;

function event(kind: number, tags: string[][], overrides: Partial<NostrEvent> = {}): NostrEvent {
  sequence += 1;
  return {
    id: String(sequence).padStart(64, "0"),
    pubkey: ISSUE_AUTHOR,
    created_at: 1_700_000_000 + sequence,
    kind,
    tags,
    content: "",
    sig: "0".repeat(128),
    ...overrides,
  };
}

function issue(id: string, author = ISSUE_AUTHOR, repoOwner = OWNER, repoId = REPO_ID) {
  return event(
    1621,
    [
      ["a", `30617:${repoOwner}:${repoId}`],
      ["p", repoOwner],
      ["subject", `Subject ${id}`],
    ],
    { id: id.repeat(64).slice(0, 64), pubkey: author },
  );
}

function pullRequest(id: string, author = PR_AUTHOR, repoOwner = OWNER, repoId = REPO_ID) {
  return event(
    1618,
    [
      ["a", `30617:${repoOwner}:${repoId}`],
      ["p", repoOwner],
      ["subject", `Subject ${id}`],
    ],
    { id: id.repeat(64).slice(0, 64), pubkey: author },
  );
}

function status(root: NostrEvent, statusKind: number, author: string, createdAt: number) {
  return event(statusKind, [["e", root.id]], {
    id: `${statusKind}${author.slice(0, 4)}${String(createdAt).padStart(8, "0")}`.padEnd(64, "0"),
    pubkey: author,
    created_at: createdAt,
  });
}

describe("buildRepoActivity", () => {
  it("returns empty lists for empty input", () => {
    expect(buildRepoActivity([], [repo()])).toEqual({
      issues: [],
      pullRequests: [],
      truncated: false,
      complete: true,
    });
  });

  it("joins only events whose a tag matches a loaded repository", () => {
    const root = issue("1");
    const sameDOtherOwner = issue("2", ISSUE_AUTHOR, OTHER_OWNER);
    const unknownRepo = issue("3", ISSUE_AUTHOR, OWNER, "not-loaded");
    const pr = pullRequest("4");

    const activity = buildRepoActivity([root, sameDOtherOwner, unknownRepo, pr], [repo()]);

    expect(activity.issues.map((item) => item.id)).toEqual([root.id]);
    expect(activity.pullRequests.map((item) => item.id)).toEqual([pr.id]);
    expect(activity.issues[0]?.repoName).toBe("activity-fixture");
  });

  it("sorts newest first and breaks timestamp ties by id ascending", () => {
    const older = event(
      1621,
      [
        ["a", `30617:${OWNER}:${REPO_ID}`],
        ["subject", "Older"],
      ],
      {
        id: "0".repeat(64),
        created_at: 100,
      },
    );
    const tiedB = event(
      1621,
      [
        ["a", `30617:${OWNER}:${REPO_ID}`],
        ["subject", "Tied B"],
      ],
      {
        id: "b".repeat(64),
        created_at: 200,
      },
    );
    const tiedA = event(
      1621,
      [
        ["a", `30617:${OWNER}:${REPO_ID}`],
        ["subject", "Tied A"],
      ],
      {
        id: "a".repeat(64),
        created_at: 200,
      },
    );

    const activity = buildRepoActivity([tiedB, older, tiedA], [repo()]);

    expect(activity.issues.map((item) => item.title)).toEqual(["Tied A", "Tied B", "Older"]);
  });

  it("trusts status only from the root author or repository owner", () => {
    const root = issue("1");
    const strangerClose = status(root, 1632, STRANGER, 300);
    const strangerDraft = status(root, 1633, STRANGER, 400);

    const ignored = buildRepoActivity([root, strangerClose, strangerDraft], [repo()]);
    expect(ignored.issues[0]?.status).toBe("open");

    const authorStatus = status(root, 1632, ISSUE_AUTHOR, 300);
    const ownerStatus = status(root, 1630, OWNER, 200);
    const accepted = buildRepoActivity([root, authorStatus, ownerStatus], [repo()]);
    expect(accepted.issues[0]?.status).toBe("closed");
    expect(accepted.issues[0]?.statusAuthor).toBe(ISSUE_AUTHOR);
  });

  it("uses the latest trusted status and labels merged per event kind", () => {
    const issueRoot = issue("1");
    const prRoot = pullRequest("2");
    const issueClosed = status(issueRoot, 1632, OWNER, 300);
    const issueApplied = status(issueRoot, 1631, ISSUE_AUTHOR, 400);
    const prMerged = status(prRoot, 1631, PR_AUTHOR, 300);

    const activity = buildRepoActivity(
      [issueRoot, prRoot, issueClosed, issueApplied, prMerged],
      [repo()],
    );

    expect(activity.issues[0]?.status).toBe("applied");
    expect(activity.pullRequests[0]?.status).toBe("merged");
  });

  it("ignores malformed and unjoinable events without throwing", () => {
    const root = issue("1");
    const malformed = [
      { ...event(1621, []), tags: "not-an-array" },
      event(1621, [["a", "30617:missing-parts"]]),
      event(
        1621,
        [
          ["a", `30617:${OWNER}:${REPO_ID}`],
          ["subject", ""],
        ],
        { pubkey: "" },
      ),
      event(1632, []),
      event(1630, [["e", "missing-root"]], { pubkey: OWNER }),
    ] as unknown as NostrEvent[];

    const activity = buildRepoActivity([root, ...malformed], [repo()]);

    expect(activity.issues.map((item) => item.id)).toEqual([root.id]);
    expect(activity.issues[0]?.status).toBe("open");
  });

  it("reports the bounded query window only when the Relay filled it", () => {
    const one = buildRepoActivity([issue("1")], [repo()]);
    expect(one.truncated).toBe(false);
    expect(one.complete).toBe(true);

    const fullWindow = Array.from({ length: 200 }, (_, index) =>
      event(1621, [
        ["a", `30617:${OWNER}:${REPO_ID}`],
        ["subject", `Issue ${index}`],
      ]),
    );
    const full = buildRepoActivity(fullWindow, [repo()]);
    expect(full.truncated).toBe(true);
    expect(full.complete).toBe(false);
  });

  it("marks the join incomplete when a root names a repository that is not loaded", () => {
    const activity = buildRepoActivity([issue("1", ISSUE_AUTHOR, OWNER, "not-loaded")], [repo()]);

    expect(activity.issues).toEqual([]);
    expect(activity.complete).toBe(false);
  });

  it("falls back from subject to content and then to the event id", () => {
    const withContent = event(1621, [["a", `30617:${OWNER}:${REPO_ID}`]], {
      content: "  A long issue body used as the title when no subject exists.  ",
      created_at: 200,
    });
    const withNothing = event(1621, [["a", `30617:${OWNER}:${REPO_ID}`]], {
      id: "f".repeat(64),
      content: "",
      created_at: 100,
    });

    const activity = buildRepoActivity([withContent, withNothing], [repo()]);

    expect(activity.issues[0]?.title).toBe(
      "A long issue body used as the title when no subject exists.",
    );
    expect(activity.issues[1]?.title).toContain("ffffffff");
  });
});

describe("activity availability", () => {
  it("keeps the query disabled until repository announcements are loaded", () => {
    expect(activityQueryEnabled(true, OWNER, 0)).toBe(false);
    expect(activityQueryEnabled(true, null, 1)).toBe(false);
    expect(activityQueryEnabled(false, OWNER, 1)).toBe(false);
    expect(activityQueryEnabled(true, OWNER, 1)).toBe(true);
  });

  it("shows a count only when the join was complete or found something", () => {
    const joined = buildRepoActivity([issue("1")], [repo()]);

    expect(activityCount([], false)).toBeNull();
    expect(activityCount([], true)).toBe(0);
    expect(activityCount(joined.issues, false)).toBe(1);
  });
});
