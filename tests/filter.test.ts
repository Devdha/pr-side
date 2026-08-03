import { describe, expect, it } from "vitest";
import { filterByAge } from "../src/lib/filter.js";
import type { PrRef } from "../src/lib/types.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-03T00:00:00.000Z");

function pr(overrides: Partial<PrRef> = {}): PrRef {
  return {
    owner: "octocat",
    repo: "hello-world",
    number: 1,
    ...overrides,
  };
}

describe("filterByAge", () => {
  it("maxAgeDays 이내에 업데이트된 PR만 통과시킨다", () => {
    const recent = pr({
      number: 1,
      updatedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
    });
    const old = pr({
      number: 2,
      updatedAt: new Date(NOW - 40 * DAY_MS).toISOString(),
    });

    const result = filterByAge([recent, old], 30, NOW);
    expect(result).toEqual([recent]);
  });

  it("maxAgeDays가 0이면 전부 통과시킨다(무제한)", () => {
    const veryOld = pr({
      number: 1,
      updatedAt: new Date(NOW - 365 * DAY_MS).toISOString(),
    });
    expect(filterByAge([veryOld], 0, NOW)).toEqual([veryOld]);
  });

  it("maxAgeDays가 음수여도 전부 통과시킨다(무제한)", () => {
    const veryOld = pr({
      number: 1,
      updatedAt: new Date(NOW - 365 * DAY_MS).toISOString(),
    });
    expect(filterByAge([veryOld], -1, NOW)).toEqual([veryOld]);
  });

  it("updatedAt이 없는 PR은 항상 통과시킨다", () => {
    const noDate = pr({ number: 1 });
    expect(filterByAge([noDate], 7, NOW)).toEqual([noDate]);
  });

  it("경계값: 정확히 N일 전이면 통과시킨다", () => {
    const exactlyBoundary = pr({
      number: 1,
      updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
    });
    expect(filterByAge([exactlyBoundary], 30, NOW)).toEqual([exactlyBoundary]);
  });

  it("경계값: N일보다 1ms라도 지나면 제외한다", () => {
    const justOverBoundary = pr({
      number: 1,
      updatedAt: new Date(NOW - 30 * DAY_MS - 1).toISOString(),
    });
    expect(filterByAge([justOverBoundary], 30, NOW)).toEqual([]);
  });
});
