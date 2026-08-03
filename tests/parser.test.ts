import { describe, expect, it } from "vitest";
import { isLoggedOut, parseEmbeddedData, parsePullsHtml } from "../src/lib/parser.js";

describe("parsePullsHtml", () => {
  it("여러 PR 링크를 추출한다", () => {
    const html = `
      <a href="/octocat/hello-world/pull/1">Fix bug</a>
      <a href="/octocat/hello-world/pull/2">Add feature</a>
      <a href="/another-owner/repo-two/pull/42">Refactor module</a>
    `;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(3);
    expect(prs).toContainEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 1,
      title: "Fix bug",
    });
    expect(prs).toContainEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 2,
      title: "Add feature",
    });
    expect(prs).toContainEqual({
      owner: "another-owner",
      repo: "repo-two",
      number: 42,
      title: "Refactor module",
    });
  });

  it("동일 PR을 dedupe한다", () => {
    const html = `
      <a href="/octocat/hello-world/pull/1">Fix bug</a>
      <a href="/octocat/hello-world/pull/1">Fix bug</a>
      <a href="/octocat/hello-world/pull/1/files">Fix bug (files)</a>
    `;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      owner: "octocat",
      repo: "hello-world",
      number: 1,
    });
  });

  it("fragment가 붙은 href도 동일 PR로 취급한다", () => {
    const html = `
      <a href="/octocat/hello-world/pull/7#issuecomment-12345">jump to comment</a>
      <a href="/octocat/hello-world/pull/7">Main PR link</a>
    `;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(7);
  });

  it("앵커 내부 텍스트에서 태그를 제거해 title로 사용한다", () => {
    const html = `<a href="/octocat/hello-world/pull/9"><span class="text">Add <strong>bold</strong> text</span></a>`;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0].title).toBe("Add bold text");
  });

  it("title이 비어 있으면 생략한다", () => {
    const html = `<a href="/octocat/hello-world/pull/9"></a>`;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0].title).toBeUndefined();
  });

  it("PR이 아닌 링크는 무시한다", () => {
    const html = `
      <a href="/octocat/hello-world/issues/5">An issue</a>
      <a href="/octocat/hello-world/pulls">Pulls list</a>
      <a href="/octocat/hello-world">Repo home</a>
      <a href="/octocat/hello-world/pull/3">Real PR</a>
    `;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(3);
  });
});

