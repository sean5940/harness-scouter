# harness-scouter

이 파일이 프로젝트의 캐노니컬 메모리다. Claude Code의 `CLAUDE.md`는 이 파일을 import 한다.

색인 역할. 본문은 `docs/`에 둔다. 매 턴 자동 로드되므로 짧게 유지.

## 스택

- Node.js 22.5+ / TypeScript 5.7, npm workspaces 모노레포 (`packages/{core,cli,mcp,ext}`)
- 테스트는 vitest, 빌드는 `tsc --build` (프로젝트 참조)
- `packages/ext` 는 VS Code 확장(engines.vscode ^1.90)
- 정확한 버전과 주요 라이브러리: `docs/architecture.md` 참조
- 글로벌 스택 지식: 이 스택은 `~/.ai-config/stacks/` 에 아직 없다 (flutter 만 존재)

## 환경 설정 (clone 후)

`.claude/`, `.codex/config.toml`, `.codex/hooks.json`, `.gemini/` 는 ai-config가 생성하는 산출물이라 git으로 추적하지 않는다(gitignore). MCP·hook·generic 스택 지식은 ai-config에서 단일 관리한다.

- ai-config가 있는 환경: clone 후 `ai-config init-project` 실행 → hook·설정 재생성 + qmd 인덱스 등록.
- ai-config가 없는 환경(CI 등): 위 설정 없이도 빌드/실행은 정상, hook 자동화만 비활성.

## 핵심 결정 (ADR)

- 결정 인덱스: `docs/adr/`
- 핵심 결정 요약: `docs/architecture.md` 5번 섹션

## 컨벤션

- 코드 스타일·네이밍: `docs/conventions.md`
- 글로벌 상속 + 프로젝트 오버라이드 구조

## 워크플로 스킬

이 프로젝트에서 사용 가능한 ai-config 스킬:

- `/office-hours` — 새 기능 기획 시 진입점
- `/plan-ceo-review` — 스코프·전략 검토
- `/plan-eng-review` — 아키텍처·테스트·엣지케이스 검토
- `/document-release` — 살아있는 문서 갱신, ADR 정합성 점검
- `/retro` — 주간 회고 + 산출물 위생 점검

## 산출물 위치

- briefs: `docs/briefs/`
- reviews: `docs/reviews/{ceo,eng}/`
- adr: `docs/adr/`
- retros: `docs/retros/`

## 즉시 적용 규칙

매 턴 자동 적용. 다른 곳에 적지 말고 여기만 유지.

- TBD: 프로젝트별 절대 규칙을 작성하세요
- 예: 모든 신규 모델은 freezed로 작성
- 예: BuildContext after async gap 사용 금지

## 글로벌 기본값에서의 오버라이드

`docs/architecture.md` 2번 섹션 참조.

## 산출물 처리 규칙 (전역, 변경 금지)

- 살아있는 문서: in-place 갱신 가능 (`docs/architecture.md`, `docs/conventions.md`)
- 시점 박제: 본문 수정 절대 금지 (briefs, reviews, retros). frontmatter status만 변경 가능
- ADR: 본문 불변, status 전이만 허용
- 자동 git commit 금지
