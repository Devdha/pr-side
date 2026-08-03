import { describe, expect, it } from "vitest";
import popupCss from "../src/popup/popup.css?raw";

type Rgb = readonly [number, number, number];

function block(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing CSS block: ${selector}`);
  return match[1];
}

function declaration(source: string, property: string): string {
  const match = source.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  if (!match) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
}

function variables(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function colors(value: string, tokens: Map<string, string>): string[] {
  return [...value.matchAll(/#[\da-f]{6}|var\((--[\w-]+)\)/gi)].map((match) => {
    if (match[1]) {
      const resolved = tokens.get(match[1]);
      if (!resolved) throw new Error(`Missing CSS variable: ${match[1]}`);
      return resolved;
    }
    return match[0];
  });
}

function rgb(hex: string): Rgb {
  const channels = hex.match(/[\da-f]{2}/gi);
  if (!channels || channels.length !== 3) throw new Error(`Expected hex color: ${hex}`);
  return channels.map((channel) => Number.parseInt(channel, 16)) as unknown as Rgb;
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("popup color contrast", () => {
  it("keeps link and primary-button text at WCAG AA contrast in both themes", () => {
    const darkMedia = popupCss.slice(popupCss.indexOf("@media (prefers-color-scheme: dark)"));
    const lightTokens = variables(block(popupCss, ":root"));
    const darkTokens = new Map([
      ...lightTokens,
      ...variables(block(darkMedia, ":root")),
    ]);
    const lightButton = block(popupCss, ".primary-button");
    const lightButtonHover = block(popupCss, ".primary-button:hover");
    const darkButton = block(darkMedia, ".primary-button");
    const darkButtonHover = block(darkMedia, ".primary-button:hover");
    const link = block(popupCss, ".login-link");
    const activeLink = block(popupCss, ".login-link:active");

    const combinations = [
      ["light link", colors(declaration(link, "color"), lightTokens), ["#ffffff"]],
      ["light link active", colors(declaration(activeLink, "color"), lightTokens), ["#ffffff"]],
      ["dark link", colors(declaration(link, "color"), darkTokens), ["#161b22"]],
      ["dark link active", colors(declaration(activeLink, "color"), darkTokens), ["#161b22"]],
      ["light button", ["#ffffff"], colors(declaration(lightButton, "background"), lightTokens)],
      ["light button hover", ["#ffffff"], colors(declaration(lightButtonHover, "background"), lightTokens)],
      ["dark button", ["#ffffff"], colors(declaration(darkButton, "background"), darkTokens)],
      ["dark button hover", ["#ffffff"], colors(declaration(darkButtonHover, "background"), darkTokens)],
    ] as const;

    const failures = combinations.flatMap(([name, foregrounds, backgrounds]) =>
      foregrounds.flatMap((foreground) =>
        backgrounds.flatMap((background) => {
          const ratio = contrast(foreground, background);
          return ratio < 4.5 ? [`${name}: ${foreground}/${background} = ${ratio.toFixed(2)}:1`] : [];
        }),
      ),
    );

    expect(failures).toEqual([]);
  });
});
