import { excludeDraftPrs, filterByAge, sortPrsByRecency } from "./filter.js";
import { CookiePrSource, LoggedOutError, type PrSource } from "./github.js";
import { getGroupTitle, getMessage } from "./i18n.js";
import { parseEmbeddedData, parsePrPageState } from "./parser.js";
import { loadSettings } from "./settings.js";
import { type GroupMode, type PrRef, type SyncStatus, prKey, prUrl } from "./types.js";

export type GroupKind = "single" | "authored" | "review";

const ALL_KINDS: GroupKind[] = ["single", "authored", "review"];

interface GroupSpec {
  kind: GroupKind;
  title: string;
  color: chrome.tabGroups.ColorEnum;
  prs: PrRef[];
}

/**
 * "리뷰한 PR 유지" 기능이 storage.local에 보관하는 항목. review-requested
 * 목록에서 사라졌지만(=리뷰를 남겼을 가능성) merge/close가 아직 확인되지 않은
 * PR을 계속 "리뷰 요청" 그룹에 표시하기 위한 최소 정보.
 */
export interface ReviewedKeepEntry {
  url: string;
  title?: string;
  updatedAt?: string;
  /** 마지막으로 상태를 재확인한 시각(ms). fetch 실패 시 0으로 두어 다음
   * sync에서 최우선으로 재검증되게 한다. */
  lastCheckedAt: number;
}

interface StoredState {
  groupIds: Partial<Record<GroupKind, number>>;
  status: SyncStatus;
  reviewedKeep: Record<string, ReviewedKeepEntry>;
  /** 직전 sync에서 review-requested 목록에 있던 PR 키. 다음 sync에서 어떤 PR이
   * 새로 사라졌는지(=리뷰했을 가능성) 판단하는 기준선이 된다. */
  lastReviewKeys: string[];
}

const STORAGE_KEY = "state";

async function loadState(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<StoredState> | undefined;
  return {
    groupIds: value?.groupIds ?? {},
    status: value?.status ?? { state: "ok" },
    reviewedKeep: value?.reviewedKeep ?? {},
    lastReviewKeys: value?.lastReviewKeys ?? [],
  };
}

async function saveState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function readStatus(): Promise<SyncStatus> {
  const state = await loadState();
  return state.status;
}

const TAB_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

function parsePrRefFromUrl(
  url: string | undefined,
): Pick<PrRef, "owner" | "repo" | "number"> | null {
  if (!url) return null;
  const match = TAB_URL_RE.exec(url);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  return { owner, repo, number: Number.parseInt(numberStr, 10) };
}

function prKeyFromUrl(url: string | undefined): string | null {
  const parsed = parsePrRefFromUrl(url);
  return parsed ? prKey(parsed) : null;
}

/** prKey() 형식("owner/repo#123")의 역파싱. */
function parsePrKeyString(
  key: string,
): Pick<PrRef, "owner" | "repo" | "number"> | null {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  return { owner, repo, number: Number.parseInt(numberStr, 10) };
}

// 로딩 중이거나 discard된 탭은 tab.url이 비어 있을 수 있으므로 pendingUrl도 시도한다.
// (stale로 오판되어 닫히는 것을 방지)
function tabPrKey(tab: chrome.tabs.Tab): string | null {
  return prKeyFromUrl(tab.url) ?? prKeyFromUrl(tab.pendingUrl);
}

/**
 * 탭이 로드를 마쳐 제목이 잡힌 뒤에 discard한다.
 * URL 커밋 직후 곧바로 discard하면 title이 아직 없어 discard된 탭에
 * PR 제목 대신 URL만 남는다. Chrome은 discard된 탭의 마지막 title/favicon을
 * 유지하므로, title이 잡히는 시점(onUpdated의 title 변경 또는
 * status:"complete")까지 기다렸다가 discard한다.
 * 타임아웃되면 URL이라도 커밋돼 있으면 discard(제목 유실은 감수하되 URL 유실은
 * 방지), URL조차 없으면 discard를 건너뛴다.
 */
