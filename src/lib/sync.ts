import { filterByAge } from "./filter.js";
import { CookiePrSource, LoggedOutError, type PrSource } from "./github.js";
import { getGroupTitle, getMessage } from "./i18n.js";
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

interface StoredState {
  groupIds: Partial<Record<GroupKind, number>>;
  status: SyncStatus;
}

const STORAGE_KEY = "state";

async function loadState(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<StoredState> | undefined;
  return {
    groupIds: value?.groupIds ?? {},
    status: value?.status ?? { state: "ok" },
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

function prKeyFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = TAB_URL_RE.exec(url);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  return prKey({ owner, repo, number: Number.parseInt(numberStr, 10) });
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

async function performSync(source: PrSource): Promise<SyncStatus> {
  const settings = await loadSettings();
  const state = await loadState();

  let status: SyncStatus;

  try {
    const [authoredRaw, reviewRequestedRaw] = await Promise.all([
      source.fetchAuthored(),
      source.fetchReviewRequested(),
    ]);

    const now = Date.now();
    const authored = filterByAge(authoredRaw, settings.maxAgeDays, now);
    const reviewRequested = filterByAge(reviewRequestedRaw, settings.maxAgeDays, now);

    const { suspect, streak } = resolveSuspectState(
      state.status,
      authored.length,
      reviewRequested.length,
    );

    if (suspect) {
      // 갑작스러운 0개는 파서/페이지 구조 변경을 의심할 상황이다. 연속 관측이
      // 쌓이기 전까지는 그룹/탭을 일절 건드리지 않고 기존 개수만 유지한다.
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

    const specs = buildGroupSpecs(settings.groupMode, authored, reviewRequested);

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
      reviewCount: reviewRequested.length,
    };
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
