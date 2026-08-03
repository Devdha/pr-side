import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFailureStatus,
  classifyUnmatchedTab,
  computeTabOrder,
  findReviewedCandidates,
  needsTitleReload,
  pickAdoptionCandidate,
  pickDuplicateTabsToClose,
  pickStaleReviewedKeepKeys,
  resolveSuspectState,
  reviewedKeepToPrRefs,
  syncAll,
  type ReviewedKeepEntry,
} from "../src/lib/sync.js";
import type { PrRef, SyncStatus } from "../src/lib/types.js";

describe("needsTitleReload", () => {
  it("discard되지 않은 탭은 false", () => {
    expect(
      needsTitleReload({
        discarded: false,
        title: "fix: use native browser find",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(false);
  });

  it("title이 없으면 true", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(true);
    expect(
      needsTitleReload({
        discarded: true,
        title: undefined,
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(true);
  });

  it("title이 url과 같으면 true", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "https://github.com/octocat/hello-world/pull/1",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(true);
  });

  it("title이 'https://'로 시작하면 true", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "https://github.com/octocat/hello-world/pull/1?tab=files",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(true);
  });

  it("정상 제목이면 false", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "fix: use native browser find",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(false);
  });

  it("title이 'github.com/o/r/pull/1' 형태(host+path)면 true", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "github.com/octocat/hello-world/pull/1",
        url: "https://github.com/octocat/hello-world/pull/1",
        pendingUrl: undefined,
      }),
    ).toBe(true);
  });

  it("url이 없고 pendingUrl만 있어도 동일 기준으로 판단한다", () => {
    expect(
      needsTitleReload({
        discarded: true,
        title: "github.com/octocat/hello-world/pull/1",
        url: undefined,
        pendingUrl: "https://github.com/octocat/hello-world/pull/1",
      }),
    ).toBe(true);
  });
});

describe("syncAll localized group titles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes existing group titles from the current Chrome locale", async () => {
    const update = vi.fn(async () => undefined);
    const localSet = vi.fn(async () => undefined);
    const tabsByGroup: Record<number, chrome.tabs.Tab[]> = {
      11: [
        {
          id: 101,
          index: 0,
          pinned: false,
          highlighted: false,
          active: false,
          incognito: false,
          selected: false,
          discarded: false,
          autoDiscardable: true,
          groupId: 11,
          windowId: 1,
          url: "https://github.com/octocat/hello-world/pull/1",
          title: "Authored PR",
        },
      ],
      12: [
        {
          id: 102,
          index: 1,
          pinned: false,
          highlighted: false,
          active: false,
          incognito: false,
          selected: false,
          discarded: false,
          autoDiscardable: true,
          groupId: 12,
          windowId: 1,
          url: "https://github.com/octocat/hello-world/pull/2",
          title: "Review PR",
        },
      ],
    };

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 30,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: { authored: 11, review: 12 },
              status: { state: "ok" },
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async (groupId: number) => ({ id: groupId }),
        update,
      },
      tabs: {
        query: async ({ groupId }: chrome.tabs.QueryInfo) =>
          groupId === undefined ? [] : tabsByGroup[groupId] ?? [],
        remove: async () => undefined,
      },
    });

    const source = {
      fetchAuthored: async () => [
        { owner: "octocat", repo: "hello-world", number: 1 },
      ],
      fetchReviewRequested: async () => [
        { owner: "octocat", repo: "hello-world", number: 2 },
      ],
    };

    const status = await syncAll(source);

    expect(status.state).toBe("ok");
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 11, {
      title: "My PRs",
      color: "green",
    });
    expect(update).toHaveBeenNthCalledWith(2, 12, {
      title: "Review requests",
      color: "yellow",
    });
    expect(localSet).toHaveBeenCalledOnce();
  });
});

