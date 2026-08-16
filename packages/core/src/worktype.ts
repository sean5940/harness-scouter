import type { ToolCallRecord } from "./db.js";
import { classifyBash, isCodeFile } from "./definitions.js";
import { L, type Localized } from "./i18n.js";

/**
 * 세션의 작업 유형 (한계 2번의 처방).
 *
 * 게이트가 구간별 화면에서 6축 중 5축을 떨어뜨렸고, 구간을 2·3·4배로 키워도 안 나아졌다.
 * 원인을 "표본이 적어서"가 아니라 "세션마다 하는 일이 너무 달라서"로 짚어 뒀는데,
 * 그렇다면 고칠 자리는 축의 정의가 아니라 **비교 대상의 구성**이다. 리팩터링 세션과
 * 문서 세션을 한 통에 넣고 반으로 가르면, 두 반쪽이 다른 것은 축이 불안정해서가 아니라
 * 어느 쪽에 어떤 세션이 들어갔느냐 때문이다.
 *
 * 고정 태스크 셋(프로브)을 만들면 작업 구성이 잡음이 아니라 상수가 된다. 그건 비싸다.
 * 그 전에 오늘 있는 사실 테이블만으로 물어볼 수 있는 것이 하나 있다. **같은 유형끼리
 * 갈라도 두 반쪽이 여전히 다른가.** 다르면 작업 구성은 원인이 아니고 프로브를 만들어도
 * 안 풀린다. 같아지면 프로브에 쓸 돈의 근거가 생긴다.
 *
 * 그래서 이 분류는 점수를 매기지 않는다. 층을 만들 뿐이다.
 */
export type WorkType = "explore" | "docs" | "build" | "modify" | "verify";

export const WORK_TYPES: readonly WorkType[] = [
  "explore",
  "docs",
  "build",
  "modify",
  "verify",
];

export const WORK_TYPE_LABELS: Record<WorkType, Localized> = {
  explore: L("조사", "explore"),
  docs: L("문서·설정", "docs"),
  build: L("신규 구현", "build"),
  modify: L("기존 수정", "modify"),
  verify: L("검증·운영", "verify"),
};

/**
 * 유형 판정에 쓰는 세션 단위 집계.
 *
 * 도구 호출을 다시 걷지 않으려고 따로 둔다. 임계 변형을 다섯 개 돌려 민감도를 보는데,
 * 분류 함수가 호출 배열을 받으면 같은 세션을 다섯 번 걷는다.
 */
export interface WorkloadCounts {
  /** 코드 파일을 대상으로 한 편집 횟수. bash 파일쓰기도 대상이 코드면 센다. */
  codeEdits: number;
  /** 코드 파일이 아닌 것을 대상으로 한 편집 횟수. */
  docEdits: number;
  /**
   * 코드 편집 중 파일을 새로 만든 것.
   *
   * `Write` 의 결과 `type` 이 create 인 것만 셀 수 있다. bash 로 쓴 파일은 새로 만든
   * 것인지 고친 것인지 결과에 안 남아, 분모에는 들어가고 분자에는 안 들어간다.
   * 그래서 이 비율은 새 파일 비중을 아래로 눌러 잡는다.
   */
  createdCodeFiles: number;
  /** verifier 실행 횟수. 호출이 아니라 실행이라 `&&` 로 묶은 것도 각각 센다. */
  verifierRuns: number;
  commits: number;
  reads: number;
  searches: number;
}

