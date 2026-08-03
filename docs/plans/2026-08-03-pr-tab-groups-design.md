# PR Tab Groups 크롬 익스텐션 설계

날짜: 2026-08-03

## 목표

Arc 브라우저의 고정 탭 폴더처럼, 내가 올린 PR과 내가 리뷰어로 등록된 PR을
크롬 탭 그룹으로 자동 관리하는 익스텐션.

## 결정 사항

- **인증**: 쿠키 기반(비공식) 우선. github.com HTML을 세션 쿠키로 fetch해서 파싱.
  파서/데이터 소스는 어댑터 인터페이스로 분리해 실패 시 OAuth 어댑터로 교체 가능하게 한다.
- **동기화**: `chrome.alarms` 주기 자동(기본 5분) + 팝업의 수동 동기화 버튼.
- **탭 정리**: 머지/닫힌 PR의 탭은 자동으로 닫는다.
- **그룹 구성**: 설정으로 선택 - 통합 "PR" 그룹 1개 또는 "내 PR" / "리뷰 요청" 2개(기본: 2개).

## 아키텍처 (Manifest V3)

- `manifest.json` - permissions: `tabs`, `tabGroups`, `storage`, `alarms`,
  host_permissions: `https://github.com/*`
- **background service worker** - 동기화 엔진 (alarm + 팝업 메시지 트리거)
- **popup** - 지금 동기화 버튼, 마지막 동기화 시각, 로그인 상태, PR 개수
- **options** - 그룹 모드, 동기화 주기

## 데이터 흐름

1. 트리거 → `https://github.com/pulls?q=is%3Aopen+is%3Apr+author%3A%40me` 와
   `review-requested%3A%40me` 쿼리 2회 fetch (`credentials: "include"`)
2. HTML에서 `/owner/repo/pull/123` 링크를 정규식으로 추출
   (service worker에는 DOMParser가 없음 → 정규식 파싱, 어댑터로 분리)
3. 관리 중인 탭 그룹의 탭과 diff
4. 새 PR → `tabs.create({active:false})` 후 그룹에 추가, 즉시 `tabs.discard`로 메모리 절약.
   사라진 PR → 탭 닫기. 이미 열린 같은 PR 탭은 그룹으로 이동만.
5. 그룹 ID·탭↔PR 매핑은 `chrome.storage.local`, 설정은 `chrome.storage.sync`에 저장

## 인증 폴백

- 응답 최종 URL이 `/login`으로 리다이렉트되면 로그아웃 상태로 판단, 팝업에 안내 표시
- 쿠키 방식이 막히면 `chrome.identity.launchWebAuthFlow` 기반 OAuth 어댑터를 추가 (후속 작업)

## 엣지 케이스

- 사용자가 그룹/탭을 직접 닫음 → 다음 동기화 때 재생성 (그룹은 항상 현재 상태 반영)
- 그룹이 있던 창이 닫힘 → 마지막 포커스된 일반 창에 재생성
- PR 탭에서 `/files` 등 하위 경로로 이동한 탭은 같은 PR로 취급 (pull 번호 prefix 매칭)
- 활성 탭이 stale이어도 스펙대로 닫는다

## 기술 스택

- TypeScript, vanilla (프레임워크 없음)
- esbuild로 번들 (`build.mjs`), 정적 파일 복사 → `dist/`를 unpacked로 로드
- vitest - 파서·로그아웃 감지 등 순수 함수 단위 테스트 (fixture HTML)
