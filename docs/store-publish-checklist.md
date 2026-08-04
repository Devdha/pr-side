# Chrome Web Store 공개 체크리스트 (쿠키 기반 유지)

작성: 2026-08-03. 쿠키 기반 데이터 소스를 유지한 채 공개하기로 결정.

## 심사 통과에 필요한 것

- [x] **아이콘**: 16/32/48/128px PNG (`manifest.json`의 `icons` + `action.default_icon`).
  GitHub 로고·옥토캣 등 상표 요소 사용 금지.
- [x] **스토어 등록 정보 초안** (`docs/store-listing.md`)
  - 이름: "PR Side – GitHub PR Tabs" (설명에 "unofficial" 명시)
  - 단일 목적(single purpose) 설명: "GitHub PR을 크롬 탭 그룹으로 자동 정리"
  - `https://github.com/*` host permission 사용 사유: "로그인된 사용자의 PR 목록 페이지를
    GitHub에서 HTTPS로 가져와 탭 그룹을 구성하기 위해 필요. PR 정보는 개발자 서버나
    광고·분석 서비스로 전송되지 않음"
- [ ] **개인정보 공시 (Privacy tab)**
  - 처리 항목: `Website content`, `Web history` (GitHub PR 페이지와 열린 GitHub PR 탭의
    제목·URL을 기능 수행 목적으로 브라우저 안에서 처리)
  - GitHub 비밀번호·인증 쿠키 값은 읽거나 저장하지 않으므로 `Authentication information`은
    선택하지 않음
  - PR 정보는 개발자 서버로 전송하지 않음. 사용자 설정은 `chrome.storage.sync`를 통해
    Chrome 동기화 대상이 될 수 있음
  - Limited Use 서약 체크
  - [x] 개인정보처리방침 문서 작성 (`PRIVACY.md`)
  - [x] `https://prside.102lab.com/privacy/`에 공개 게시
  - [ ] Chrome Web Store Privacy tab의 Privacy policy URL에 위 주소 입력
- [x] **스크린샷** 1280x800 영문·한글, 라이트·다크 4장 (`store-assets/screenshots/`)
- [x] **프로모션 이미지** 공용 무문자 PNG 2장 (`store-assets/promotional/`)
  - 필수 소형 타일: `small-promo-440x280.png`
  - 선택형 마키 타일: `marquee-promo-1400x560.png`

## 쿠키 기반 유지에 따른 필수 방어책 (코드)

- [x] HTTP 에러(429/500) 시 동기화 중단 - 탭 오삭제 방지
- [x] 로그아웃 감지 → 안내 표시, 탭 유지
- [x] **갑작스러운 0개 결과 안전장치**: 직전 동기화에 PR이 있었는데 이번에 0개면
  탭을 지우지 않고 "형식 변경 의심" 상태로 유예, 3회 연속(15분)일 때만 실제 반영
- [x] 파서 다중 전략: 구형 앵커 + embeddedData GraphQL 노드 + 신형 permalink 아이템

## 운영 리스크와 대응

- GitHub 페이지 개편 시 전체 사용자 동시 파손 → 안전장치로 탭 보존 + 신속한 파서
  패치 업데이트 배포. 파서는 `src/lib/parser.ts`에 격리되어 있어 수정 범위가 작음.
- GitHub이 자동화 접근을 문제 삼는 경우(가능성 낮음) → `PrSource` 어댑터를 OAuth로
  교체하는 플랜 B가 설계에 반영되어 있음 (`docs/plans/2026-08-03-pr-tab-groups-design.md`).
- 원격 코드 금지 정책: 원격 설정/코드 로딩을 절대 추가하지 말 것 (심사 거절 사유).
