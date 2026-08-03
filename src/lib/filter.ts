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

/**
 * exclude가 true면 isDraft === true인 PR을 제거한다. isDraft를 알 수 없는
 * (undefined) PR은 draft가 아닌 것으로 간주해 통과시킨다.
 */
export function excludeDraftPrs(prs: PrRef[], exclude: boolean): PrRef[] {
  if (!exclude) return prs;
  return prs.filter((pr) => pr.isDraft !== true);
}

/**
 * updatedAt 내림차순으로 정렬한다. updatedAt이 없거나 파싱할 수 없는 PR은
 * 맨 뒤로 보낸다. 동률(또는 둘 다 없음)이면 원래 순서를 유지한다(stable).
 */
export function sortPrsByRecency(prs: PrRef[]): PrRef[] {
  const withIndex = prs.map((pr, index) => ({ pr, index }));

  withIndex.sort((a, b) => {
    const aTime = a.pr.updatedAt ? Date.parse(a.pr.updatedAt) : NaN;
    const bTime = b.pr.updatedAt ? Date.parse(b.pr.updatedAt) : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);

    if (aValid && bValid) {
      if (aTime !== bTime) return bTime - aTime;
      return a.index - b.index;
    }
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return a.index - b.index;
  });

  return withIndex.map((entry) => entry.pr);
}
