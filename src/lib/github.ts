import { isLoggedOut, parsePullsHtml } from "./parser.js";
import { getMessage } from "./i18n.js";
import { prUrl, type PrRef } from "./types.js";

export class LoggedOutError extends Error {
  constructor(
    message = getMessage(
      "githubLoggedOutError",
      "Your GitHub session has expired.",
    ),
  ) {
    super(message);
    this.name = "LoggedOutError";
  }
}

export interface PrSource {
  fetchAuthored(): Promise<PrRef[]>;
  fetchReviewRequested(): Promise<PrRef[]>;
  /**
   * 단일 PR 페이지의 HTML을 가져온다. "리뷰한 PR 유지" 기능이 후보 PR의
   * open/merged/closed 상태를 확인하는 데 사용한다. 선택적(optional)으로 둬서
   * 이 기능을 지원하지 않는(또는 테스트용) PrSource 구현이 있어도 되게 한다.
   */
  fetchPrPageHtml?(pr: { owner: string; repo: string; number: number }): Promise<string>;
}

// github.com/pulls는 섹션형 대시보드로 바뀌어 ?q= 검색을 무시한다.
// 대신 사이드바 전용 라우트가 각 목록을 서버에서 embed해준다.
const AUTHORED_URL = "https://github.com/pulls/authored";
const REVIEW_REQUESTED_URL = "https://github.com/pulls/reviews";

export class CookiePrSource implements PrSource {
  async fetchAuthored(): Promise<PrRef[]> {
    return this.fetchQuery(AUTHORED_URL);
  }

  async fetchReviewRequested(): Promise<PrRef[]> {
    return this.fetchQuery(REVIEW_REQUESTED_URL);
  }

  private async fetchQuery(url: string): Promise<PrRef[]> {
    const response = await fetch(url, { credentials: "include" });
    const html = await response.text();

    if (isLoggedOut(response.url, html)) {
      throw new LoggedOutError();
    }

    // 에러 페이지(429/500 등)를 빈 PR 목록으로 오인해 탭을 전부 닫는 것을 방지한다.
    if (!response.ok) {
      throw new Error(
        getMessage(
          "githubHttpError",
          `GitHub request failed (HTTP ${response.status})`,
          String(response.status),
        ),
      );
    }

    return parsePullsHtml(html);
  }

  async fetchPrPageHtml(pr: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<string> {
    const response = await fetch(prUrl(pr), { credentials: "include" });
    if (!response.ok) {
      throw new Error(
        getMessage(
          "githubHttpError",
          `GitHub request failed (HTTP ${response.status})`,
          String(response.status),
        ),
      );
    }
    return response.text();
  }
}