async function discardWhenLoaded(
  tabId: number,
  timeoutMs = 30_000,
): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // 탭이 이미 사라진 경우
    return;
  }

  if (tab.status === "complete" && tab.title) {
    try {
      await chrome.tabs.discard(tabId);
    } catch {
      // 실패는 무시
    }
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.title !== undefined || changeInfo.status === "complete") {
        chrome.tabs
          .discard(tabId)
          .catch(() => {
            // 실패는 무시
          })
          .finally(finish);
      }
    };

    const timer = setTimeout(() => {
      chrome.tabs
        .get(tabId)
        .then((latest) => {
          if (latest.url) {
            return chrome.tabs.discard(tabId).catch(() => {
              // 실패는 무시
            });
          }
          return undefined;
        })
        .catch(() => {
          // 탭이 이미 사라진 경우 무시
        })
        .finally(finish);
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * discard된 탭이 제목 없이(또는 URL 그대로) 남아있는지 판단한다.
 * 예전 즉시-discard 로직 때문에 생긴 탭들을 재로드 대상으로 찾아내는 데 쓰인다.
 */
export function needsTitleReload(
  tab: Pick<chrome.tabs.Tab, "discarded" | "title" | "url" | "pendingUrl">,
): boolean {
  if (!tab.discarded) return false;

  const title = tab.title;
  if (!title) return true;

  if (title.startsWith("https://")) return true;

  const candidateUrls = [tab.url, tab.pendingUrl].filter(
    (url): url is string => !!url,
  );

  for (const url of candidateUrls) {
    if (title === url) return true;
    try {
      const parsed: URL = new URL(url);
      if (title === `${parsed.host}${parsed.pathname}`) return true;
    } catch {
      // 유효하지 않은 URL은 무시
    }
  }

  return false;
}

const RELOAD_CONCURRENCY = 3;

async function reloadTabTitle(tabId: number): Promise<void> {
  try {
    await chrome.tabs.reload(tabId);
  } catch {
    return;
  }
  await discardWhenLoaded(tabId);
}

// 부하 억제를 위해 동시 3개로 제한하는 간단한 비동기 풀.
async function reloadStaleTitles(tabIds: number[]): Promise<void> {
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tabIds.length) {
      const tabId = tabIds[index];
      index += 1;
      await reloadTabTitle(tabId);
    }
  }

  const workerCount = Math.min(RELOAD_CONCURRENCY, tabIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function buildGroupSpecs(
  mode: GroupMode,
  authored: PrRef[],
  reviewRequested: PrRef[],
): GroupSpec[] {
  if (mode === "single") {
    const merged = new Map<string, PrRef>();
    for (const pr of [...authored, ...reviewRequested]) {
      merged.set(prKey(pr), pr);
    }
    return [
      {
        kind: "single",
        title: getGroupTitle("single"),
        color: "blue",
        prs: Array.from(merged.values()),
      },
    ];
  }

  const authoredKeys = new Set(authored.map(prKey));
  const reviewOnly = reviewRequested.filter((pr) => !authoredKeys.has(prKey(pr)));

  return [
    {
      kind: "authored",
      title: getGroupTitle("authored"),
      color: "green",
      prs: authored,
    },
    {
      kind: "review",
      title: getGroupTitle("review"),
      color: "yellow",
      prs: reviewOnly,
    },
  ];
}

const REVIEWED_KEEP_RECHECK_LIMIT = 5;

/**
 * 직전 review-requested 목록에는 있었지만 이번엔 사라진 PR 중, "리뷰를 남겼을
 * 가능성"이 있는 후보 키를 고르는 순수 함수. authored 목록에 있는 것은
 * (내가 작성자가 됐다는 뜻이라) 리뷰 후 사라짐과는 다른 사유이므로 제외한다.
 */
export function findReviewedCandidates(
  lastReviewKeys: string[],
  currentReviewKeys: string[],
  authoredKeys: string[],
): string[] {
  const currentSet = new Set(currentReviewKeys);
  const authoredSet = new Set(authoredKeys);
  return lastReviewKeys.filter(
    (key) => !currentSet.has(key) && !authoredSet.has(key),
  );
}

/**
 * reviewedKeep 재검증 대상을 고르는 순수 함수. lastCheckedAt이 오래된 순으로
 * 최대 limit개를 반환한다(0 = fetch 실패로 아직 확인되지 않은 항목 우선).
 */
export function pickStaleReviewedKeepKeys(
  reviewedKeep: Record<string, ReviewedKeepEntry>,
  limit: number,
): string[] {
  return Object.entries(reviewedKeep)
    .sort((a, b) => a[1].lastCheckedAt - b[1].lastCheckedAt)
    .slice(0, limit)
    .map(([key]) => key);
}

/**
 * reviewedKeep 저장 항목들을 PrRef 목록으로 변환한다. url을 역파싱할 수 없는
 * (손상된) 항목은 건너뛴다.
 */
export function reviewedKeepToPrRefs(
  reviewedKeep: Record<string, ReviewedKeepEntry>,
): PrRef[] {
  const result: PrRef[] = [];
  for (const entry of Object.values(reviewedKeep)) {
    const parsed = parsePrRefFromUrl(entry.url);
    if (!parsed) continue;
    result.push({
      ...parsed,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    });
  }
  return result;
}

function mergePrLists(primary: PrRef[], extra: PrRef[]): PrRef[] {
  const merged = new Map<string, PrRef>();
  for (const pr of primary) {
    merged.set(prKey(pr), pr);
  }
  for (const pr of extra) {
    const key = prKey(pr);
    if (!merged.has(key)) {
      merged.set(key, pr);
    }
  }
  return Array.from(merged.values());
}

/**
 * PR 페이지 HTML의 embedded JSON에서(이미 fetch해 state 판별에 쓴 것을
 * 재활용) 해당 PR의 title/updatedAt을 얻을 수 있으면 채운다. 얻지 못해도
 * 안전하게 빈 값을 반환한다("얻으면 채움" - 필수 아님).
 */
function parsePrMetaFromHtml(
  html: string,
  key: string,
): { title?: string; updatedAt?: string } {
  const found = parseEmbeddedData(html).find((pr) => prKey(pr) === key);
  if (!found) return {};
  return {
    ...(found.title ? { title: found.title } : {}),
    ...(found.updatedAt ? { updatedAt: found.updatedAt } : {}),
  };
}

async function classifyReviewCandidate(
  fetchPrPageHtml: NonNullable<PrSource["fetchPrPageHtml"]>,
  ref: Pick<PrRef, "owner" | "repo" | "number">,
): Promise<{ ok: true; state: ReturnType<typeof parsePrPageState>; html: string } | { ok: false }> {
  try {
    const html = await fetchPrPageHtml(ref);
    return { ok: true, state: parsePrPageState(html), html };
  } catch {
    return { ok: false };
  }
}

/**
 * review-requested 목록에서 사라진(=리뷰를 남겼을 가능성이 있는) PR을
 * 찾아내 상태를 확인하고, 아직 열려 있으면(open/unknown) reviewedKeep에
 * 남겨 "리뷰 요청" 그룹 탭이 계속 유지되게 한다. merged/closed로 확인되면
 * 자연스럽게 그룹 diff에서 정리되도록 추가하지 않는다.
 *
 * fetch에 실패한 후보는 다음 사이클까지 탭이 잘못 닫히는 것을 막기 위해
 * lastCheckedAt=0으로 보수적으로 유지(추가)해 다음 재검증에서 최우선으로
 * 다시 확인한다.
 *
 * state.reviewedKeep / state.lastReviewKeys를 갱신하며, 그룹 diff에 합류시킬
 * PrRef 목록(review-requested + 유지 중인 PR, dedupe)을 반환한다.
 */
async function updateReviewedKeep(
  state: StoredState,
  source: PrSource,
  reviewRequested: PrRef[],
  authored: PrRef[],
  maxAgeDays: number,
  nowMs: number,
): Promise<PrRef[]> {
  const currentReviewKeys = reviewRequested.map(prKey);
  const authoredKeys = authored.map(prKey);

  const fetchPrPageHtml = source.fetchPrPageHtml;
  if (fetchPrPageHtml) {
    const candidates = findReviewedCandidates(
      state.lastReviewKeys,
      currentReviewKeys,
      authoredKeys,
    );

    for (const key of candidates) {
      const ref = parsePrKeyString(key);
      if (!ref) continue;

      const result = await classifyReviewCandidate(fetchPrPageHtml, ref);
      if (!result.ok) {
        state.reviewedKeep[key] = { url: prUrl(ref), lastCheckedAt: 0 };
        continue;
      }
      if (result.state === "merged" || result.state === "closed") {
        continue;
      }
      const meta = parsePrMetaFromHtml(result.html, key);
      state.reviewedKeep[key] = {
        url: prUrl(ref),
        lastCheckedAt: nowMs,
        ...(meta.title ? { title: meta.title } : {}),
        ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
      };
    }

    const staleKeys = pickStaleReviewedKeepKeys(
      state.reviewedKeep,
      REVIEWED_KEEP_RECHECK_LIMIT,
    );
    for (const key of staleKeys) {
      const entry = state.reviewedKeep[key];
      if (!entry) continue;
      const ref = parsePrRefFromUrl(entry.url);
      if (!ref) {
        delete state.reviewedKeep[key];
        continue;
      }

      const result = await classifyReviewCandidate(fetchPrPageHtml, ref);
      if (!result.ok) {
        // 실패: 그대로 둔다. lastCheckedAt이 여전히 가장 오래된 값이므로
        // 다음 sync의 pickStaleReviewedKeepKeys에서 다시 우선 선택된다.
        continue;
      }
      if (result.state === "merged" || result.state === "closed") {
        delete state.reviewedKeep[key];
      } else {
        const meta = parsePrMetaFromHtml(result.html, key);
        state.reviewedKeep[key] = {
          ...entry,
          lastCheckedAt: nowMs,
          ...(meta.title ? { title: meta.title } : {}),
          ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
        };
      }
    }
  }

  state.lastReviewKeys = currentReviewKeys;

  const keepPrs = filterByAge(
    reviewedKeepToPrRefs(state.reviewedKeep),
    maxAgeDays,
    nowMs,
  );
  return mergePrLists(reviewRequested, keepPrs);
}

const SUSPECT_STREAK_LIMIT = 3;

/**
 * 직전 status와 이번 fetch 결과(목록별 개수)를 바탕으로 "의심 상황"인지
 * 판단하는 순수 함수. GitHub 페이지 구조가 바뀌어 파서가 갑자기 0개를 반환하는
 * 경우, 전체 사용자가 동시에 탭을 잃는 사고를 막기 위해 연속 관측이 필요하다.
 *
 * - authored/review 중 어느 한쪽이라도 직전엔 있었는데(> 0) 이번에 0개면
 *   의심 상황이다. 두 목록을 독립적으로 검사하므로 한쪽만 갑자기 0이어도
 *   전체를 의심 처리한다.
 *   연속 3회(streak >= 3, 기본 5분 주기 기준 약 15분) 미만이면 여전히 의심 중.
 * - 연속 3회째에 도달하면 진짜 0개로 간주하고 의심을 해제한다.
 * - 어느 쪽도 "있다가 없어짐"이 아니면(둘 다 유지/증가) 스트릭을 리셋한다.
 * - 직전에 해당 목록이 이미 0개였다면 그 목록은 의심 근거가 되지 않는다.
 */
export function resolveSuspectState(
  prevStatus: SyncStatus | undefined,
  authoredCount: number,
  reviewCount: number,
): { suspect: boolean; streak: number } {
  const prevAuthored = prevStatus?.authoredCount ?? 0;
  const prevReview = prevStatus?.reviewCount ?? 0;

  const authoredDroppedToZero = prevAuthored > 0 && authoredCount === 0;
  const reviewDroppedToZero = prevReview > 0 && reviewCount === 0;

  if (!authoredDroppedToZero && !reviewDroppedToZero) {
    return { suspect: false, streak: 0 };
  }

  const streak = (prevStatus?.suspectStreak ?? 0) + 1;
  return { suspect: streak < SUSPECT_STREAK_LIMIT, streak };
}

/**
 * fetch/파싱 실패(로그아웃, HTTP 에러 등) 시의 status를 만드는 순수 함수.
 * 직전에 관측된 개수와 의심 스트릭을 그대로 유지해야, "정상 → 에러 → 0개
 * 파싱" 순서로 이어지더라도 안전장치(resolveSuspectState)가 우회되지 않는다.
 */
export function buildFailureStatus(
  prevStatus: SyncStatus,
  kind: "logged_out" | "error",
  nowMs: number,
  errorMessage?: string,
): SyncStatus {
  return {
    lastSyncAt: nowMs,
    state: kind,
    errorMessage,
    authoredCount: prevStatus.authoredCount,
    reviewCount: prevStatus.reviewCount,
    suspectStreak: prevStatus.suspectStreak,
  };
}

/**
 * 그룹 입양 후보 중 가장 적합한 groupId를 고르는 순수 함수.
 * 브라우저 재시작 등으로 저장된 groupId가 무효해졌을 때, 세션 복원으로 살아난
 * 같은 제목의 그룹 중 PR 탭을 가장 많이 담고 있는(점수가 가장 높은) 그룹을
 * "입양"해 새 그룹을 만들지 않고 재사용한다. 점수가 0인(=PR 탭이 하나도 없는,
 * 즉 사용자가 만든 동명의 다른 그룹일 가능성이 큰) 후보는 제외한다. 동점이면
 * 배열 순서상 먼저 나온 후보를 선택한다.
 */
export function pickAdoptionCandidate(
  candidates: { groupId: number; prTabCount: number }[],
): number | undefined {
  let best: { groupId: number; prTabCount: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.prTabCount < 1) continue;
    if (!best || candidate.prTabCount > best.prTabCount) {
      best = candidate;
    }
  }
  return best?.groupId;
}

/**
 * 같은 대상 PR 키를 가리키는 탭이 여러 개 남아있을 때(중복 그룹 병합 등으로
 * 발생) 하나만 남기고 나머지를 닫기 위한 순수 함수. 입력 순서상 각 키의 첫
 * 번째 탭을 유지하고, 이후 등장하는 동일 키 탭들의 id를 반환한다.
 */
export function pickDuplicateTabsToClose(
  matchedTabs: { id: number; key: string }[],
): number[] {
  const seenKeys = new Set<string>();
  const toClose: number[] = [];
  for (const { id, key } of matchedTabs) {
    if (seenKeys.has(key)) {
      toClose.push(id);
    } else {
      seenKeys.add(key);
    }
  }
  return toClose;
}

async function resolveExistingGroup(
  state: StoredState,
  spec: GroupSpec,
): Promise<number | undefined> {
  const storedGroupId = state.groupIds[spec.kind];
  if (storedGroupId !== undefined) {
    try {
      await chrome.tabGroups.get(storedGroupId);
      return storedGroupId;
    } catch {
      // 저장된 groupId가 무효하다 (브라우저 재시작으로 groupId가 바뀌는 등).
      // 아래에서 같은 제목의 그룹을 입양할 수 있는지 시도한다.
    }
  }

  // 그룹 입양: 세션 복원으로 같은 제목의 그룹이 이미 살아 있을 수 있다.
  // collapsed 여부 등 그룹의 다른 상태는 건드리지 않는다.
  let candidateGroups: chrome.tabGroups.TabGroup[];
  try {
    candidateGroups = await chrome.tabGroups.query({ title: spec.title });
  } catch {
    return undefined;
  }
  if (candidateGroups.length === 0) return undefined;

  const scored = await Promise.all(
    candidateGroups.map(async (group) => {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const prTabCount = tabs.filter((tab) => tabPrKey(tab) !== null).length;
      return { groupId: group.id, prTabCount };
    }),
  );

  return pickAdoptionCandidate(scored);
}

/**
 * 같은 제목의 다른(=primary가 아닌) 그룹이 남아있으면, 그 안의 PR 탭만
 * primary 그룹으로 옮긴다. PR 탭이 아닌 탭(사용자가 만든 동명의 그룹일 수
 * 있음)은 건드리지 않는다. 이동에 실패해도 다음 sync에서 다시 시도되므로
 * 무시한다. 이 함수는 반드시 대상 그룹의 탭 조회/diff보다 먼저 호출해, 이번
 * 사이클의 diff가 이동된 탭까지 포함하도록 한다.
 */
async function mergeDuplicateGroups(
  primaryGroupId: number,
  spec: GroupSpec,
): Promise<void> {
  let candidateGroups: chrome.tabGroups.TabGroup[];
  try {
    candidateGroups = await chrome.tabGroups.query({ title: spec.title });
  } catch {
    return;
  }

  const duplicates = candidateGroups.filter((group) => group.id !== primaryGroupId);
  if (duplicates.length === 0) return;

  for (const group of duplicates) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const prTabIds = tabs
      .filter((tab) => tab.id !== undefined && tabPrKey(tab) !== null)
      .map((tab) => tab.id as number);
    if (prTabIds.length === 0) continue;
    try {
      await chrome.tabs.group({ tabIds: prTabIds, groupId: primaryGroupId });
    } catch {
      // 이동 실패는 무시한다 (다음 sync에서 재시도됨).
    }
  }
}

