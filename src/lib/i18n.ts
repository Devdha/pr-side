import type { GroupKind } from "./sync.js";

export const MESSAGE_KEYS = [
  "extensionName",
  "extensionShortName",
  "extensionDescription",
  "actionTitle",
  "popupTagline",
  "loading",
  "notSyncedYet",
  "lastSynced",
  "loginPrompt",
  "syncNow",
  "syncing",
  "openSettings",
  "prCounts",
  "loggedOut",
  "syncError",
  "unknownError",
  "optionsPageTitle",
  "groupModeLegend",
  "singleGroupLabel",
  "splitGroupLabel",
  "syncIntervalLabel",
  "maxAgeDaysLabel",
  "showAllHint",
  "save",
  "saved",
  "groupSingle",
  "groupAuthored",
  "groupReview",
  "noUsableWindow",
  "githubLoggedOutError",
  "githubHttpError",
  "suspectStatus",
  "syncRequestFailed",
  "allCaughtUp",
  "excludeDraftsLabel",
  "keepReviewedPrsLabel",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

export function getMessage(
  key: MessageKey,
  fallback: string,
  substitutions?: string | string[],
): string {
  return chrome.i18n.getMessage(key, substitutions) || fallback;
}

export function getUiLanguage(): string {
  return chrome.i18n.getUILanguage() || "en";
}

export function localizeDocument(root: Document = document): void {
  root.documentElement.lang = getUiLanguage();
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (!key) continue;
    const fallback = element.textContent?.trim() || "";
    element.textContent = getMessage(key, fallback);
  }
}

export function getGroupTitle(kind: GroupKind): string {
  if (kind === "single") return getMessage("groupSingle", "PR");
  if (kind === "authored") return getMessage("groupAuthored", "My PRs");
  return getMessage("groupReview", "Review requests");
}
