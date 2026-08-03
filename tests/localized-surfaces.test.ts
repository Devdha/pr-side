import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.json";
import optionsHtml from "../src/options/options.html?raw";
import popupCss from "../src/popup/popup.css?raw";
import popupHtml from "../src/popup/popup.html?raw";

describe("localized extension surfaces", () => {
  it("uses native i18n placeholders in the manifest", () => {
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.short_name).toBe("__MSG_extensionShortName__");
    expect(manifest.description).toBe("__MSG_extensionDescription__");
    expect(manifest.action.default_title).toBe("__MSG_actionTitle__");
  });

  it("marks every static popup string for localization", () => {
    for (const key of [
      "extensionShortName",
      "popupTagline",
      "loading",
      "loginPrompt",
      "groupAuthored",
      "groupReview",
      "syncNow",
      "openSettings",
    ]) {
      expect(popupHtml).toContain(`data-i18n="${key}"`);
    }
  });

  it("defines popup theme and accessibility contracts", () => {
    expect(popupHtml).toContain('aria-live="polite"');
    expect(popupHtml).toContain('src="../icons/icon-32.png"');
    expect(popupCss).toContain("width: 336px");
    expect(popupCss).toContain("@media (prefers-color-scheme: dark)");
    expect(popupCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(popupCss).toContain(":focus-visible");
    for (const state of ["loading", "idle", "ok", "logged_out", "suspect", "error"]) {
      expect(popupCss).toContain(`[data-state="${state}"]`);
    }
  });

  it("keeps hidden popup elements out of layout when component styles set display", () => {
    expect(popupHtml).toContain('id="loginLink"');
    expect(popupHtml).toMatch(/id="loginLink"[^>]*\shidden(?:\s|>)/);
    expect(popupCss).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important;?[^}]*\}/);
  });

  it("marks every static options string for localization", () => {
    for (const key of [
      "optionsPageTitle",
      "groupModeLegend",
      "singleGroupLabel",
      "splitGroupLabel",
      "syncIntervalLabel",
      "maxAgeDaysLabel",
      "showAllHint",
      "save",
    ]) {
      expect(optionsHtml).toContain(`data-i18n="${key}"`);
    }
  });
});
