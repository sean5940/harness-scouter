<!-- template: conventions/v1.0 -->
---
doc-type: conventions
template-version: conventions/v1.0
created: 2026-08-16
last-reviewed: 2026-08-16
status: active
project: harness-scouter
stack: node-typescript
input-docs: []
related: []
supersedes: null
superseded-by: null
---

# harness-scouter — Coding Conventions

살아있는 문서. 글로벌 스택 컨벤션을 상속하고 프로젝트별 오버라이드만 명시.

## 1. 글로벌 상속

**상속할 스택 문서가 없다.** `~/.ai-config/stacks/` 에는 `_detect.md` 와 `flutter` 만 있고
node-typescript 스택 지식은 아직 만들어지지 않았다. 그래서 이 문서가 상속본이 아니라 원본이다.

상속하는 것은 스택과 무관한 글로벌 규칙뿐이다:

- `~/.ai-config/AGENTS.global.md` — 언어, 검색 도구, 산출물 처리, 문체
- `~/.ai-config/references/korean-writing-style.md` — 한국어 산출물 문체
- `~/.ai-config/references/coding-principles.md` — 가정 명시·최소 코드·외과적 변경·목표 주도

## 2. 명명 규약

| 대상            | 패턴                     | 예시                                     | 비고                                          |
| --------------- | ------------------------ | ---------------------------------------- | --------------------------------------------- |
| 파일            | camelCase `.ts`          | `statHtml.ts` · `worktype.ts`            | 여러 낱말이면 붙여 쓴다                       |
| 테스트 파일     | `<대상>.test.ts`         | `gate-judging.test.ts`                   | 회귀 테스트는 `-regression` 접미              |
| 타입·인터페이스 | PascalCase               | `GateVerdict` · `AxisPlaceboEffect`      |                                               |
| 함수            | camelCase 동사구         | `runGate` · `placeboStrata`              |                                               |
| 판정 상수       | SCREAMING_SNAKE          | `SPLIT_HALF_PASS` · `PERIOD_SESSION_CAP` | 화면 둘 이상이 쓰면 반드시 `core` 에서 export |
| 축 키           | camelCase                | `readScope` · `indexedRetrieval`         | `AXIS_ORDER` 가 순서의 원본                   |
| 화면 문자열     | `L(ko, en)` 로 한 자리에 | `L("길이 교란", "Length confound")`      | 언어별 카탈로그 파일로 빼지 않는다            |

## 3. 파일·폴더 구조 규약

- `core` 는 런타임 의존성을 갖지 않는다. 새 의존성을 넣기 전에 내장 모듈로 되는지 먼저 본다.
- 점수·판정을 만드는 코드는 `core` 에만 둔다. `cli`·`mcp`·`ext` 는 받아서 그리기만 한다.
- `core/src/*.test.ts` 는 그 파일 옆에, 여러 모듈을 걸치는 테스트는 `core/test/` 에 둔다.
- `probe/` 는 일회성 계측 스크립트다. 제품 코드가 여기를 import 하지 않는다.

## 4. 임포트·의존성 규약

- ESM 전용(`"type": "module"`). 상대 임포트는 확장자 `.js` 를 붙인다(`./gate.js`).
- 패키지 간 참조는 워크스페이스 이름으로(`@harness-scouter/core`), 상대 경로로 넘지 않는다.
- `core/src/index.ts` 가 `export *` 로 공개면을 만든다. 새 모듈은 여기 등록해야 밖에서 보인다.
- 화면 둘 이상이 같은 수를 적어야 하면 상수를 export 해서 쓴다. 숫자를 두 자리에 적지 않는다.

## 5. 테스트 규약

- 러너: vitest (`npm test` = `vitest run`)
- 단위 테스트 위치: `packages/<pkg>/src/<대상>.test.ts`
- 통합·회귀 테스트 위치: `packages/core/test/`
- 네이밍 패턴: `describe` 와 `it` 모두 한글 서술문. "무엇을 하면 무엇이 된다" 꼴로 적는다.
- 커버리지 목표: 수치 목표 없음. 대신 **판정을 바꾸는 코드에는 아는 답이 있는 세계를 만든다.**
  실측에서 숫자가 좋아지는 것은 검증이 아니다. 원인이 있는 세계와 없는 세계를 따로 만들어
  앞에서만 반응하는지 본다(`stratifiedSplitHalf.test.ts` 가 본보기).
- 픽스처에 `as` 캐스트를 쓰지 않는다. 타입이 늘 때 tsc 가 막아야 한다.

## 6. 커밋·PR 규약

- 커밋 메시지: Conventional Commits + 한글 본문. 제목은 마침표 없이 `fix(gate): ...` 꼴.
- 한 커밋 = 한 책임. 무관한 재포맷을 섞지 않는다.
- 본문에는 **무엇을 고쳤는지가 아니라 왜 그것이 결함인지**를 적는다. 재현 조건과 실측값을 남긴다.
- 공동 작업 표기: `Co-Authored-By:` 로 남긴다. `Signed-off-by:` 는 이 저장소 이력에 없다.
- 머지 정책: **rebase.** 이력에 머지 커밋이 하나도 없는 선형 구조를 유지한다.
- PR 템플릿 없음. 본문에 결함·근거·검증·안 고친 것을 적는다.
- 자동 커밋 금지. 사용자가 건별로 위임할 때만 커밋한다.

## 7. 글로벌 컨벤션과의 차이

| 항목        | 글로벌                      | 이 프로젝트                                                     | 근거                        |
| ----------- | --------------------------- | --------------------------------------------------------------- | --------------------------- |
| 산출물 언어 | 한글                        | README는 한/영/일 3종 유지                                      | 공개 저장소                 |
| 스택 지식   | `~/.ai-config/stacks/` 상속 | 상속 없음                                                       | node-typescript 스택 미작성 |
| 이모지      | 금지                        | 동일                                                            | —                           |
| 한자 혼용   | 금지                        | 한국어 산출물에 한해 동일. `README.ja.md` 는 일본어라 해당 없음 | —                           |

## N. Notes

- 머지 전 로컬에서 도는 것: `npm run build` · `npm test` · `npm run check:format` · `npm run check:docs`
- PR을 검사하는 CI가 없다. 위 넷은 사람이 돌려야 하고, 안 돌리면 아무도 안 잡는다.
- `check:docs` 는 코퍼스가 있어야 도는 검사 2건을 포함한다. 코퍼스 없는 환경의 실패 2건은 정상이다.