describe("resolveSuspectState", () => {
  it("직전에 PR이 있었는데 이번에 둘 다 0개면 의심 상황(1회차)이다", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 5, reviewCount: 2 };
    const result = resolveSuspectState(prev, 0, 0);
    expect(result).toEqual({ suspect: true, streak: 1 });
  });

  it("연속 3회째(streak>=3)에 도달하면 의심을 해제하고 정상 진행한다", () => {
    const prev: SyncStatus = {
      state: "suspect",
      authoredCount: 5,
      reviewCount: 2,
      suspectStreak: 2,
    };
    const result = resolveSuspectState(prev, 0, 0);
    expect(result).toEqual({ suspect: false, streak: 3 });
  });

  it("직전에도 둘 다 0개였다면 의심하지 않는다(정상)", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 0, reviewCount: 0 };
    const result = resolveSuspectState(prev, 0, 0);
    expect(result).toEqual({ suspect: false, streak: 0 });
  });

  it("둘 다 유지/증가하면 스트릭을 리셋한다", () => {
    const prev: SyncStatus = {
      state: "suspect",
      authoredCount: 5,
      reviewCount: 2,
      suspectStreak: 1,
    };
    const result = resolveSuspectState(prev, 3, 2);
    expect(result).toEqual({ suspect: false, streak: 0 });
  });

  it("직전 status가 없어도 이번이 0개면 의심하지 않는다(기준선이 없음)", () => {
    const result = resolveSuspectState(undefined, 0, 0);
    expect(result).toEqual({ suspect: false, streak: 0 });
  });

  it("authored만 갑자기 0이어도 의심 상황이다 (review는 유지)", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 5, reviewCount: 2 };
    const result = resolveSuspectState(prev, 0, 2);
    expect(result).toEqual({ suspect: true, streak: 1 });
  });

  it("review만 갑자기 0이어도 의심 상황이다 (authored는 유지)", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 5, reviewCount: 2 };
    const result = resolveSuspectState(prev, 5, 0);
    expect(result).toEqual({ suspect: true, streak: 1 });
  });

  it("직전에 이미 0이었던 목록은 그 자체로는 의심 근거가 되지 않지만, 다른 목록이 새로 0이 되면 여전히 의심한다", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 0, reviewCount: 5 };
    const result = resolveSuspectState(prev, 0, 0);
    expect(result).toEqual({ suspect: true, streak: 1 });
  });
});

describe("buildFailureStatus", () => {
  it("직전 개수와 스트릭을 유지한 채 logged_out 상태를 만든다", () => {
    const prev: SyncStatus = {
      state: "ok",
      authoredCount: 5,
      reviewCount: 2,
      suspectStreak: 1,
    };
    const result = buildFailureStatus(prev, "logged_out", 1000);
    expect(result).toEqual({
      lastSyncAt: 1000,
      state: "logged_out",
      authoredCount: 5,
      reviewCount: 2,
      suspectStreak: 1,
    });
  });

  it("error 상태에는 errorMessage를 포함하고 직전 개수를 유지한다", () => {
    const prev: SyncStatus = { state: "ok", authoredCount: 3, reviewCount: 1 };
    const result = buildFailureStatus(prev, "error", 2000, "network down");
    expect(result).toEqual({
      lastSyncAt: 2000,
      state: "error",
      errorMessage: "network down",
      authoredCount: 3,
      reviewCount: 1,
    });
  });

  it("직전 counts/streak이 없으면 undefined 그대로 유지한다", () => {
    const prev: SyncStatus = { state: "ok" };
    const result = buildFailureStatus(prev, "error", 3000, "boom");
    expect(result).toEqual({
      lastSyncAt: 3000,
      state: "error",
      errorMessage: "boom",
    });
    expect(result.authoredCount).toBeUndefined();
    expect(result.reviewCount).toBeUndefined();
    expect(result.suspectStreak).toBeUndefined();
  });
});

describe("classifyUnmatchedTab", () => {
  it("http(s)로 시작하는 실제 페이지는 ungroup", () => {
    expect(
      classifyUnmatchedTab({
        url: "https://github.com/octocat/hello-world",
        pendingUrl: undefined,
      }),
    ).toBe("ungroup");
  });

  it("pendingUrl이 http로 시작해도 ungroup", () => {
    expect(
      classifyUnmatchedTab({
        url: undefined,
        pendingUrl: "http://github.com/octocat/hello-world",
      }),
    ).toBe("ungroup");
  });

  it("빈 URL은 close", () => {
    expect(classifyUnmatchedTab({ url: "", pendingUrl: undefined })).toBe("close");
  });

  it("about:blank는 close", () => {
    expect(
      classifyUnmatchedTab({ url: "about:blank", pendingUrl: undefined }),
    ).toBe("close");
  });

  it("url/pendingUrl이 둘 다 없으면 close", () => {
    expect(classifyUnmatchedTab({ url: undefined, pendingUrl: undefined })).toBe(
      "close",
    );
  });
});

