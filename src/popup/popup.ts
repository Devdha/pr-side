import type { SyncStatus } from "../lib/types.js";
import {
  getMessage,
  getUiLanguage,
  localizeDocument,
} from "../lib/i18n.js";

const STORAGE_KEY = "state";

localizeDocument();

const statusSection = document.getElementById("statusSection") as HTMLElement;
const statusLine = document.getElementById("statusLine") as HTMLParagraphElement;
const statusMeta = document.getElementById("statusMeta") as HTMLParagraphElement;
const authoredCount = document.getElementById("authoredCount") as HTMLElement;
const reviewCount = document.getElementById("reviewCount") as HTMLElement;
const loginLink = document.getElementById("loginLink") as HTMLAnchorElement;
const syncButton = document.getElementById("syncButton") as HTMLButtonElement;
const optionsButton = document.getElementById("optionsButton") as HTMLButtonElement;

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return getMessage("notSyncedYet", "Not synced yet");
  const formatted = new Intl.DateTimeFormat(getUiLanguage(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
  return getMessage("lastSynced", `Last synced: ${formatted}`, formatted);
}

function setCounts(status: SyncStatus | undefined): void {
  authoredCount.textContent = String(status?.authoredCount ?? 0);
  reviewCount.textContent = String(status?.reviewCount ?? 0);
}

function render(status: SyncStatus | undefined): void {
  setCounts(status);
  loginLink.hidden = true;
  statusMeta.hidden = true;
  statusMeta.textContent = "";

  if (!status) {
    statusSection.dataset.state = "idle";
    statusLine.textContent = getMessage("notSyncedYet", "Not synced yet");
    return;
  }

  statusSection.dataset.state = status.state;
  switch (status.state) {
    case "ok":
      statusLine.textContent = getMessage("allCaughtUp", "You're all caught up");
      if (status.lastSyncAt) {
        statusMeta.textContent = formatTime(status.lastSyncAt);
        statusMeta.hidden = false;
      }
      break;
    case "logged_out":
      statusLine.textContent = getMessage(
        "loggedOut",
        "You are signed out of GitHub.",
      );
      loginLink.hidden = false;
      break;
    case "error": {
      const errorMessage =
        status.errorMessage ?? getMessage("unknownError", "Unknown error");
      statusLine.textContent = getMessage(
        "syncError",
        `Sync error: ${errorMessage}`,
        errorMessage,
      );
      break;
    }
    case "suspect":
      statusLine.textContent = getMessage(
        "suspectStatus",
        "Could not read the PR list. GitHub's page format may have changed. Existing tabs are preserved.",
      );
      break;
  }
}

async function loadStatus(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY] as { status?: SyncStatus } | undefined;
  render(state?.status);
}

async function runSync(): Promise<void> {
  syncButton.disabled = true;
  syncButton.textContent = getMessage("syncing", "Syncing...");
  statusSection.dataset.state = "loading";
  statusLine.textContent = getMessage("syncing", "Syncing...");
  statusMeta.hidden = true;
  loginLink.hidden = true;

  try {
    const status = (await chrome.runtime.sendMessage({ type: "sync" })) as SyncStatus;
    render(status);
  } catch {
    statusSection.dataset.state = "error";
    statusLine.textContent = getMessage(
      "syncRequestFailed",
      "The sync request failed. Please try again in a moment.",
    );
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = getMessage("syncNow", "Sync now");
  }
}

syncButton.addEventListener("click", () => {
  void runSync();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void loadStatus();
