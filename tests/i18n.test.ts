import { afterEach, describe, expect, it, vi } from "vitest";
import enJson from "../src/_locales/en/messages.json";
import koJson from "../src/_locales/ko/messages.json";
import {
  MESSAGE_KEYS,
  getGroupTitle,
  getMessage,
  getUiLanguage,
  localizeDocument,
} from "../src/lib/i18n.js";

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const en = enJson as Record<string, LocaleMessage>;
const ko = koJson as Record<string, LocaleMessage>;

afterEach(() => vi.unstubAllGlobals());

describe("locale catalogs", () => {
  it("contain exactly the typed message keys", () => {
    expect(Object.keys(en).sort()).toEqual([...MESSAGE_KEYS].sort());
    expect(Object.keys(ko).sort()).toEqual([...MESSAGE_KEYS].sort());
  });

  it("use matching placeholder names and positions", () => {
    for (const key of MESSAGE_KEYS) {
      expect(Object.keys(ko[key].placeholders ?? {}).sort()).toEqual(
        Object.keys(en[key].placeholders ?? {}).sort(),
      );
      for (const placeholder of Object.keys(en[key].placeholders ?? {})) {
        expect(ko[key].placeholders?.[placeholder]?.content).toBe(
          en[key].placeholders?.[placeholder]?.content,
        );
      }
    }
  });
});

describe("i18n adapter", () => {
  it("returns Chrome's localized message", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: vi.fn(() => "동기화 중..."),
        getUILanguage: vi.fn(() => "ko-KR"),
      },
    });
    expect(getMessage("syncing", "Syncing...")).toBe("동기화 중...");
  });

  it("uses the explicit English fallback for an empty Chrome result", () => {
    vi.stubGlobal("chrome", {
      i18n: { getMessage: vi.fn(() => ""), getUILanguage: vi.fn(() => "") },
    });
    expect(getMessage("syncing", "Syncing...")).toBe("Syncing...");
    expect(getUiLanguage()).toBe("en");
  });

  it("looks up group titles through the same catalog", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: vi.fn(
          (key: string) =>
            ({
              groupSingle: "PR",
              groupAuthored: "My PRs",
              groupReview: "Review requests",
            })[key] ?? "",
        ),
        getUILanguage: vi.fn(() => "en-US"),
      },
    });
    expect(getGroupTitle("single")).toBe("PR");
    expect(getGroupTitle("authored")).toBe("My PRs");
    expect(getGroupTitle("review")).toBe("Review requests");
  });

  it("sets the document language and localizes marked elements", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: vi.fn((key: string) =>
          key === "syncNow" ? "지금 동기화" : "",
        ),
        getUILanguage: vi.fn(() => "ko-KR"),
      },
    });
    const element = {
      dataset: { i18n: "syncNow" },
      textContent: "Sync now",
    };
    const root = {
      documentElement: { lang: "en" },
      querySelectorAll: vi.fn(() => [element]),
    } as unknown as Document;

    localizeDocument(root);

    expect(root.documentElement.lang).toBe("ko-KR");
    expect(element.textContent).toBe("지금 동기화");
  });
});