/**
 * PR 키를 알 수 없는(target과 매칭되지 않는) 그룹 내 탭을 어떻게 처리할지
 * 판단하는 순수 함수. 사용자가 그룹 안에서 PR이 아닌 실제 페이지(레포 홈 등)로
 * 탐색한 탭은 탐색 중인 작업을 보호하기 위해 그룹에서 빼기만 하고, 빈 URL이나
 * about:blank처럼 깨진 잔재 탭은 그대로 닫는다.
 */
export function classifyUnmatchedTab(
  tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl">,
): "ungroup" | "close" {
  const navigatedUrl = tab.url || tab.pendingUrl;
  if (navigatedUrl && navigatedUrl.startsWith("http")) {
    return "ungroup";
  }
  return "close";
}

/**
 * 그룹 내 탭들을 정렬 목표 순서(prs 순서)에 맞춰 재배치할 tabId 순서를
 * 계산하는 순수 함수. prs의 순서가 곧 목표 탭 순서다(호출자가 미리
 * sortPrsByRecency 등으로 정렬해서 넘긴다). tabs에는 있지만 prs에 없는(이론상
 * diff 이후엔 없어야 하는) 탭은 유실 방지를 위해 끝에 그대로 붙인다.
 */
export function computeTabOrder(
  tabs: { id: number; key: string }[],
  prs: PrRef[],
): number[] {
  const tabByKey = new Map(tabs.map((tab) => [tab.key, tab.id]));
  const ordered: number[] = [];

  for (const pr of prs) {
    const key = prKey(pr);
    const id = tabByKey.get(key);
    if (id !== undefined) {
      ordered.push(id);
      tabByKey.delete(key);
    }
  }

  for (const id of tabByKey.values()) {
    ordered.push(id);
  }

  return ordered;
}

