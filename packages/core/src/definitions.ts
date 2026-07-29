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
 * 축5b에서 인덱스 검색으로 인정하는 도구.
 *
 * Grep·Glob은 여기 넣지 않는다. 계측 채널이긴 하지만 하는 일은 전수 스캔이고,
 * 축이 묻는 것은 "계측 도구를 썼나"가 아니라 "인덱스를 먼저 봤나"이기 때문이다.
 * 이 선택만으로 축 값이 0.32~0.52로 갈리므로 코드에 고정해 둔다.
 */
export const INDEXED_SEARCH_TOOL_PATTERN = /qmd|graphify/;

/** 계측 채널이지만 전수 스캔이라 축5b 분자에 들어가는 도구. */
export const SCANNING_SEARCH_TOOLS = new Set(["Grep", "Glob"]);

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
  startLine: number | null
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
  stdout: string | null | undefined
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
