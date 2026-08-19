/**
 * 지표 정의의 단일 기준점 (설계 5.5).
 *
 * v1은 판정 경계를 산문으로만 적었고, 그 결과 같은 축을 재계산할 때마다 다른 값이
 * 나왔다(축2 16.6% 대 8.92%, 축3 분모 197 대 206~290). 갈린 항목은 전부 경계가
 * 코드로 고정돼 있지 않은 것들이었다. 정의를 바꿀 일이 있으면 문서가 아니라 이 파일과
 * bash.ts를 고치고, 문서는 코드를 가리킨다.
 */

import { L, type Localized } from "./i18n.js";

export {
  classifyBash,
  extensionOf,
  isCodeFile,
  isNonTextFile,
  CODE_EXTENSIONS,
  NON_TEXT_EXTENSIONS,
  type BashClassification,
} from "./bash.js";

/**
 * 에이전트가 자기 작업용으로 만든 임시 워크스페이스.
 *
 * 하네스가 자기를 재려고 돌린 ablation·eval 실행이 여기서 일어난다. 세션으로는 진짜지만
 * 재려는 대상이 아니다. 이걸 코퍼스에 넣으면 하네스 품질 대신 "하네스를 재는 실행"의
 * 품질이 섞인다. 2026-08-19 실측에서 111개 중 26개(23%)가 이 경로였고, 그중 20개는
 * 한 번 쓰고 버린 디렉토리였다.
 *
 * 경로 하나로만 가른다. 프로젝트별로 뺄 목록을 열어주면 불편한 세션을 빼는 손잡이가
 * 되고, 그 순간 축이 행동이 아니라 목록 편집에 반응한다.
 */
const SYNTHETIC_WORKSPACE = /(^|\/)(private\/)?tmp\/claude-\d+\//;

/** 재는 대상이 아닌 임시 워크스페이스인지. 판정은 트랜스크립트가 적어준 cwd로 한다. */
export function isSyntheticWorkspace(cwd: string | null): boolean {
  if (cwd === null) return false;
  return SYNTHETIC_WORKSPACE.test(cwd);
}

/**
 * 축1의 큰 파일 임계.
 * 크기 구간별 부분읽기율이 여기서 꺾인다: 20.5%(≤200) / 71.6%(201-500) /
 * 96.7%(501-2000). 임계를 200으로 잡은 근거는 이 관측이다.
 */
export const LARGE_FILE_LINES = 200;

/** 이벤트 예산 구간의 축별 최소 분모 (설계 3.4). */
export const PERIOD_BUDGET = {
  readScope: 10,
  readRevisit: 20,
  verificationFreshness: 10,
  verificationRedundancy: 10,
  instrumentedChannel: 20,
  indexedRetrieval: 10,
} as const;

/** 예산을 못 채워도 구간을 닫는 상한. 커밋 없는 planning 구간이 무한히 열려 있는 것을 막는다. */
export const PERIOD_SESSION_CAP = 40;

/**
 * 구간 하나에 최소로 들어가야 하는 세션 수.
 *
 * 예산만으로 끊으면 세션 하나가 예산을 다 채우는 코퍼스에서 구간이 세션 1개씩으로 쪼개진다.
 * 그러면 구간이 세션의 다른 이름이 되어 "이 시기에 어땠나"라는 질문 자체가 사라진다.
 *
 * 4 로 잡은 근거는 관측이다. 이 코퍼스의 구간 30개 중 가장 작은 것이 4 였고, 그보다 작은
 * 구간은 예산을 채워서 닫힌 적이 없다. 임계가 아니라 관측된 하한이다.
 */
export const PERIOD_MIN_SESSIONS = 4;

/** delta 기준선으로 삼는 직전 구간 수 (설계 3.4). */
export const DELTA_BASELINE_PERIODS = 3;

export type AxisKey = keyof typeof PERIOD_BUDGET;

/** 레이더 12시부터 시계방향. 마주보는 자리가 대립쌍이다 (설계 5.4). */
export const AXIS_ORDER: AxisKey[] = [
  "readScope",
  "verificationFreshness",
  "instrumentedChannel",
  "readRevisit",
  "verificationRedundancy",
  "indexedRetrieval",
];

export const AXIS_LABELS: Record<AxisKey, Localized> = {
  readScope: L("읽기 범위 규율", "Read-scope discipline"),
  readRevisit: L("읽기 왕복 절제", "Read round-trip restraint"),
  verificationFreshness: L("검증 신선도", "Check freshness"),
  verificationRedundancy: L("검증 공회전 절제", "Check redundancy restraint"),
  instrumentedChannel: L("계측 채널 준수", "Instrumented-channel use"),
  indexedRetrieval: L("인덱스 우선 탐색", "Index-first retrieval"),
};

/**
 * 인덱스 검색으로 인정하는 도구.
 *
 * 조회 계열(`qmd get`·`multi_get`·`status`)은 검색이 아니라 이미 아는 문서를 꺼내는 것이다.
 * 분모 크레딧을 주면 그것만 반복 호출해 점수를 올리는 경로가 열린다. 실측에서 이 계열이
 * 인덱스 분모의 16%를 차지했다.
 */
