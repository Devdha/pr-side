export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  /** ISO 8601 형식의 마지막 활동 시각 (없으면 생성 시각으로 대체될 수 있음) */
  updatedAt?: string;
  /** true면 draft PR. 알 수 없으면 undefined. */
  isDraft?: boolean;
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export type GroupMode = "single" | "split";

export interface Settings {
  groupMode: GroupMode;
  syncIntervalMinutes: number;
  /** 최근 활동 기준 표시 기간(일). 0 이하는 제한 없음. */
  maxAgeDays: number;
  /** true면 draft PR을 그룹/탭에서 제외한다. */
  excludeDrafts: boolean;
  /** true면 review-requested 목록에서 사라졌더라도(=리뷰를 남긴 경우) merge/close
   * 전까지는 "리뷰 요청" 그룹에 계속 표시한다. */
  keepReviewedPrs: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  groupMode: "split",
  syncIntervalMinutes: 5,
  maxAgeDays: 30,
  excludeDrafts: false,
  keepReviewedPrs: true,
};

export type SyncState = "ok" | "logged_out" | "error" | "suspect";

export interface SyncStatus {
  lastSyncAt?: number;
  state: SyncState;
  errorMessage?: string;
  authoredCount?: number;
  reviewCount?: number;
  /** "suspect" 상태가 연속으로 관측된 횟수 */
  suspectStreak?: number;
}