describe("syncAll tab classification for unmatched tabs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PR이 아닌 실제 페이지 탭은 ungroup하고, 깨진/머지된 탭은 닫는다", async () => {
    const remove = vi.fn(async () => undefined);
    const ungroup = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const localSet = vi.fn(async () => undefined);

    const tabsInGroup: chrome.tabs.Tab[] = [
      {
        // 매칭되는 PR: 유지
        id: 201,
        index: 0,
        pinned: false,
        highlighted: false,
        active: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: 21,
        windowId: 1,
        url: "https://github.com/octocat/hello-world/pull/1",
        title: "fix: something",
      },
      {
        // PR 링크가 아닌 실제 페이지: ungroup 대상
        id: 202,
        index: 1,
        pinned: false,
        highlighted: false,
        active: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: 21,
        windowId: 1,
        url: "https://github.com/octocat/hello-world",
        title: "octocat/hello-world",
      },
      {
        // 빈 URL(깨진 잔재 탭): 닫기 대상
        id: 203,
        index: 2,
        pinned: false,
        highlighted: false,
        active: false,
        incognito: false,
        selected: false,
        discarded: true,
        autoDiscardable: true,
        groupId: 21,
        windowId: 1,
        url: "",
        title: "",
      },
      {
        // 머지/닫힌 PR(target에 없음): 닫기 대상
        id: 204,
        index: 3,
        pinned: false,
        highlighted: false,
        active: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: 21,
        windowId: 1,
        url: "https://github.com/octocat/hello-world/pull/99",
        title: "merged PR",
      },
    ];

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 30,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: { authored: 21 },
              status: { state: "ok", authoredCount: 1, reviewCount: 0 },
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async (groupId: number) => ({ id: groupId }),
        update,
      },
      tabs: {
        query: async ({ groupId }: chrome.tabs.QueryInfo) =>
          groupId === 21 ? tabsInGroup : [],
        remove,
        ungroup,
      },
    });

    const source = {
      fetchAuthored: async () => [
        { owner: "octocat", repo: "hello-world", number: 1 },
      ],
      fetchReviewRequested: async () => [],
    };

    const status = await syncAll(source);

    expect(status.state).toBe("ok");
    expect(ungroup).toHaveBeenCalledTimes(1);
    expect(ungroup).toHaveBeenCalledWith([202]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([203, 204]);
  });
});

describe("syncAll concurrency guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("진행 중일 때 다시 호출하면 같은 Promise를 반환하고 중복 fetch하지 않는다", async () => {
    const localSet = vi.fn(async () => undefined);
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetchAuthored = vi.fn(async () => {
      await gate;
      return [];
    });
    const fetchReviewRequested = vi.fn(async () => []);

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 30,
            },
          }),
        },
        local: {
          get: async () => ({
            state: { groupIds: {}, status: { state: "ok" } },
          }),
          set: localSet,
        },
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1 },
      tabs: {},
    });

    const source = { fetchAuthored, fetchReviewRequested };

    const first = syncAll(source);
    const second = syncAll(source);

    // 두 번째 호출은 진행 중인 첫 번째 Promise를 그대로 반환해야 한다(동일 객체).
    // performSync는 호출마다 새 Promise를 만들므로, 이 동일성만으로도 내부에서
    // 두 번째 fetch가 트리거되지 않았음이 보장된다.
    expect(second).toBe(first);

    releaseFetch?.();
    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(firstStatus).toBe(secondStatus);
    expect(fetchAuthored).toHaveBeenCalledTimes(1);
    expect(fetchReviewRequested).toHaveBeenCalledTimes(1);

    // 이전 호출이 끝났으니 다음 호출은 다시 fetch를 트리거해야 한다.
    const third = syncAll(source);
    expect(third).not.toBe(first);
    await third;
    expect(fetchAuthored).toHaveBeenCalledTimes(2);
  });
});

describe("pickAdoptionCandidate", () => {
  it("PR 탭이 하나도 없는(점수 0) 후보뿐이면 undefined를 반환한다", () => {
    expect(
      pickAdoptionCandidate([
        { groupId: 10, prTabCount: 0 },
        { groupId: 11, prTabCount: 0 },
      ]),
    ).toBeUndefined();
  });

  it("점수가 가장 높은 후보를 선택한다", () => {
    expect(
      pickAdoptionCandidate([
        { groupId: 10, prTabCount: 1 },
        { groupId: 11, prTabCount: 3 },
        { groupId: 12, prTabCount: 2 },
      ]),
    ).toBe(11);
  });

  it("동점이면 배열상 먼저 나온 후보를 선택한다", () => {
    expect(
      pickAdoptionCandidate([
        { groupId: 20, prTabCount: 2 },
        { groupId: 21, prTabCount: 2 },
      ]),
    ).toBe(20);
  });

  it("후보가 없으면 undefined를 반환한다", () => {
    expect(pickAdoptionCandidate([])).toBeUndefined();
  });

  it("점수 0인 후보는 점수가 있는 다른 후보가 있어도 제외된다", () => {
    expect(
      pickAdoptionCandidate([
        { groupId: 30, prTabCount: 0 },
        { groupId: 31, prTabCount: 1 },
      ]),
    ).toBe(31);
  });
});

