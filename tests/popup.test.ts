import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeElement {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  addEventListener: ReturnType<typeof vi.fn>;
}

function fakeElement(textContent = ""): FakeElement {
  return {
    textContent,
    hidden: false,
    disabled: false,
    dataset: {},
    addEventListener: vi.fn(),
  };
}

function setupPopup(
  status: unknown,
  localizedMessages: Record<string, string> = {},
): Record<string, FakeElement> {
  const elements: Record<string, FakeElement> = {
    statusSection: fakeElement(),
    statusLine: fakeElement("Loading..."),
    statusMeta: fakeElement(),
    authoredCount: fakeElement("0"),
    reviewCount: fakeElement("0"),
    loginLink: fakeElement(),
    syncButton: fakeElement("Sync now"),
    optionsButton: fakeElement("Settings"),
  };

  vi.stubGlobal("document", {
    documentElement: { lang: "en" },
    querySelectorAll: () => [],
    getElementById: (id: string) => elements[id],
  });
  vi.stubGlobal("chrome", {
    i18n: {
      getUILanguage: () => "en-US",
      getMessage: (key: string) => localizedMessages[key] ?? "",
    },
    storage: {
      local: {
        get: async () => ({ state: status ? { status } : undefined }),
      },
    },
    runtime: {
      sendMessage: vi.fn(),
      openOptionsPage: vi.fn(),
    },
  });

  return elements;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("popup status rendering", () => {
  it("renders a successful sync with separate counts and last-sync metadata", async () => {
    const elements = setupPopup(
      { state: "ok", lastSyncAt: 1_722_628_800_000, authoredCount: 4, reviewCount: 7 },
      {
        allCaughtUp: "You're all caught up",
        lastSynced: "Last synced: Aug 3, 2024, 9:00 AM",
      },
    );

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("ok");
    });
    expect(elements.statusLine.textContent).toBe("You're all caught up");
    expect(elements.statusMeta.textContent).toContain("Last synced:");
    expect(elements.statusMeta.hidden).toBe(false);
    expect(elements.authoredCount.textContent).toBe("4");
    expect(elements.reviewCount.textContent).toBe("7");
  });

  it("renders suspect status without discarding existing counts", async () => {
    const suspectStatus =
      "Could not read the PR list. GitHub's page format may have changed. Existing tabs are preserved.";
    const elements = setupPopup(
      { state: "suspect", authoredCount: 2, reviewCount: 3, suspectStreak: 1 },
      { suspectStatus },
    );

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("suspect");
    });
    expect(elements.statusLine.textContent).toBe(suspectStatus);
    expect(elements.authoredCount.textContent).toBe("2");
    expect(elements.reviewCount.textContent).toBe("3");
  });

  it("renders an idle empty state when no status is stored", async () => {
    const elements = setupPopup(undefined, { notSyncedYet: "Not synced yet" });

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("idle");
    });
    expect(elements.statusLine.textContent).toBe("Not synced yet");
    expect(elements.authoredCount.textContent).toBe("0");
    expect(elements.reviewCount.textContent).toBe("0");
    expect(elements.statusMeta.hidden).toBe(true);
    expect(elements.loginLink.hidden).toBe(true);
  });

  it("shows the login link for logged-out status", async () => {
    const elements = setupPopup(
      { state: "logged_out", authoredCount: 1, reviewCount: 2 },
      { loggedOut: "You are signed out of GitHub." },
    );

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("logged_out");
    });
    expect(elements.statusLine.textContent).toBe("You are signed out of GitHub.");
    expect(elements.loginLink.hidden).toBe(false);
  });

  it("renders a localized error status", async () => {
    const elements = setupPopup(
      { state: "error", errorMessage: "GitHub timed out" },
      { syncError: "Sync error: GitHub timed out" },
    );

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("error");
    });
    expect(elements.statusLine.textContent).toBe("Sync error: GitHub timed out");
  });
});

describe("popup sync request failure", () => {
  it("hides a previously visible login link when the sync request fails", async () => {
    const elements = setupPopup(
      { state: "logged_out", authoredCount: 1, reviewCount: 2 },
      {
        loggedOut: "You are signed out of GitHub.",
        syncRequestFailed: "The sync request failed. Please try again in a moment.",
        syncing: "Syncing...",
        syncNow: "Sync now",
      },
    );
    chrome.runtime.sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection.");
    });

    await import("../src/popup/popup.js");

    await vi.waitFor(() => {
      expect(elements.loginLink.hidden).toBe(false);
    });
    const clickHandler = elements.syncButton.addEventListener.mock.calls[0][1] as () => void;
    clickHandler();

    await vi.waitFor(() => {
      expect(elements.statusSection.dataset.state).toBe("error");
    });
    expect(elements.loginLink.hidden).toBe(true);
  });

  it("shows a retry message when the background sync message fails", async () => {
    const syncRequestFailed = "The sync request failed. Please try again in a moment.";
    const elements = setupPopup(undefined, {
      syncRequestFailed,
      syncing: "Syncing...",
      syncNow: "Sync now",
      notSyncedYet: "Not synced yet",
    });
    chrome.runtime.sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection.");
    });

    await import("../src/popup/popup.js");

    const clickHandler = elements.syncButton.addEventListener.mock.calls[0][1] as () => void;
    clickHandler();

    await vi.waitFor(() => {
      expect(elements.statusLine.textContent).toBe(syncRequestFailed);
    });
    expect(elements.statusSection.dataset.state).toBe("error");
    expect(elements.syncButton.disabled).toBe(false);
    expect(elements.syncButton.textContent).toBe("Sync now");
  });
});