describe("parseEmbeddedData", () => {
  // 대시보드(github.com/pulls) 스타일: data.search.edges[*].node
  const dashboardFixture = {
    payload: {
      preloadedQueries: [
        {
          queryName: "PullsDashboardListQuery",
          result: {
            data: {
              search: {
                edges: [
                  {
                    node: {
                      __typename: "PullRequest",
                      number: 101,
                      repository: {
                        name: "hello-world",
                        owner: { login: "octocat", id: "O_1" },
                        id: "R_1",
                        isPrivate: false,
                      },
                      titleHtml: "Fix <em>critical</em> bug",
                      state: "OPEN",
                    },
                  },
                  {
                    node: {
                      __typename: "Issue",
                      number: 55,
                      repository: {
                        name: "hello-world",
                        owner: { login: "octocat" },
                      },
                      titleHtml: "Some unrelated issue",
                      state: "OPEN",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  };

  // 레포 페이지 스타일: data.repository.search.edges[*].node
  const repoPageFixture = {
    payload: {
      preloadedQueries: [
        {
          queryName: "RepositoryPullsQuery",
          result: {
            data: {
              repository: {
                search: {
                  edges: [
                    {
                      node: {
                        __typename: "PullRequest",
                        number: 202,
                        repository: {
                          name: "repo-two",
                          owner: { login: "another-owner" },
                        },
                        titleHtml: "Refactor module",
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  };

  function embedScript(payload: unknown): string {
    return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script>`;
  }

  it("data.search.edges 경로의 PR 노드를 추출하고 Issue는 제외한다", () => {
    const html = embedScript(dashboardFixture);
    const prs = parseEmbeddedData(html);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 101,
      title: "Fix critical bug",
    });
  });

  it("data.repository.search.edges 경로의 PR 노드도 추출한다", () => {
    const html = embedScript(repoPageFixture);
    const prs = parseEmbeddedData(html);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      owner: "another-owner",
      repo: "repo-two",
      number: 202,
      title: "Refactor module",
    });
  });

  it("여러 script 블록을 합쳐서 파싱하고, 깨진 JSON 블록은 무시한다", () => {
    const html = [
      embedScript(dashboardFixture),
      // data-target 속성 순서가 다른 경우도 매치돼야 한다
      `<script data-target="react-app.embeddedData" type="application/json">${JSON.stringify(repoPageFixture)}</script>`,
      `<script type="application/json" data-target="react-app.embeddedData">{not valid json,,,}</script>`,
    ].join("\n");

    const prs = parseEmbeddedData(html);
    expect(prs).toHaveLength(2);
    const numbers = prs.map((pr) => pr.number).sort();
    expect(numbers).toEqual([101, 202]);
  });

  it("embeddedData 블록이 없으면 빈 배열을 반환한다", () => {
    expect(parseEmbeddedData("<html><body>no data here</body></html>")).toEqual([]);
  });
});

describe("parsePullsHtml with embedded data", () => {
  const dashboardFixture = {
    payload: {
      preloadedQueries: [
        {
          queryName: "PullsDashboardListQuery",
          result: {
            data: {
              search: {
                edges: [
                  {
                    node: {
                      __typename: "PullRequest",
                      number: 17178,
                      repository: {
                        name: "react",
                        owner: { login: "react" },
                      },
                      titleHtml: "Bug: outer Suspense boundary <em>flicker</em>",
                      state: "OPEN",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  };

  it("앵커가 없는 React 렌더링 HTML에서도 embeddedData로 PR을 추출한다", () => {
    const html = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(dashboardFixture)}</script>`;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      owner: "react",
      repo: "react",
      number: 17178,
      title: "Bug: outer Suspense boundary flicker",
    });
  });

  it("앵커 파싱 결과와 embeddedData 결과를 병합해 dedupe한다", () => {
    const html = `
      <a href="/octocat/hello-world/pull/1">Anchor title</a>
      <script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
        node: {
          __typename: "PullRequest",
          number: 2,
          repository: { name: "hello-world", owner: { login: "octocat" } },
          titleHtml: "From embedded data",
        },
      })}</script>
    `;
    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(2);
    expect(prs).toContainEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 1,
      title: "Anchor title",
    });
    expect(prs).toContainEqual({
      owner: "octocat",
      repo: "hello-world",
      number: 2,
      title: "From embedded data",
    });
  });
});

describe("isLoggedOut", () => {
  it("최종 URL이 login으로 시작하면 true", () => {
    expect(isLoggedOut("https://github.com/login", "<html></html>")).toBe(true);
    expect(
      isLoggedOut("https://github.com/login?return_to=%2Fpulls", "<html></html>"),
    ).toBe(true);
  });

  it("본문에 로그인 폼(action=/session)이 있으면 true", () => {
    const html = `<form action="/session" method="post">...</form>`;
    expect(isLoggedOut("https://github.com/pulls", html)).toBe(true);
  });

  it("정상 케이스에서는 false", () => {
    const html = `<div class="pull-request-list">...</div>`;
    expect(isLoggedOut("https://github.com/pulls?q=is%3Aopen", html)).toBe(false);
  });
});

describe("parsePullsHtml - 신형 pulls 대시보드 (permalink 아이템)", () => {
  const dashboardHtml = `
    <html><body>
    <script type="application/json" data-target="react-app.embeddedData">
    {"payload":{"sectionReviewRequestedBlocking":{"results":[
      {"itemType":"pull_request","permalink":"https://github.com/example-org/example-app/pull/42",
       "repoNameWithOwner":"example-org/example-app","number":42,
       "title":"fix: improve search behavior","titleHtml":"fix: improve <em>search</em> behavior",
       "displayState":"OPEN","updatedAt":"2026-07-30T12:00:00Z"},
      {"itemType":"pull_request","permalink":"https://github.com/acme/widgets/pull/7",
       "repoNameWithOwner":"acme/widgets","number":7,"title":"Add widget"},
      {"itemType":"issue","permalink":"https://github.com/acme/widgets/issues/9",
       "repoNameWithOwner":"acme/widgets","number":9,"title":"Not a PR"}
    ]}}}
    </script>
    </body></html>`;

  it("permalink 기반 아이템에서 PR을 추출한다", () => {
    const prs = parsePullsHtml(dashboardHtml);
    expect(prs).toContainEqual({
      owner: "example-org",
      repo: "example-app",
      number: 42,
      title: "fix: improve search behavior",
      updatedAt: "2026-07-30T12:00:00Z",
    });
    expect(prs).toContainEqual({
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "Add widget",
    });
  });

  it("issue 아이템과 PR이 아닌 permalink는 제외한다", () => {
    const prs = parsePullsHtml(dashboardHtml);
    expect(prs).toHaveLength(2);
    expect(prs.some((p) => p.number === 9)).toBe(false);
  });

  it("updatedAt이 없으면 createdAt으로 대체한다", () => {
    const html = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
      {
        payload: {
          sectionAuthored: {
            results: [
              {
                itemType: "pull_request",
                permalink: "https://github.com/octocat/hello-world/pull/3",
                repoNameWithOwner: "octocat/hello-world",
                number: 3,
                title: "No updatedAt field",
                createdAt: "2026-06-01T00:00:00Z",
              },
            ],
          },
        },
      },
    )}</script>`;

    const prs = parsePullsHtml(html);
    expect(prs).toHaveLength(1);
    expect(prs[0].updatedAt).toBe("2026-06-01T00:00:00Z");
  });
});
