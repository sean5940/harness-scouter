/**
 * 지표 정의의 단일 기준점 (설계 5.5).
 *
 * v1은 판정 경계를 산문으로만 적었고, 그 결과 같은 축을 재계산할 때마다 다른 값이
 * 나왔다(축2 16.6% 대 8.92%, 축3 분모 197 대 206~290). 갈린 항목은 전부 경계가
 * 코드로 고정돼 있지 않은 것들이었다. 정의를 바꿀 일이 있으면 문서가 아니라 이 파일과
 * bash.ts를 고치고, 문서는 코드를 가리킨다.
 */

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

export const AXIS_LABELS: Record<AxisKey, string> = {
  readScope: "읽기 범위 규율",
  readRevisit: "읽기 왕복 절제",
  verificationFreshness: "검증 신선도",
  verificationRedundancy: "검증 공회전 절제",
  instrumentedChannel: "계측 채널 준수",
  indexedRetrieval: "인덱스 우선 탐색",
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