const INDEX_QUERY_TOOLS = /qmd__query|graphify__/;
const INDEX_NON_SEARCH_TOOLS =
  /qmd__(get|multi_get|status)|graphify__(graph_stats|list_prs)/;

export function isIndexedSearchTool(name: string): boolean {
  return INDEX_QUERY_TOOLS.test(name) && !INDEX_NON_SEARCH_TOOLS.test(name);
}

/**
 * 내용을 전수 스캔하는 계측 도구.
 * 계측 채널이지만 하는 일은 스캔이라 인덱스 쪽에 넣지 않는다.
 */
export const CONTENT_SCAN_TOOLS = new Set(["Grep"]);

/**
 * 파일 찾기를 계측 채널로 하는 도구.
 * `find -name` 의 옳은 대안이므로 벌점이 아니라 가점 쪽이다.
 */
export const FILE_FIND_TOOLS = new Set(["Glob"]);

/**
 * 조사 에피소드의 경계와 "탐색이 필요했다"고 볼 임계.
 *
 * 총 호출량은 "인덱스를 쓰는가"만 답하고 "필요한 자리에서 쓰는가"는 답하지 못한다.
 * 그래서 조사 활동이 몰린 구간을 에피소드로 끊고, 그 안에서 인덱스 호출이 임계 충족
 * 전인지 후인지 본다.
 *
 * 임계 충족 시점으로 판정하는 것이 중요하다. 신호를 만들기 시작한 첫 이벤트를 기준으로
 * 잡으면 재는 것이 "필요해지기 전에 불렀나"가 아니라 "에피소드 맨 처음에 불렀나"가 되고,
 * 실측에서 before 와 after 의 순서가 뒤집혔다.
 *
 * 임계값 자체는 임의값이라 결론을 여기에 걸면 안 된다. 다섯 변형(간격 3·5·10, 스캔 2·3,
 * 읽기 3·5)으로 재봤을 때 메인과 subagent 의 미호출 격차는 19.9~27.6%p 로 모두 유지됐다.
 * 절대값(메인 60.9~73.0%)은 변형에 따라 움직이므로 특정 값을 근거로 쓰지 않는다.
 */
export const EPISODE_GAP = 5;
export const EPISODE_SCAN_THRESHOLD = 3;
export const EPISODE_READ_THRESHOLD = 3;

/**
 * 기존 파일을 고친 편집인가. 근거 확보율의 분모 판정에 쓴다.
 *
 * 결과의 `type` 필드(create·update)는 `Write`에만 실린다. `Edit` 계열은 그 필드가
 * 없어서 그것만 보면 편집 4,450건이 통째로 분모에서 빠졌다. `Edit`은 없는 파일을
 * 만들 수 없으므로 도구 이름 자체가 기존 파일이라는 증거다.
 * `Write`에 `type`이 없는 경우는 판정 불가라 분모에서 뺀다.
 */
export function isExistingFileEdit(
  toolName: string,
  editType: string | null,
): boolean {
  if (toolName === "Write") return editType === "update";
  return toolName === "Edit" || toolName === "MultiEdit";
}

/**
 * 축1의 no-op 가드.
 *
 * `Read`의 기본 동작이 최대 2000줄이므로 `limit: 2000`은 아무것도 좁히지 않는데도
 * 부분읽기로 집계된다. 이 가드가 없으면 훅으로 `limit`을 주입하는 것만으로
 * 축이 만점이 된다. 실제 결과 범위로 판정하는 것이 요청 인자로 판정하는 것보다
 * 조작에 강하다.
 */
export function isEffectivePartialRead(
  totalLines: number | null,
  numLines: number | null,
  startLine: number | null,
): boolean {
  if (totalLines === null) return false;
  const covered = numLines ?? totalLines;
  const from = startLine ?? 1;
  const readsWholeFile = covered >= totalLines && from <= 1;
  return !readsWholeFile;
}

/**
 * verifier의 성패를 stdout으로 판정한다.
 *
 * `is_error`를 쓰면 안 된다. tsc·eslint는 문제를 찾으면 비영 종료하는데 그건
 * 게이트가 정상 작동한 것이지 도구 실패가 아니다. 게다가 검증 호출의 상당수가
 * `| tail`로 파이프돼 exit code 자체가 삼켜진다.
 * 판정 불가면 null을 반환하고 호출부가 그 사실을 남긴다.
 */
export function verifierOutcome(
  stdout: string | null | undefined,
): "pass" | "fail" | null {
  if (stdout === null || stdout === undefined || stdout === "") return null;
  const explicitExit = /EXIT=(\d+)/.exec(stdout);
  if (explicitExit?.[1] !== undefined)
    return explicitExit[1] === "0" ? "pass" : "fail";
  if (/error TS\d+/.test(stdout)) return "fail";
  if (/\bproblems?\s*\(\s*[1-9]\d*\s+errors?/.test(stdout)) return "fail";
  if (/\b\d+\s+failed\b|\bFAIL\b/.test(stdout)) return "fail";
  if (/\bproblems?\s*\(\s*0\s+errors?/.test(stdout)) return "pass";
  if (/\ball\s+files\s+use\s+prettier|\bPASS\b|\b0\s+failed\b/i.test(stdout))
    return "pass";
  return null;
}