/**
 * 그룹 내 탭을 최근 활동(updatedAt) 내림차순으로 재배치한다. 그룹 탭을
 * 새로(fresh) 조회해 현재 순서와 목표 순서가 다를 때만 chrome.tabs.move를
 * 호출하고, 이동 중 그룹을 이탈할 수 있으므로 이동 후 chrome.tabs.group으로
 * 다시 그룹에 포함시킨다. 실패는 무시한다(다음 sync에서 재시도됨).
 */
async function reorderGroupTabs(groupId: number, spec: GroupSpec): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ groupId });

    const tabInfos = tabs
      .map((tab) => ({ tab, key: tabPrKey(tab) }))
      .filter(
        (info): info is { tab: chrome.tabs.Tab; key: string } =>
          info.key !== null && info.tab.id !== undefined,
      )
      .sort((a, b) => a.tab.index - b.tab.index);

    if (tabInfos.length < 2) return;

    const sortedPrs = sortPrsByRecency(spec.prs);
    const orderedTabIds = computeTabOrder(
      tabInfos.map((info) => ({ id: info.tab.id as number, key: info.key })),
      sortedPrs,
    );

    const currentOrderIds = tabInfos.map((info) => info.tab.id as number);
    const alreadyOrdered = orderedTabIds.every((id, idx) => id === currentOrderIds[idx]);
    if (alreadyOrdered) return;

    const minIndex = Math.min(...tabInfos.map((info) => info.tab.index));
    const windowId = tabInfos[0].tab.windowId;

    await chrome.tabs.move(orderedTabIds, { index: minIndex, windowId });
    // 이동 중 그룹을 이탈할 수 있으므로 다시 그룹에 확실히 포함시킨다.
    await chrome.tabs.group({ tabIds: orderedTabIds, groupId });
  } catch {
    // 실패는 무시한다 (다음 sync에서 재시도됨).
  }
}

