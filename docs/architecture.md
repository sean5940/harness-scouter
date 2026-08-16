<!-- template: project-architecture/v1.0 -->
---
doc-type: project-architecture
template-version: project-architecture/v1.0
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

# harness-scouter — Architecture

살아있는 문서. `/document-release`가 코드 변경에 맞춰 갱신.

## 1. 스택 선언

- 스택: node-typescript (npm workspaces 모노레포)
- 글로벌 기본 참조: **없음.** `~/.ai-config/stacks/` 에는 `_detect.md` 와 `flutter` 만 있고
  node-typescript 스택 지식은 아직 없다. 그래서 이 문서가 상속 없이 단독으로 선다.
- 정확한 버전:
  - Node `>=22.5.0` (`node:sqlite` 내장 모듈을 쓰므로 하한이 진짜 하한이다)
  - TypeScript `^5.7.2` — `tsc --build` 프로젝트 참조로 워크스페이스를 묶는다
  - vitest `^2.1.8` · prettier `^3.9.6` · tsx `^4.19.2` · @types/node `^22.10.0`
  - 런타임 의존성 0개. `@harness-scouter/core` 를 참조하는 내부 의존만 있다.

## 2. 글로벌 기본값 오버라이드

| 영역           | 글로벌 기본                         | 이 프로젝트 결정                             | 근거                                         |
| -------------- | ----------------------------------- | -------------------------------------------- | -------------------------------------------- |
| 스택 지식 상속 | `~/.ai-config/stacks/<stack>/` 참조 | 상속 없음. 이 문서가 원본                    | node-typescript 스택이 ai-config에 아직 없음 |
| 문서 언어      | 한글                                | 코드 주석·커밋은 한글, README는 한/영/일 3종 | 공개 저장소라 영어 독자가 1차                |
| 커밋           | 한 커밋 = 한 책임                   | 동일                                         | —                                            |
| 자동 커밋      | 금지                                | 동일. 단 사용자가 건별로 위임 가능           | —                                            |

## 3. 실제 폴더 구조

```
packages/
  core/   src/*.ts (28)  ── 파싱·사실 저장·축 계산·게이트·층화. 런타임 의존 0
          test/*.ts (13) ── 회귀·시나리오·판정 테스트
  cli/    src/{index,args,version}.ts ── scouter 명령 전부. 화면 렌더링의 유일한 표면
  mcp/    src/index.ts   ── MCP 서버. GateCheck 의 두 번째 소비자
  ext/    src/extension.ts ── VS Code 확장 (engines.vscode ^1.90)
scripts/  bundle.mjs · sea.mjs · checkDocs.mjs
probe/    일회성 계측 스크립트. 제품 코드가 아님
docs/     adr/ · briefs/ · reviews/ · retros/ · superpowers/specs/
```

`core/src` 안의 갈래:

- 입력: `scan.ts` · `parser.ts` · `extract.ts` · `bash.ts` · `db.ts`
- 정의·계산: `definitions.ts` · `metrics.ts` · `periods.ts` · `analyze.ts` · `capability.ts`
- 신뢰 장치: `gate.ts` · `stratify.ts` · `worktype.ts` · `variance.ts` · `validity.ts`
- 표시: `statHtml.ts` · `reportHtml.ts` · `radar.ts` · `i18n.ts` · `stdio.ts`

## 4. 모듈 경계

| 모듈   | 책임                               | 외부 인터페이스          | 내부 구현                         |
| ------ | ---------------------------------- | ------------------------ | --------------------------------- |
| `core` | 사실 파싱·저장, 축 계산, 신뢰 판정 | `index.ts` 의 `export *` | SQLite 스키마, 축 정의, 순열 분포 |
| `cli`  | 사람이 보는 화면                   | `scouter <command>`      | 표 폭 계산, 언어 선택             |
| `mcp`  | 에이전트가 읽는 화면               | MCP 도구                 | 텍스트 직렬화                     |
| `ext`  | VS Code 패널                       | 확장 활성화              | `scouter json` 소비               |

**경계 규칙 하나.** 점수를 만드는 코드는 `core` 안에만 둔다. `cli`·`mcp`·`ext` 는 같은 값을
받아 다르게 그리기만 한다. 같은 수를 두 화면이 다르게 적는 것이 이 저장소에서 반복해 나온
결함이라, 판정을 내리는 상수(`SPLIT_HALF_PASS`·`MIN_SESSIONS_FOR_SPLIT_HALF`)와 기호
매핑(`verdictMark`)을 `core` 에서 내보내 쓰게 한다.

## 5. 핵심 결정

정식 ADR 파일은 아직 없다(`docs/adr/` 에 템플릿만 있음). 아래는 코드와 README에 이미
근거가 남아 있는 결정들의 색인이다. ADR로 승격할 때 이 표를 출처로 쓴다.

| 결정                                        | 이유                                                                | 근거 위치                          |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| DB에 사실만 넣고 점수는 매번 계산           | 정의가 자주 바뀌는데 940MB 재파싱을 못 감당                         | `db.ts` · README "데이터"          |
| 내장 `node:sqlite` 사용                     | 네이티브 모듈은 VS Code 확장에서 Electron ABI 재빌드에 걸림         | `db.ts` · README                   |
| 라벨은 DB 밖 append-only jsonl              | 라벨만 재생성 불가. 파생물과 같은 그릇에 두면 정의 고칠 때마다 소실 | `labels.ts`                        |
| 축을 도구 이름이 아니라 능력으로 정의       | 다른 하네스를 재려면 매핑 하나만 채우면 되게                        | `definitions.ts` · `capability.ts` |
| 없는 능력은 0점이 아니라 판정 불가          | 분모는 대체 경로가 채우므로 분모만 보면 능력 부재를 못 읽음         | `capability.ts`                    |
| 분할 하나가 아니라 순열 분포로 재현성 측정  | 운 좋은 분할 하나가 통과를 만듦                                     | `gate.ts` `permutedSplitHalf`      |
| 게이트 판정은 3값(pass/fail/not-computable) | 재보지 못한 검사를 통과로 세면 안 됨                                | `gate.ts` `GateVerdict`            |
| 층화는 실험이고 게이트를 안 움직임          | 검증 안 된 임의 임계로 통과선을 옮기면 기준을 고친 것               | `stratify.ts`                      |
| 위약 층으로 이동의 잡음 바닥을 잼           | 이동 하나만 봐서는 얼마나 커야 움직인 것인지 모름                   | `stratify.ts` `placeboStrata`      |

전체 ADR 목록: `docs/adr/`

## N. Notes

- CI는 `release.yml` 하나뿐이고 PR 검사가 없다. 빌드·테스트·포맷·문서 대조는 전부 로컬
  판단에 걸려 있다. 머지 전 `npm run build && npm test && npm run check:format` 을 직접 돌린다.
- `npm run check:docs` 의 검사 2건(예시 화면·커버리지 수)은 940MB 코퍼스가 있어야 통과한다.
  코퍼스 없는 환경에서는 항상 실패하며, 그것이 정상이다. 나머지 검사는 코퍼스 없이도 돈다.
- `check:docs` 는 게이트·층화 출력의 수치를 검증하지 않는다. 그 숫자를 README에 적을 때는
  사람이 맞춰야 한다.