export function emptyWorkload(): WorkloadCounts {
  return {
    codeEdits: 0,
    docEdits: 0,
    createdCodeFiles: 0,
    verifierRuns: 0,
    commits: 0,
    reads: 0,
    searches: 0,
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/**
 * 세션 하나를 한 번 걸어 유형 판정에 쓸 것만 센다.
 *
 * 막힌 호출은 실행되지 않았으므로 세지 않는다. 축 계산과 같은 규칙이다. 안 맞추면
 * 훅이 많이 막는 세션이 실제로 한 일과 다른 유형으로 분류된다.
 */
export function summarizeWorkload(calls: ToolCallRecord[]): WorkloadCounts {
  const out = emptyWorkload();

  for (const call of calls) {
    if (call.denial_kind !== null) continue;

    if (call.name === "Read") {
      out.reads += 1;
      continue;
    }

    if (SEARCH_TOOLS.has(call.name)) {
      out.searches += 1;
      continue;
    }

    if (EDIT_TOOLS.has(call.name)) {
      const path = call.file_path;
      if (path === null) continue;
      if (isCodeFile(path)) {
        out.codeEdits += 1;
        // `Edit` 계열은 없는 파일을 만들 수 없으므로 create 가 아니다. `Write` 만
        // 결과의 type 으로 갈린다.
        if (call.name === "Write" && call.edit_type === "create") {
          out.createdCodeFiles += 1;
        }
      } else {
        out.docEdits += 1;
      }
      continue;
    }

    if (call.name !== "Bash") continue;

    const kind = classifyBash(call.command);
    if (kind.fileWriteRule !== null) {
      if (isCodeFile(kind.fileWriteTarget)) out.codeEdits += 1;
      else out.docEdits += 1;
    }
    if (kind.isContentSearch || kind.isFileFind || kind.isIndexedSearch) {
      out.searches += 1;
    }
    if (kind.isSourceRead) out.reads += 1;
    out.verifierRuns += kind.verifierKinds.length;
    if (kind.isCommit && !kind.isCommitAmend) out.commits += 1;
  }

  return out;
}

/**
 * 유형 경계.
 *
 * 두 값 다 임의값이다. 관측에서 꺾인 자리를 찾아 잡은 것이 아니라, 유형을 가르려면
 * 어딘가는 끊어야 해서 잡았다. 그래서 결론을 이 값에 걸면 안 된다. `EPISODE_GAP` 에서
 * 쓴 것과 같은 방식으로, 아래 `WORK_TYPE_VARIANTS` 를 전부 돌려 결론이 유지되는지
 * 본 뒤에만 읽는다. 변형에 따라 부호가 바뀌면 그건 층화의 효과가 아니라 임계의 효과다.
 */
export interface WorkTypeThresholds {
  /** 코드 편집 중 새 파일 비중이 이 이상이면 신규 구현으로 본다. */
  createShare: number;
  /** 편집이 없는 세션에서 검증·커밋이 이 이상이면 조사가 아니라 검증·운영으로 본다. */
  verifyMin: number;
}

export const DEFAULT_WORK_TYPE_THRESHOLDS: WorkTypeThresholds = {
  createShare: 0.3,
  verifyMin: 2,
};

/**
 * 임계 민감도용 변형.
 *
 * 기본값 하나를 가운데 두고 두 축을 각각 위아래로 흔든다. 두 임계를 동시에 흔들지
 * 않는 이유는 어느 임계가 결론을 움직였는지 봐야 하기 때문이다.
 */
export const WORK_TYPE_VARIANTS: readonly WorkTypeThresholds[] = [
  DEFAULT_WORK_TYPE_THRESHOLDS,
  { createShare: 0.2, verifyMin: 2 },
  { createShare: 0.5, verifyMin: 2 },
  { createShare: 0.3, verifyMin: 1 },
  { createShare: 0.3, verifyMin: 4 },
];

/**
 * 집계를 유형 하나로 접는다.
 *
 * 판정 순서를 고정한다. 조건을 겹쳐 두고 먼저 맞는 것을 고르는 방식이라, 순서가 곧
 * 정의다. 순서를 바꾸면 같은 세션이 다른 층으로 간다.
 *
 * 1. 아무것도 안 고쳤다 → 검증·운영이거나 조사다. 검증·커밋 횟수로 가른다.
 * 2. 고쳤는데 코드가 아니다 → 문서·설정이다.
 * 3. 코드를 고쳤고 새 파일 비중이 높다 → 신규 구현이다.
 * 4. 나머지 → 기존 수정이다.
 */
export function classifyWorkType(
  counts: WorkloadCounts,
  thresholds: WorkTypeThresholds = DEFAULT_WORK_TYPE_THRESHOLDS,
): WorkType {
  const edits = counts.codeEdits + counts.docEdits;
  if (edits === 0) {
    return counts.verifierRuns + counts.commits >= thresholds.verifyMin
      ? "verify"
      : "explore";
  }
  if (counts.codeEdits === 0) return "docs";
  const createShare = counts.createdCodeFiles / counts.codeEdits;
  return createShare >= thresholds.createShare ? "build" : "modify";
}

/** 층별 세션 수. 층이 한쪽으로 쏠렸으면 층화해도 갈라지는 것이 없다. */
export function stratumSizes(
  types: Iterable<WorkType>,
): Record<WorkType, number> {
  const out = Object.fromEntries(WORK_TYPES.map((k) => [k, 0])) as Record<
    WorkType,
    number
  >;
  for (const type of types) out[type] += 1;
  return out;
}