describe("pickDuplicateTabsToClose", () => {
  it("같은 키가 없으면 아무것도 닫지 않는다", () => {
    expect(
      pickDuplicateTabsToClose([
        { id: 1, key: "o/r#1" },
        { id: 2, key: "o/r#2" },
      ]),
    ).toEqual([]);
  });

  it("같은 키의 탭 중 첫 번째만 남기고 나머지를 닫는다", () => {
    expect(
      pickDuplicateTabsToClose([
        { id: 1, key: "o/r#1" },
        { id: 2, key: "o/r#1" },
        { id: 3, key: "o/r#1" },
      ]),
    ).toEqual([2, 3]);
  });

  it("여러 키가 섞여 있어도 키별로 독립적으로 처리한다", () => {
    expect(
      pickDuplicateTabsToClose([
        { id: 1, key: "o/r#1" },
        { id: 2, key: "o/r#2" },
        { id: 3, key: "o/r#1" },
        { id: 4, key: "o/r#2" },
      ]),
    ).toEqual([3, 4]);
  });

  it("입력이 비어있으면 빈 배열을 반환한다", () => {
    expect(pickDuplicateTabsToClose([])).toEqual([]);
  });
});

describe("syncAll group adoption and merge on restart", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("무효해진 groupId 대신 같은 제목의 그룹을 입양하고, 중복 그룹의 PR 탭을 병합·중복 제거한다", async () => {
    const remove = vi.fn(async () => undefined);
    const ungroup = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const localSet = vi.fn(async (_value: unknown) => undefined);

    const makeTab = (
      id: number,
      groupId: number,
      url: string,
    ): chrome.tabs.Tab => ({
      id,
      index: 0,
      pinned: false,
      highlighted: false,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId,
      windowId: 1,
      url,
      title: "some title",
    });

    // group 10: 이미 PR#1 탭 하나만 담고 있는 "정상" 후보.
    // group 20: 세션 복원으로 남은 중복 그룹 — 같은 PR#1 탭(중복) + PR이 아닌
    // 사용자 탭을 함께 담고 있다.
    const tabA = makeTab(301, 10, "https://github.com/octocat/hello-world/pull/1");
    const tabB = makeTab(302, 20, "https://github.com/octocat/hello-world/pull/1");
    const tabC = makeTab(303, 20, "https://github.com/octocat/hello-world");

    const tabsByGroup: Record<number, chrome.tabs.Tab[]> = {
      10: [tabA],
      20: [tabB, tabC],
    };

    const group = vi.fn(
      async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        const targetGroupId = groupId as number;
        for (const tabId of tabIds) {
          for (const gidKey of Object.keys(tabsByGroup)) {
            const gid = Number(gidKey);
            const list = tabsByGroup[gid];
            const idx = list.findIndex((t) => t.id === tabId);
            if (idx !== -1) {
              const [moved] = list.splice(idx, 1);
              moved.groupId = targetGroupId;
              tabsByGroup[targetGroupId] = tabsByGroup[targetGroupId] ?? [];
              tabsByGroup[targetGroupId].push(moved);
              break;
            }
          }
        }
        return targetGroupId;
      },
    );

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 30,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              // 저장된 groupId(999)는 브라우저 재시작으로 더 이상 존재하지 않는다.
              groupIds: { authored: 999 },
              status: { state: "ok", authoredCount: 1, reviewCount: 0 },
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async (groupId: number) => {
          if (groupId === 999) {
            throw new Error("No group with id: 999");
          }
          return { id: groupId };
        },
        update,
        query: async ({ title }: { title: string }) => {
          if (title !== "My PRs") return [];
          return [
            { id: 10, windowId: 1, title, color: "green", collapsed: false },
            { id: 20, windowId: 1, title, color: "green", collapsed: false },
          ];
        },
      },
      tabs: {
        query: async ({ groupId }: chrome.tabs.QueryInfo) =>
          groupId === undefined ? [] : (tabsByGroup[groupId] ?? []),
        remove,
        ungroup,
        group,
      },
    });

    const source = {
      fetchAuthored: async () => [
        { owner: "octocat", repo: "hello-world", number: 1 },
      ],
      fetchReviewRequested: async () => [],
    };

    const status = await syncAll(source);

    expect(status.state).toBe("ok");

    // 병합: group 20의 PR 탭(tabB)만 primary(group 10)로 이동. 비-PR 탭(tabC)은
    // 건드리지 않는다.
    expect(group).toHaveBeenCalledTimes(1);
    expect(group).toHaveBeenCalledWith({ tabIds: [302], groupId: 10 });

    // 중복 제거: 같은 PR#1 키의 tabA/tabB 중 나중에 처리된 tabB(302)만 닫는다.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([302]);

    // tabC(비-PR 탭)는 group/remove/ungroup 어디에도 등장하지 않는다.
    expect(group.mock.calls.flatMap((call) => call[0].tabIds)).not.toContain(303);
    expect(remove.mock.calls.flat().flat()).not.toContain(303);
    expect(ungroup).not.toHaveBeenCalled();

    // 입양된 group 10이 새 primary로 저장된다.
    const savedState = localSet.mock.calls[0]?.[0] as {
      state: { groupIds: Record<string, number> };
    };
    expect(savedState.state.groupIds.authored).toBe(10);
  });
});

