import { describe, expect, it } from "vitest";
import { excludeDraftPrs, filterByAge, sortPrsByRecency } from "../src/lib/filter.js";
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

describe("excludeDraftPrs", () => {
  it("exclude가 true면 isDraft === true인 PR을 제거한다", () => {
    const draft = pr({ number: 1, isDraft: true });
    const ready = pr({ number: 2, isDraft: false });
    expect(excludeDraftPrs([draft, ready], true)).toEqual([ready]);
  });

  it("exclude가 false면 draft도 그대로 통과시킨다", () => {
    const draft = pr({ number: 1, isDraft: true });
    const ready = pr({ number: 2, isDraft: false });
    expect(excludeDraftPrs([draft, ready], false)).toEqual([draft, ready]);
  });

  it("isDraft를 알 수 없는(undefined) PR은 exclude=true여도 통과시킨다", () => {
    const unknown = pr({ number: 1 });
    expect(excludeDraftPrs([unknown], true)).toEqual([unknown]);
  });
});

describe("sortPrsByRecency", () => {
  it("updatedAt 내림차순으로 정렬한다", () => {
    const older = pr({ number: 1, updatedAt: new Date(NOW - 10 * DAY_MS).toISOString() });
    const newer = pr({ number: 2, updatedAt: new Date(NOW - 1 * DAY_MS).toISOString() });
    const middle = pr({ number: 3, updatedAt: new Date(NOW - 5 * DAY_MS).toISOString() });

    expect(sortPrsByRecency([older, newer, middle])).toEqual([newer, middle, older]);
  });

  it("updatedAt이 없는 PR은 맨 뒤로 보낸다", () => {
    const withDate = pr({ number: 1, updatedAt: new Date(NOW).toISOString() });
    const noDate = pr({ number: 2 });
    expect(sortPrsByRecency([noDate, withDate])).toEqual([withDate, noDate]);
  });

  it("동률(둘 다 없음 포함)이면 원래 순서를 유지한다", () => {
    const sameDate = new Date(NOW).toISOString();
    const a = pr({ number: 1, updatedAt: sameDate });
    const b = pr({ number: 2, updatedAt: sameDate });
    expect(sortPrsByRecency([a, b])).toEqual([a, b]);

    const noDateA = pr({ number: 3 });
    const noDateB = pr({ number: 4 });
    expect(sortPrsByRecency([noDateA, noDateB])).toEqual([noDateA, noDateB]);
  });

  it("원본 배열을 변형하지 않는다", () => {
    const older = pr({ number: 1, updatedAt: new Date(NOW - 10 * DAY_MS).toISOString() });
    const newer = pr({ number: 2, updatedAt: new Date(NOW - 1 * DAY_MS).toISOString() });
    const original = [older, newer];
    sortPrsByRecency(original);
    expect(original).toEqual([older, newer]);
  });
});
