import { describe, expect, it } from "vitest";
import {
  deriveNotificationState,
  isNotificationEnabled,
  type NotificationProbe,
} from "@/features/notifications/lib/notification-state";

function state(
  overrides: {
    supported?: boolean;
    preference?: boolean;
    permission?: NotificationPermission;
    probe?: NotificationProbe;
  } = {},
) {
  return deriveNotificationState({
    supported: true,
    preference: false,
    permission: "default",
    probe: "idle",
    ...overrides,
  });
}

describe("deriveNotificationState", () => {
  it("reports unsupported without Notification, workers, or WebCrypto", () => {
    expect(state({ supported: false })).toBe("unsupported");
    expect(state({ supported: false, preference: true, permission: "granted" })).toBe(
      "unsupported",
    );
  });

  it("reports blocked whenever the browser denies permission, even with a stored preference", () => {
    expect(state({ permission: "denied" })).toBe("blocked");
    expect(state({ permission: "denied", preference: true, probe: "ready" })).toBe("blocked");
  });

  it("distinguishes off from granted_off", () => {
    expect(state()).toBe("off");
    expect(state({ preference: true })).toBe("off");
    expect(state({ permission: "granted" })).toBe("granted_off");
  });

  it("never reports ready while the worker probe is pending or failed", () => {
    expect(state({ preference: true, permission: "granted", probe: "idle" })).toBe("checking");
    expect(state({ preference: true, permission: "granted", probe: "checking" })).toBe("checking");
    expect(state({ preference: true, permission: "granted", probe: "failed" })).toBe("unavailable");
  });

  it("reports ready only when the preference, permission, and worker all hold", () => {
    expect(state({ preference: true, permission: "granted", probe: "ready" })).toBe("ready");
    for (const overrides of [
      { preference: false, permission: "granted" as const, probe: "ready" as const },
      { preference: true, permission: "default" as const, probe: "ready" as const },
      { preference: true, permission: "denied" as const, probe: "ready" as const },
      { preference: true, permission: "granted" as const, probe: "failed" as const },
    ]) {
      expect(isNotificationEnabled(state(overrides))).toBe(false);
    }
    expect(
      isNotificationEnabled(state({ preference: true, permission: "granted", probe: "ready" })),
    ).toBe(true);
  });
});
