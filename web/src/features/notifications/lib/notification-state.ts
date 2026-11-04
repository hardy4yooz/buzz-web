export type NotificationProbe = "idle" | "checking" | "ready" | "failed";

export type NotificationUiState =
  | "unsupported"
  | "blocked"
  | "off"
  | "granted_off"
  | "checking"
  | "unavailable"
  | "ready";

/**
 * Settings state is derived from live browser facts on every render; the stored value only records
 * the user's wish, never that notifications currently work.
 */
export function deriveNotificationState({
  supported,
  preference,
  permission,
  probe,
}: {
  supported: boolean;
  preference: boolean;
  permission: NotificationPermission;
  probe: NotificationProbe;
}): NotificationUiState {
  if (!supported) return "unsupported";
  if (permission === "denied") return "blocked";
  if (!preference) return permission === "granted" ? "granted_off" : "off";
  if (permission !== "granted") return "off";
  if (probe === "ready") return "ready";
  if (probe === "failed") return "unavailable";
  return "checking";
}

export function isNotificationEnabled(state: NotificationUiState): boolean {
  return state === "ready";
}