function pr(overrides: Partial<PrRef> = {}): PrRef {
  return {
    owner: "octocat",
    repo: "hello-world",
    number: 1,
    ...overrides,
  };
}

describe("computeTabOrder", () => {
  it("prs 순서대로 tabId를 반환한다", () => {
    const tabs = [
      { id: 101, key: "octocat/hello-world#1" },
      { id: 102, key: "octocat/hello-world#2" },
      { id: 103, key: "octocat/hello-world#3" },
    ];
    const prs = [
      pr({ number: 3 }),
      pr({ number: 1 }),
      pr({ number: 2 }),
    ];
    expect(computeTabOrder(tabs, prs)).toEqual([103, 101, 102]);
  });

  it("prs에 없는 남은 탭은 유실 방지를 위해 끝에 붙인다", () => {
    const tabs = [
      { id: 101, key: "octocat/hello-world#1" },
      { id: 102, key: "octocat/hello-world#2" },
    ];
    const prs = [pr({ number: 2 })];
    expect(computeTabOrder(tabs, prs)).toEqual([102, 101]);
  });

  it("빈 입력이면 빈 배열을 반환한다", () => {
    expect(computeTabOrder([], [])).toEqual([]);
  });
});

describe("findReviewedCandidates", () => {
  it("직전엔 있었는데 이번엔 사라졌고 authored에도 없는 키를 후보로 고른다", () => {
    const result = findReviewedCandidates(
      ["o/r#1", "o/r#2", "o/r#3"],
      ["o/r#2"],
      [],
    );
    expect(result).toEqual(["o/r#1", "o/r#3"]);
  });

  it("여전히 review 목록에 있는 키는 후보에서 제외한다", () => {
    const result = findReviewedCandidates(["o/r#1"], ["o/r#1"], []);
    expect(result).toEqual([]);
  });

  it("authored로 옮겨간 키는 후보에서 제외한다", () => {
    const result = findReviewedCandidates(["o/r#1", "o/r#2"], [], ["o/r#1"]);
    expect(result).toEqual(["o/r#2"]);
  });

  it("직전 목록이 비어있으면 후보도 없다", () => {
    expect(findReviewedCandidates([], ["o/r#1"], [])).toEqual([]);
  });
});

describe("pickStaleReviewedKeepKeys", () => {
  function entry(lastCheckedAt: number): ReviewedKeepEntry {
    return { url: "https://github.com/o/r/pull/1", lastCheckedAt };
  }

  it("lastCheckedAt이 오래된 순으로 최대 limit개를 반환한다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      "o/r#1": entry(300),
      "o/r#2": entry(100),
      "o/r#3": entry(200),
    };
    expect(pickStaleReviewedKeepKeys(reviewedKeep, 2)).toEqual(["o/r#2", "o/r#3"]);
  });

  it("항목이 limit보다 적으면 전부 반환한다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      "o/r#1": entry(100),
    };
    expect(pickStaleReviewedKeepKeys(reviewedKeep, 5)).toEqual(["o/r#1"]);
  });

  it("빈 맵이면 빈 배열을 반환한다", () => {
    expect(pickStaleReviewedKeepKeys({}, 5)).toEqual([]);
  });

  it("lastCheckedAt=0(fetch 실패)인 항목이 최우선으로 선택된다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      "o/r#1": entry(999),
      "o/r#2": entry(0),
    };
    expect(pickStaleReviewedKeepKeys(reviewedKeep, 1)).toEqual(["o/r#2"]);
  });
});

