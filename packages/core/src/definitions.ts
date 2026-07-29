/**
 * 지표 정의의 단일 기준점 (설계 5.5).
 *
 * v1은 판정 경계를 산문으로만 적었고, 그 결과 같은 축을 재계산할 때마다 다른 값이
 * 나왔다(축2 16.6% 대 8.92%, 축3 분모 197 대 206~290, 축5 0.094 대 0.179).
 * 갈린 항목은 전부 경계가 코드로 고정돼 있지 않은 것들이었다.
 * 정의를 바꿀 일이 있으면 문서가 아니라 이 파일을 고치고, 문서는 이 파일을 가리킨다.
 */

/** 축3의 커밋 분모와 축5a의 소스 판정에 쓰는 코드 확장자. */
export const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "m",
  "mm",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "scala",
  "sh",
  "bash",
  "zsh",
  "sql",
  "vue",
  "svelte",
]);

/**
 * 축1 분모에서 빼는 확장자.
 * 검증에서 한 축(검색 대비 산출 효율)이 분자의 절반이 PNG 스크린샷이라 죽었다.
 * 이미지 Read는 "범위를 지켰나"를 물을 대상이 아니다.
 */
export const NON_TEXT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "pdf",
  "ipynb",
  "zip",
  "mp4",
  "mov",
  "woff",
  "woff2",
  "ttf",
]);

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

// ---------------------------------------------------------------------------
// Bash 명령 분류
// ---------------------------------------------------------------------------

/**
 * 포매터. 축5a 분자에서 뺀다.
 * 사람의 변경 의도가 아니라 정규화이고, 프로젝트 규칙이 worktree 커밋 전
 * `prettier --write`를 요구하므로 예외를 두지 않으면 규칙 준수가 벌점이 된다.
 */
const FORMATTER =
  /\b(prettier\s+--write|eslint\s+--fix|gofmt\s+-w|black\s|rustfmt|ktlint\s+-F)\b/;

/** 검증 명령. 축3·4의 verifier 판정. */
const VERIFIER_KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["tsc", /\btsc\b/],
  ["eslint", /\beslint\b/],
  ["prettier", /\bprettier\b/],
  [
    "test",
    /\bjest\b|\bvitest\b|npm\s+(run\s+)?test\b|\byarn\s+test\b|\bpytest\b|\bgo\s+test\b/,
  ],
  ["build", /\bnpm\s+run\s+build\b|\btsc\s+--build\b/],
];

/**
 * 재귀 검색. 축5b 분자.
 * `find … -name`을 빠뜨리면 우회가 잡히지 않는다. 실제로 프로젝트의 검색 게이트 훅이
 * `grep -r`·`rg`는 잡고 `find -name`은 놓치고 있는지가 성장 가이드의 확인 항목이다.
 */
const RECURSIVE_SEARCH =
  /(^|[|;&]\s*)(grep\s+(-[a-zA-Z]*r[a-zA-Z]*\s|--recursive)|rg\s|ag\s|ack\s|find\s+\S+.*-name\s)/;

/**
 * 계측 밖 소스 읽기. 축5a 분자의 절반.
 * 페이저로 파이프된 것이나 로그·임시 파일 대상은 우회가 아니다.
 */
const BASH_SOURCE_READ =
  /(^|[|;&]\s*)(cat|head|tail|bat)\s+[^|;&]*\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|md|json|ya?ml)\b|(^|[|;&]\s*)sed\s+-n\s/;

/**
 * 계측 밖 파일 쓰기. 축5a 분자의 나머지 절반이자 v2에서 이 축을 신설한 이유.
 * 편집을 bash로 빼면 축1~4 어디에도 걸리지 않는다.
 */
const BASH_FILE_WRITE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  // 리다이렉트가 heredoc 구분자에 바로 붙은 형태만 쓰기로 본다.
  // `[\s\S]*?>` 로 느슨하게 잡으면 `git commit -m "$(cat <<'EOF' … )"` 의 본문에 들어 있는
  // `>` 하나에 걸려 커밋이 전부 파일 쓰기로 오분류된다.
  [
    "heredoc-to-file",
    /<<\s*['"]?\w+['"]?\s*>{1,2}\s*\S|>{1,2}\s*[^\s|&;<]+\s*<<\s*['"]?\w+/,
  ],
  ["sed-in-place", /\bsed\s+-i\b/],
  [
    "redirect-to-source",
    /(^|[^>\d])>>?\s*[^\s|&;>]+\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|md|json|ya?ml)\b/,
  ],
  ["git-apply", /\bgit\s+apply\b/],
  ["tee-to-source", /\btee\s+[^\s|]*\.(ts|tsx|js|py|md|json)\b/],
  ["perl-in-place", /\bperl\s+-[a-zA-Z]*i\b/],
];