async function syncGroup(state: StoredState, spec: GroupSpec): Promise<void> {
  const targetMap = new Map(spec.prs.map((pr) => [prKey(pr), pr]));
  let groupId = await resolveExistingGroup(state, spec);

  let groupWindowId: number | undefined;
  const existingKeys = new Set<string>();

  if (groupId !== undefined) {
    // 저장된 id가 무효해 새로 입양한 groupId일 수 있으므로, 이후 로직이
    // 조기 반환되더라도(예: 대상 PR이 이미 모두 매칭된 경우) 최신 groupId가
    // 반드시 저장되도록 여기서 즉시 반영한다.
    state.groupIds[spec.kind] = groupId;

    // 세션 복원 등으로 같은 제목의 중복 그룹이 남아 있으면, 그 안의 PR 탭이
    // 이번 사이클의 diff에 포함되도록 탭 조회 전에 먼저 primary로 병합한다.
    await mergeDuplicateGroups(groupId, spec);

    await chrome.tabGroups.update(groupId, {
      title: spec.title,
      color: spec.color,
    });
    const tabs = await chrome.tabs.query({ groupId });
    const staleTabIds: number[] = [];
    const ungroupTabIds: number[] = [];
    const reloadCandidateTabIds: number[] = [];
    const matchedTabs: { tab: chrome.tabs.Tab; key: string }[] = [];
    for (const tab of tabs) {
      if (tab.windowId !== undefined) groupWindowId = tab.windowId;
      const key = tabPrKey(tab);
      if (key) {
        if (targetMap.has(key)) {
          matchedTabs.push({ tab, key });
        } else if (tab.id !== undefined) {
          // 머지/닫힌 PR 등 더 이상 대상이 아닌 탭
          staleTabIds.push(tab.id);
        }
        continue;
      }

      if (tab.id === undefined) continue;
      if (classifyUnmatchedTab(tab) === "ungroup") {
        // PR 링크가 아닌 실제 페이지로 탐색한 탭은 사용자 작업을 보호하기
        // 위해 닫지 않고 그룹에서만 뺀다.
        ungroupTabIds.push(tab.id);
      } else {
        // 빈 URL, about:blank 등 깨진 잔재 탭은 정리한다.
        staleTabIds.push(tab.id);
      }
    }

    // 중복 그룹 병합 등으로 같은 PR 키의 탭이 여러 개 남아 있으면 하나만
    // 남기고 나머지는 닫는다.
    const duplicateTabIds = new Set(
      pickDuplicateTabsToClose(
        matchedTabs
          .filter((m) => m.tab.id !== undefined)
          .map((m) => ({ id: m.tab.id as number, key: m.key })),
      ),
    );
    for (const { tab, key } of matchedTabs) {
      if (tab.id !== undefined && duplicateTabIds.has(tab.id)) {
        staleTabIds.push(tab.id);
        continue;
      }
      existingKeys.add(key);
      if (needsTitleReload(tab) && tab.id !== undefined) {
        reloadCandidateTabIds.push(tab.id);
      }
    }

    if (staleTabIds.length > 0) {
      await chrome.tabs.remove(staleTabIds);
    }
    if (ungroupTabIds.length > 0) {
      await chrome.tabs.ungroup(ungroupTabIds);
    }
    if (reloadCandidateTabIds.length > 0) {
      // 예전 즉시-discard 로직으로 제목이 비어있는 탭을 백그라운드로 재로드한다.
      // sync 전체를 막지 않도록 fire-and-forget으로 처리한다.
      void reloadStaleTitles(reloadCandidateTabIds);
    }
  }

  const missing = spec.prs.filter((pr) => !existingKeys.has(prKey(pr)));

  if (missing.length === 0) {
    if (spec.prs.length === 0 && groupId !== undefined) {
      delete state.groupIds[spec.kind];
    } else if (groupId !== undefined) {
      await reorderGroupTabs(groupId, spec);
    }
    return;
  }

  let windowId: number;
  if (groupWindowId !== undefined) {
    windowId = groupWindowId;
  } else {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id === undefined) {
      throw new Error(
        getMessage("noUsableWindow", "No usable Chrome window was found."),
      );
    }
    windowId = win.id;
  }

  const tabIdsToGroup: number[] = [];
  const newlyCreatedTabIds: number[] = [];

  for (const pr of missing) {
    const key = prKey(pr);
    const ungrouped = await chrome.tabs.query({ url: "https://github.com/*" });
    const existingTab = ungrouped.find(
      (tab) =>
        tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && tabPrKey(tab) === key,
    );

    let tabId: number | undefined;
    if (existingTab?.id !== undefined) {
      tabId = existingTab.id;
    } else {
      const created = await chrome.tabs.create({
        url: prUrl(pr),
        active: false,
        windowId,
      });
      tabId = created.id;
      if (tabId !== undefined) newlyCreatedTabIds.push(tabId);
    }

    if (tabId !== undefined) {
      tabIdsToGroup.push(tabId);
    }
  }

  if (tabIdsToGroup.length === 0) {
    if (groupId !== undefined) {
      await reorderGroupTabs(groupId, spec);
    }
    return;
  }

  let resultGroupId: number | undefined;
  if (groupId !== undefined) {
    try {
      resultGroupId = await chrome.tabs.group({ tabIds: tabIdsToGroup, groupId });
    } catch {
      resultGroupId = undefined;
    }
  }

  if (resultGroupId === undefined) {
    resultGroupId = await chrome.tabs.group({
      tabIds: tabIdsToGroup,
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(resultGroupId, {
      title: spec.title,
      color: spec.color,
    });
  }

  state.groupIds[spec.kind] = resultGroupId;

  // 로드가 끝나 제목이 잡힐 때까지 기다렸다가 discard해야 하므로 동기화 전체를
  // 막지 않도록 fire-and-forget으로 처리한다.
  for (const tabId of newlyCreatedTabIds) {
    void discardWhenLoaded(tabId);
  }

  await reorderGroupTabs(resultGroupId, spec);
}

async function cleanupUnusedGroups(
  state: StoredState,
  usedKinds: GroupKind[],
): Promise<void> {
  const usedSet = new Set(usedKinds);
  for (const kind of ALL_KINDS) {
    if (usedSet.has(kind)) continue;
    const groupId = state.groupIds[kind];
    if (groupId === undefined) continue;
    try {
      const tabs = await chrome.tabs.query({ groupId });
      const tabIds = tabs
        .map((tab) => tab.id)
        .filter((id): id is number => id !== undefined);
      if (tabIds.length > 0) {
        await chrome.tabs.remove(tabIds);
      }
    } catch {
      // 그룹이 이미 사라진 경우 무시
    } finally {
      delete state.groupIds[kind];
    }
  }
}

const REVIEW_BADGE_COLOR = "#d29922";

/**
 * 대기 중인(pending) 리뷰 요청 개수를 툴바 뱃지에 반영한다. "리뷰한 PR
 * 유지"로 그룹에 남아있는 PR은 더 이상 조치가 필요 없으므로 뱃지 개수에
 * 포함하지 않는다(순수하게 pending 개수만). 뱃지 API 실패는 무시한다.
 */
async function updateBadge(pendingReviewCount: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({
      text: pendingReviewCount > 0 ? String(pendingReviewCount) : "",
    });
    await chrome.action.setBadgeBackgroundColor({ color: REVIEW_BADGE_COLOR });
  } catch {
    // 일부 환경에서 배지 API를 쓸 수 없을 수 있다 - 무시한다.
  }
}