describe("reviewedKeepToPrRefs", () => {
  it("url을 owner/repo/number로 역파싱하고 title/updatedAt을 채운다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      "octocat/hello-world#1": {
        url: "https://github.com/octocat/hello-world/pull/1",
        title: "fix: something",
        updatedAt: "2026-07-01T00:00:00Z",
        lastCheckedAt: 100,
      },
    };
    expect(reviewedKeepToPrRefs(reviewedKeep)).toEqual([
      {
        owner: "octocat",
        repo: "hello-world",
        number: 1,
        title: "fix: something",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("title/updatedAt이 없어도 owner/repo/number만으로 변환한다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      "octocat/hello-world#2": {
        url: "https://github.com/octocat/hello-world/pull/2",
        lastCheckedAt: 100,
      },
    };
    expect(reviewedKeepToPrRefs(reviewedKeep)).toEqual([
      { owner: "octocat", repo: "hello-world", number: 2 },
    ]);
  });

  it("url을 역파싱할 수 없는 손상된 항목은 건너뛴다", () => {
    const reviewedKeep: Record<string, ReviewedKeepEntry> = {
      broken: { url: "not-a-valid-url", lastCheckedAt: 0 },
    };
    expect(reviewedKeepToPrRefs(reviewedKeep)).toEqual([]);
  });

  it("빈 맵이면 빈 배열을 반환한다", () => {
    expect(reviewedKeepToPrRefs({})).toEqual([]);
  });
});

describe("syncAll keepReviewedPrs integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("review-requested에서 사라진 PR이 아직 open이면 리뷰 요청 그룹에 유지하고 탭을 만든다", async () => {
    const localSet = vi.fn(async (_value: unknown) => undefined);
    const createdTabs: { url: string }[] = [];
    let nextTabId = 500;

    const prPageHtml = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
      {
        node: {
          __typename: "PullRequest",
          number: 2,
          repository: { name: "hello-world", owner: { login: "octocat" } },
          state: "OPEN",
          titleHtml: "fix: reviewed PR",
          updatedAt: "2026-07-15T00:00:00Z",
        },
      },
    )}</script>`;

    const fetchPrPageHtml = vi.fn(async () => prPageHtml);
    const setBadgeText = vi.fn(async () => undefined);
    const setBadgeBackgroundColor = vi.fn(async () => undefined);

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: true,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: {},
              // status.reviewCount는 lastReviewKeys와 독립적인 필드다. 0으로
              // 두어 resolveSuspectState의 "직전>0 → 이번 0" 의심 판정이 이
              // 테스트에서는 트리거되지 않게 한다(suspect 경로는 별도로
              // 검증됨).
              status: { state: "ok", authoredCount: 0, reviewCount: 0 },
              reviewedKeep: {},
              lastReviewKeys: ["octocat/hello-world#2"],
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        query: async () => [],
        update: async () => undefined,
      },
      tabs: {
        query: async () => [],
        create: async ({ url }: { url: string }) => {
          createdTabs.push({ url });
          const id = nextTabId++;
          return { id, url };
        },
        group: async () => 900,
        remove: async () => undefined,
        ungroup: async () => undefined,
      },
      windows: {
        getLastFocused: async () => ({ id: 1 }),
      },
      action: { setBadgeText, setBadgeBackgroundColor },
    });

    const source = {
      fetchAuthored: async () => [],
      fetchReviewRequested: async () => [], // PR#2가 사라짐(리뷰를 남겼을 가능성)
      fetchPrPageHtml,
    };

    const status = await syncAll(source);

    expect(status.state).toBe("ok");
    // pending 리뷰 요청 개수만(유지 중인 PR 제외)
    expect(status.reviewCount).toBe(0);

    expect(fetchPrPageHtml).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      number: 2,
    });

    expect(createdTabs).toContainEqual({
      url: "https://github.com/octocat/hello-world/pull/2",
    });

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });

    const savedState = localSet.mock.calls[0]?.[0] as {
      state: {
        reviewedKeep: Record<string, { title?: string; updatedAt?: string }>;
        lastReviewKeys: string[];
      };
    };
    const kept = savedState.state.reviewedKeep["octocat/hello-world#2"];
    expect(kept).toBeDefined();
    expect(kept.title).toBe("fix: reviewed PR");
    expect(kept.updatedAt).toBe("2026-07-15T00:00:00Z");
    expect(savedState.state.lastReviewKeys).toEqual([]);
  });

  it("재검증에서 merged/closed로 확인되면 reviewedKeep에서 제거한다", async () => {
    const localSet = vi.fn(async (_value: unknown) => undefined);

    const mergedHtml = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
      { node: { __typename: "PullRequest", number: 3, state: "MERGED" } },
    )}</script>`;
    const fetchPrPageHtml = vi.fn(async () => mergedHtml);

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: true,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: {},
              status: { state: "ok", authoredCount: 0, reviewCount: 0 },
              reviewedKeep: {
                "octocat/hello-world#3": {
                  url: "https://github.com/octocat/hello-world/pull/3",
                  lastCheckedAt: 0,
                },
              },
              lastReviewKeys: [],
            },
          }),
          set: localSet,
        },
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => undefined },
      tabs: {
        query: async () => [],
        create: async () => ({ id: 1 }),
        group: async () => 1,
        remove: async () => undefined,
        ungroup: async () => undefined,
      },
      windows: { getLastFocused: async () => ({ id: 1 }) },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
    });

    const source = {
      fetchAuthored: async () => [],
      fetchReviewRequested: async () => [],
      fetchPrPageHtml,
    };

    await syncAll(source);

    expect(fetchPrPageHtml).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      number: 3,
    });

    const savedState = localSet.mock.calls[0]?.[0] as {
      state: { reviewedKeep: Record<string, unknown> };
    };
    expect(savedState.state.reviewedKeep["octocat/hello-world#3"]).toBeUndefined();
  });

  it("keepReviewedPrs가 false면 reviewedKeep을 전부 비우고 후보 fetch를 건너뛴다", async () => {
    const localSet = vi.fn(async (_value: unknown) => undefined);
    const fetchPrPageHtml = vi.fn(async () => "<html></html>");

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: false,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: {},
              status: { state: "ok", authoredCount: 0, reviewCount: 0 },
              reviewedKeep: {
                "octocat/hello-world#9": {
                  url: "https://github.com/octocat/hello-world/pull/9",
                  lastCheckedAt: 100,
                },
              },
              lastReviewKeys: ["octocat/hello-world#2"],
            },
          }),
          set: localSet,
        },
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => undefined },
      tabs: { query: async () => [], remove: async () => undefined, ungroup: async () => undefined },
      windows: { getLastFocused: async () => ({ id: 1 }) },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
    });

    const source = {
      fetchAuthored: async () => [],
      fetchReviewRequested: async () => [],
      fetchPrPageHtml,
    };

    await syncAll(source);

    expect(fetchPrPageHtml).not.toHaveBeenCalled();

    const savedState = localSet.mock.calls[0]?.[0] as {
      state: { reviewedKeep: Record<string, unknown> };
    };
    expect(savedState.state.reviewedKeep).toEqual({});
  });
});