/**
 * 파일을 여는 스크립트 heredoc만 쓰기로 센다.
 * stdout만 내는 분석용 heredoc은 우회가 아니다. 구분하지 않으면 분자의 대부분이
 * 통계 스크립트로 오염된다 (표본에서 heredoc 306건 중 215건이 분석용).
 */
const SCRIPT_HEREDOC = /\b(python3?|node|ruby|perl)\s+-?\s*<</;
const SCRIPT_WRITES_FILE =
  /open\s*\([^)]*['"][wa]\+?['"]|\.write\s*\(|writeFileSync|appendFileSync|to_csv|to_json|json\.dump\s*\(|shutil\.(copy|move)|os\.rename/;

/**
 * 임시·로그 경로. 축5a 분자에서 뺀다.
 * 분석 중간 산출물을 `/tmp`에 쓰는 것은 계측 밖 편집이 아니다. 저장소 파일을
 * 계측 없이 고치는 것만 문제다.
 */
const SCRATCH_PATH =
  /\/tmp\/|\/private\/tmp\/|scratchpad|\.log\b|\/var\/folders\//;

/** 인덱스 검색 도구. 축5b 분모의 나머지. */
export const INDEXED_SEARCH_TOOL_PATTERN = /qmd|graphify/;

/** git commit. --amend는 축3 분모에서 뺀다(같은 변경을 두 번 세게 된다). */
const GIT_COMMIT = /\bgit\s+(-[^\s]+\s+)*commit\b/;
const GIT_COMMIT_AMEND = /\bgit\s+(-[^\s]+\s+)*commit\b[^\n]*--amend/;

export interface BashClassification {
  isFormatter: boolean;
  verifierKinds: string[];
  isRecursiveSearch: boolean;
  isSourceRead: boolean;
  fileWriteRule: string | null;
  isCommit: boolean;
  isCommitAmend: boolean;
}

/** Bash 명령 하나를 축 계산에 쓰는 범주로 분류한다. */
export function classifyBash(
  commandRaw: string | null | undefined,
): BashClassification {
  const command = commandRaw ?? "";
  const isFormatter = FORMATTER.test(command);
  const isScratch = SCRATCH_PATH.test(command);

  const verifierKinds: string[] = [];
  for (const [kind, re] of VERIFIER_KINDS) {
    if (re.test(command)) verifierKinds.push(kind);
  }

  let fileWriteRule: string | null = null;
  if (!isFormatter && !isScratch) {
    for (const [rule, re] of BASH_FILE_WRITE_RULES) {
      if (re.test(command)) {
        fileWriteRule = rule;
        break;
      }
    }
    if (
      fileWriteRule === null &&
      SCRIPT_HEREDOC.test(command) &&
      SCRIPT_WRITES_FILE.test(command)
    ) {
      fileWriteRule = "script-heredoc-write";
    }
  }

  return {
    isFormatter,
    verifierKinds,
    isRecursiveSearch: RECURSIVE_SEARCH.test(command),
    isSourceRead: !isFormatter && !isScratch && BASH_SOURCE_READ.test(command),
    fileWriteRule,
    isCommit: GIT_COMMIT.test(command),
    isCommitAmend: GIT_COMMIT_AMEND.test(command),
  };
}

// ---------------------------------------------------------------------------
// 판정 헬퍼
// ---------------------------------------------------------------------------

export function extensionOf(
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null;
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isCodeFile(filePath: string | null | undefined): boolean {
  const ext = extensionOf(filePath);
  return ext !== null && CODE_EXTENSIONS.has(ext);
}

export function isNonTextFile(filePath: string | null | undefined): boolean {
  const ext = extensionOf(filePath);
  return ext !== null && NON_TEXT_EXTENSIONS.has(ext);
}

/**
 * 축1의 no-op 가드.
 *
 * `Read`의 기본 동작이 최대 2000줄이므로 `limit: 2000`은 아무것도 좁히지 않는데도
 * 부분읽기로 집계된다. 이 가드가 없으면 훅으로 `limit`을 주입하는 것만으로
 * 축이 만점이 된다. 실제 결과 범위(startLine, numLines)로 판정하는 것이
 * 요청 인자(offset, limit)로 판정하는 것보다 조작에 강하다.
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
 * 게이트가 정상 작동한 것이지 도구 실패가 아니다. 게다가 검증 호출의 71%가
 * `| tail`로 파이프돼 exit code 자체가 삼켜진다.
 * 판정 불가면 null을 반환하고 호출부가 그 사실을 남긴다.
 */
export function verifierOutcome(
  stdout: string | null | undefined,
): "pass" | "fail" | null {
  if (!stdout) return null;
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