async function performSync(source: PrSource): Promise<SyncStatus> {
  const settings = await loadSettings();
  const state = await loadState();

  let status: SyncStatus;

  try {
    const [authoredRaw, reviewRequestedRaw] = await Promise.all([
      source.fetchAuthored(),
      source.fetchReviewRequested(),
    ]);

    const authoredNoDrafts = excludeDraftPrs(authoredRaw, settings.excludeDrafts);
    const reviewNoDrafts = excludeDraftPrs(reviewRequestedRaw, settings.excludeDrafts);

    const now = Date.now();
    const authored = filterByAge(authoredNoDrafts, settings.maxAgeDays, now);
    const reviewRequested = filterByAge(reviewNoDrafts, settings.maxAgeDays, now);

    const { suspect, streak } = resolveSuspectState(
      state.status,
      authored.length,
      reviewRequested.length,
    );

    if (suspect) {
      // 갑작스러운 0개는 파서/페이지 구조 변경을 의심할 상황이다. 연속 관측이
      // 쌓이기 전까지는 그룹/탭을 일절 건드리지 않고 기존 개수만 유지한다.
      // reviewedKeep/lastReviewKeys도 오탐 방지를 위해 여기서 건드리지 않는다.
      status = {
        lastSyncAt: now,
        state: "suspect",
        suspectStreak: streak,
        authoredCount: state.status.authoredCount,
        reviewCount: state.status.reviewCount,
      };
      state.status = status;
      await saveState(state);
      return status;
    }

    let reviewGroupPrs = reviewRequested;
    if (settings.keepReviewedPrs) {
      reviewGroupPrs = await updateReviewedKeep(
        state,
        source,
        reviewRequested,
        authored,
        settings.maxAgeDays,
        now,
      );
    } else {
      state.reviewedKeep = {};
      state.lastReviewKeys = reviewRequested.map(prKey);
    }

    const specs = buildGroupSpecs(settings.groupMode, authored, reviewGroupPrs);

    for (const spec of specs) {
      await syncGroup(state, spec);
    }

    await cleanupUnusedGroups(
      state,
      specs.map((spec) => spec.kind),
    );

    status = {
      lastSyncAt: Date.now(),
      state: "ok",
      authoredCount: authored.length,
      // pending 리뷰 요청 개수만(유지 중인 PR은 제외) - 뱃지와 동일한 수치.
      reviewCount: reviewRequested.length,
    };

    await updateBadge(reviewRequested.length);
  } catch (err) {
    const nowMs = Date.now();
    if (err instanceof LoggedOutError) {
      status = buildFailureStatus(state.status, "logged_out", nowMs);
    } else {
      status = buildFailureStatus(
        state.status,
        "error",
        nowMs,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  state.status = status;
  await saveState(state);
  return status;
}

// 동시에 여러 트리거(alarm, 팝업 버튼, 시작 시 자동 sync 등)가 겹쳐도 중복
// 실행되지 않도록, 이미 진행 중인 sync가 있으면 그 Promise를 그대로 반환한다.
let inFlight: Promise<SyncStatus> | null = null;

export function syncAll(source: PrSource = new CookiePrSource()): Promise<SyncStatus> {
  if (inFlight) {
    return inFlight;
  }

  const promise = performSync(source).finally(() => {
    inFlight = null;
  });
  inFlight = promise;
  return promise;
}