describe("syncAll toolbar badge", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubChromeForBadge(reviewCount: number) {
    return {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: false,
            },
          }),
        },
        local: {
          get: async () => ({
            state: { groupIds: {}, status: { state: "ok" } },
          }),
          set: vi.fn(async () => undefined),
        },
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => undefined },
      tabs: {
        query: async () => [],
        create: async () => ({ id: 1 }),
        group: async () => 1,
        remove: async () => undefined,
        ungroup: async () => undefined,
      },
      windows: { getLastFocused: async () => ({ id: 1 }) },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
    };
  }

  it("성공 시 pending 리뷰 요청 개수를 배지 텍스트로 설정한다", async () => {
    const chromeStub = stubChromeForBadge(3);
    vi.stubGlobal("chrome", chromeStub);

    const source = {
      fetchAuthored: async () => [],
      fetchReviewRequested: async () => [
        { owner: "o", repo: "r", number: 1 },
        { owner: "o", repo: "r", number: 2 },
        { owner: "o", repo: "r", number: 3 },
      ],
    };

    await syncAll(source);

    expect(chromeStub.action.setBadgeText).toHaveBeenCalledWith({ text: "3" });
    expect(chromeStub.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: "#d29922",
    });
  });

  it("리뷰 요청이 0개면 배지 텍스트를 비운다", async () => {
    const chromeStub = stubChromeForBadge(0);
    vi.stubGlobal("chrome", chromeStub);

    const source = { fetchAuthored: async () => [], fetchReviewRequested: async () => [] };

    await syncAll(source);

    expect(chromeStub.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("에러/로그아웃 상태에서는 배지를 건드리지 않는다", async () => {
    const chromeStub = stubChromeForBadge(0);
    vi.stubGlobal("chrome", chromeStub);

    const source = {
      fetchAuthored: async () => {
        throw new Error("network down");
      },
      fetchReviewRequested: async () => [],
    };

    const status = await syncAll(source);

    expect(status.state).toBe("error");
    expect(chromeStub.action.setBadgeText).not.toHaveBeenCalled();
    expect(chromeStub.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });
});

describe("syncGroup reorders tabs by recency", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("최근 활동 내림차순으로 다르면 chrome.tabs.move 후 다시 그룹에 포함시킨다", async () => {
    const move = vi.fn(async (tabIds: number[]) => tabIds);
    const group = vi.fn(async () => 11);
    const update = vi.fn(async () => undefined);
    const localSet = vi.fn(async (_value: unknown) => undefined);

    const makeTab = (
      id: number,
      index: number,
      url: string,
    ): chrome.tabs.Tab => ({
      id,
      index,
      pinned: false,
      highlighted: false,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: 11,
      windowId: 1,
      url,
      title: "some title",
    });

    // 저장 순서(=현재 탭 순서)는 PR#1, PR#2지만 PR#2가 더 최근이라
    // 목표 순서는 PR#2, PR#1이어야 한다.
    const tabPr1 = makeTab(201, 0, "https://github.com/octocat/hello-world/pull/1");
    const tabPr2 = makeTab(202, 1, "https://github.com/octocat/hello-world/pull/2");

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: false,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: { authored: 11 },
              status: { state: "ok", authoredCount: 2, reviewCount: 0 },
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async (groupId: number) => ({ id: groupId }),
        query: async () => [],
        update,
      },
      tabs: {
        query: async ({ groupId }: chrome.tabs.QueryInfo) =>
          groupId === 11 ? [tabPr1, tabPr2] : [],
        remove: async () => undefined,
        ungroup: async () => undefined,
        move,
        group,
      },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
    });

    const source = {
      fetchAuthored: async () => [
        { owner: "octocat", repo: "hello-world", number: 1, updatedAt: "2026-07-01T00:00:00Z" },
        { owner: "octocat", repo: "hello-world", number: 2, updatedAt: "2026-07-20T00:00:00Z" },
      ],
      fetchReviewRequested: async () => [],
    };

    const status = await syncAll(source);

    expect(status.state).toBe("ok");
    expect(move).toHaveBeenCalledWith([202, 201], { index: 0, windowId: 1 });
    expect(group).toHaveBeenCalledWith({ tabIds: [202, 201], groupId: 11 });
  });

  it("이미 목표 순서와 같으면 chrome.tabs.move를 호출하지 않는다", async () => {
    const move = vi.fn(async (tabIds: number[]) => tabIds);
    const update = vi.fn(async () => undefined);
    const localSet = vi.fn(async (_value: unknown) => undefined);

    const makeTab = (
      id: number,
      index: number,
      url: string,
    ): chrome.tabs.Tab => ({
      id,
      index,
      pinned: false,
      highlighted: false,
      active: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: 11,
      windowId: 1,
      url,
      title: "some title",
    });

    // PR#2(최근)가 이미 먼저, PR#1(오래됨)이 나중 - 이미 목표 순서와 같다.
    const tabPr2 = makeTab(202, 0, "https://github.com/octocat/hello-world/pull/2");
    const tabPr1 = makeTab(201, 1, "https://github.com/octocat/hello-world/pull/1");

    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({ groupAuthored: "My PRs", groupReview: "Review requests" })[key] ?? "",
        getUILanguage: () => "en-US",
      },
      storage: {
        sync: {
          get: async () => ({
            settings: {
              groupMode: "split",
              syncIntervalMinutes: 5,
              maxAgeDays: 0,
              excludeDrafts: false,
              keepReviewedPrs: false,
            },
          }),
        },
        local: {
          get: async () => ({
            state: {
              groupIds: { authored: 11 },
              status: { state: "ok", authoredCount: 2, reviewCount: 0 },
            },
          }),
          set: localSet,
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        get: async (groupId: number) => ({ id: groupId }),
        query: async () => [],
        update,
      },
      tabs: {
        query: async ({ groupId }: chrome.tabs.QueryInfo) =>
          groupId === 11 ? [tabPr2, tabPr1] : [],
        remove: async () => undefined,
        ungroup: async () => undefined,
        move,
      },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
      },
    });

    const source = {
      fetchAuthored: async () => [
        { owner: "octocat", repo: "hello-world", number: 1, updatedAt: "2026-07-01T00:00:00Z" },
        { owner: "octocat", repo: "hello-world", number: 2, updatedAt: "2026-07-20T00:00:00Z" },
      ],
      fetchReviewRequested: async () => [],
    };

    await syncAll(source);

    expect(move).not.toHaveBeenCalled();
  });
});
