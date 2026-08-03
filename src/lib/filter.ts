import type { PrRef } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * 최근 활동(updatedAt) 기준으로 PR 목록을 필터링한다.
 * maxAgeDays가 0 이하이거나 updatedAt이 없는 PR은 항상 통과시킨다.
 */
export function filterByAge(
  prs: PrRef[],
  maxAgeDays: number,
  nowMs: number,
): PrRef[] {
  if (maxAgeDays <= 0) {
    return prs;
  }

  const maxAgeMs = maxAgeDays * DAY_MS;

  return prs.filter((pr) => {
    if (!pr.updatedAt) return true;
    const updatedAtMs = Date.parse(pr.updatedAt);
    if (Number.isNaN(updatedAtMs)) return true;
    return nowMs - updatedAtMs <= maxAgeMs;
  });
}
