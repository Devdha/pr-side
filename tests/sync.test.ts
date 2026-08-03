import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFailureStatus,
  classifyUnmatchedTab,
  needsTitleReload,
  pickAdoptionCandidate,
  pickDuplicateTabsToClose,
  resolveSuspectState,
  syncAll,
} from "../src/lib/sync.js";
import type { SyncStatus } from "../src/lib/types.js";

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
