/**
 * Bash 명령 분류.
 *
 * 초판은 명령 원문 전체에 정규식을 매칭했고, 적대적 검토에서 그 방식이 낸 결함이
 * 7건이었다. 커밋 메시지 안의 `npx tsc` 문자열이 검증 실행으로 잡혀 커밋이 스스로를
 * 신선하다고 판정하고(174건), 여러 줄 명령의 둘째 줄부터 통째로 안 잡히며(30%),
 * `.log`가 경로가 아니라 `console.log(`에 걸렸다.
 *
 * 그래서 명령을 heredoc 본문 제거 → 세그먼트 분리 → 세그먼트 선두 토큰 판정 순으로 본다.
 * 문자열 리터럴 안의 내용은 실행이 아니므로 판정에서 빠진다.
 */

/** 코드로 볼 확장자. 축3 커밋 분모와 축5a 소스 판정에 쓴다. */
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

/** 텍스트로 열어보는 산출물. 소스는 아니지만 계측 채널로 읽어야 하는 대상이다. */
const DOC_EXTENSIONS = new Set([
  "md",
  "json",
  "yaml",
  "yml",
  "toml",
  "txt",
  "css",
  "scss",
  "html",
]);

/** 축1 분모에서 빼는 확장자. 이미지 Read는 범위를 물을 대상이 아니다. */
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

export function extensionOf(
  filePath: string | null | undefined,
): string | null {
  if (filePath === null || filePath === undefined || filePath === "")
    return null;
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
 * 경로 토큰을 비교 가능한 형태로 만든다.
 *
 * `/tmp/../app/foo.ts` 는 실제로는 `/app/foo.ts` 인데 문자열 매칭만 하면 임시 경로로
 * 보여 예외로 빠진다. 코퍼스에 사례는 없지만 접두사 한 조각으로 축을 끄는 경로라 닫는다.
 */
function normalizePath(token: string): string {
  const parts: string[] = [];
  for (const seg of token.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return (token.startsWith("/") ? "/" : "") + parts.join("/");
}

/** 인터프리터 인라인 코드에서 파일 경로만 남긴다. `open('app/a.ts')` → `app/a.ts` */
function stripQuotesAndCalls(token: string): string {
  const match = /["']([^"']*\/[^"']*\.[A-Za-z0-9]+)["']/.exec(token);
  return match?.[1] ?? token.replace(/^["']|["']$/g, "");
}

function isReadableSourcePath(token: string): boolean {
  const ext = extensionOf(token);
  return ext !== null && (CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext));
}

/**
 * 임시·로그 경로 판정.
 *
 * 초판은 명령 전체에 이 검사를 걸어 `console.log(`가 들어간 편집이 통째로 축에서
 * 사라졌다. 대상 경로에만 적용한다.
 */
function isScratchTarget(target: string | null): boolean {
  if (target === null) return false;
  // 정규화 후에 본다. `/tmp/../app/foo.ts` 가 임시 경로로 통과하던 구멍을 막는다.
  return /^\/tmp\/|^\/private\/tmp\/|\/var\/folders\/|scratchpad|\.log$|\.tmp$/.test(
    normalizePath(target),
  );
}

/**
 * heredoc 본문을 지운다.
 *
 * 여는 줄의 나머지는 남긴다. `cat <<'EOF' > src/a.ts`처럼 리다이렉트가 태그 뒤에
 * 오는 형태가 흔한데, 태그 직후부터 지우면 그 리다이렉트가 본문으로 먹혀 쓰기 판정이 사라진다.
 */
function stripHeredocBodies(command: string): string {
  return command.replace(
    /(<<-?\s*)(['"]?)([A-Za-z_]\w*)\2([^\n]*)\n[\s\S]*?^[ \t]*\3[ \t]*$/gm,
    (_all, opener: string, quote: string, tag: string, restOfLine: string) =>
      `${opener}${quote}${tag}${quote}${restOfLine} `,
  );
}

/**
 * 스크립트 heredoc이 파일을 여는지 본문에서 확인한다.
 *
 * stdout만 내는 분석용 heredoc은 계측 우회가 아니다. 구분하지 않으면 분자의 대부분이
 * 통계 스크립트로 오염된다(표본에서 heredoc 306건 중 215건이 분석용).
 * 이 판정만 본문이 필요하므로 원문에서 따로 본다.
 */
const SCRIPT_WRITES_FILE =
  /open\s*\([^)]*['"][wa]\+?['"]|\.write\s*\(|writeFileSync|appendFileSync|to_csv|to_json|json\.dump\s*\(|shutil\.(copy|move)|os\.rename|\.write_text/;

/**
 * 파이프·연결·개행으로 명령을 실행 단위로 쪼갠다.
 *
 * 따옴표 안의 구분자는 자르지 않는다. `grep -rn 'alpha|beta'` 를 정규식으로 자르면
 * 패턴이 두 조각으로 갈려 서로 다른 검색이 같은 것으로 뭉치고, 뒤 조각이 엉뚱한
 * 명령으로 오분류된다.
 */
function splitSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);

  return out.map((seg) => seg.trim()).filter((seg) => seg !== "");
}

/**
 * `bash -lc "…"` 껍데기를 벗긴다.
 *
 * 껍데기 한 겹으로 안쪽이 통째로 안 보였다. `bash -lc "git commit -m x"` 가 커밋으로
 * 안 잡혀 검증 신선도의 분모가 사라지고, 닫힌 구간이 28에서 8로 줄었다.
 * 점수를 올리는 게 아니라 관측을 없애는 종류라 더 나쁘다.
 */
function unwrapShellWrapper(command: string): string {
  const match = /^\s*(?:bash|sh|zsh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(
    command,
  );
  return match?.[2] ?? command;
}

/** 환경변수 대입과 래퍼를 걷어낸 실행 토큰들. */
function meaningfulTokens(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (/^\w+=/.test(t)) {
      i += 1;
      continue;
    }
    if (t === "sudo" || t === "time" || t === "command" || t === "exec") {
      i += 1;
      continue;
    }
    if (t === "cd") {
      i += 2;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

const VERIFIER_BINARIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["tsc", /^tsc$/],
  ["eslint", /^eslint$/],
  ["prettier", /^prettier$/],
  ["test", /^(jest|vitest|pytest|mocha)$/],
];

/**
 * npm·yarn·pnpm 스크립트 이름으로 검증을 판정한다.
 *
 * 이걸 놓치면 레포마다 값이 달라진다. raw `npx tsc`를 쓰는 레포는 정상으로 잡히고
 * `npm run typecheck`를 쓰는 레포는 검증을 아예 안 한 것으로 잡혀 비교가 성립하지 않는다.
 */
const SCRIPT_KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["tsc", /^(typecheck|type-check|tsc|types?)$/],
  ["eslint", /^(lint|eslint|lint:fix)$/],
  ["prettier", /^(format|format:check|fmt|prettier)$/],
  ["test", /^(test|tests|test:unit|jest|vitest)$/],
  ["build", /^(build|compile)$/],
];

/**
 * 도구를 부르지만 아무것도 검증하지 않는 인자.
 *
 * `npx tsc --version`은 tsc를 부르고도 코드를 안 본다. 이걸 검증으로 세면 커밋 앞에
 * 한 줄 접합하는 것만으로 신선도가 만점이 된다. 출력으로는 못 가른다. 조용히 통과하는
 * tsc는 출력이 아예 없어서 버전 조회와 구분이 안 되기 때문이다.
 */
const NO_OP_VERIFIER_FLAG = /^(--version|-v|-V|--help|-h)$/;

function verifierKindsOf(tokens: string[]): string[] {
  const kinds = new Set<string>();
  if (tokens.some((t) => NO_OP_VERIFIER_FLAG.test(t))) return [];
  let i = 0;
  // npx·bunx는 다음 토큰이 실제 실행 대상이다.
  if (tokens[0] === "npx" || tokens[0] === "bunx" || tokens[0] === "pnpx")
    i = 1;
  while (tokens[i]?.startsWith("-") === true) i += 1;

  const head = tokens[i];
  if (head === undefined) return [];

  const bare = head.split("/").pop() ?? head;
  for (const [kind, re] of VERIFIER_BINARIES) {
    if (re.test(bare)) kinds.add(kind);
  }

  if (/^(npm|yarn|pnpm|bun)$/.test(bare)) {
    const rest = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
    const script = rest[0] === "run" ? rest[1] : rest[0];
    if (script !== undefined) {
      for (const [kind, re] of SCRIPT_KINDS) {
        if (re.test(script)) kinds.add(kind);
      }
    }
  }

  // 스크립트 러너로 도는 검증 도구
  if (/^(tsx|ts-node|node)$/.test(bare)) {
    const target = tokens[i + 1];
    if (target !== undefined && /lint|typecheck|verify/.test(target))
      kinds.add("eslint");
  }

  return [...kinds];
}

/**
 * 탐색을 두 종류로 나눈다.
 *
 * 파일 찾기(`find -name`)와 내용 찾기(`grep -r`)는 다른 작업이고 옳은 대안도 다르다.
 * 파일 찾기는 인덱스로 대체할 수 없고 `Glob` 도구가 정답이다. 내용·관계 찾기는
 * qmd·graphify 가 정답이다. 한 지표에 섞으면 `find` 를 `Glob` 으로 바꿔도 점수가 안 올라
 * 정직한 개선에 보상이 없어진다.
 */
type SearchKind = "file" | "content" | null;

/**
 * 여러 파일을 대상으로 하는가.
 *
 * `-r` 이 없어도 글롭이 붙으면 다파일 스캔이다. `grep foo app/*.ts` 는 재귀 옵션이
 * 없다는 이유로 통째로 빠져 있었다.
 */
function targetsManyFiles(args: string[]): boolean {
  return args.some((t) => !t.startsWith("-") && t.includes("*"));
}

function searchKindOfSegment(tokens: string[]): SearchKind {
  let i = 0;
  if (tokens[0] === "npx" || tokens[0] === "xargs") i = 1;
  // `git grep` 은 선두가 git 이라 전 필드가 안 잡혔다. 실측에서 스캔 트래픽의
  // 26.5%(440건)가 이 형태로 분류기 밖에 있었다.
  if (tokens[i] === "git" && tokens[i + 1] === "grep") return "content";
  const head = tokens[i];
  if (head === undefined) return null;
  const bare = head.split("/").pop() ?? head;
  if (/^(rg|ag|ack)$/.test(bare)) return "content";
  if (bare === "grep") {
    const args = tokens.slice(i + 1);
    const recursive = args.some(
      (t) => /^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive",
    );
    return recursive || targetsManyFiles(args) ? "content" : null;
  }
  if (bare === "find") {
    const args = tokens.slice(i + 1);
    const byName = args.some(
      (t) => /^-i?name$/.test(t) || t === "-iregex" || t === "-regex",
    );
    if (!byName) return null;
    // Glob 으로 대체할 수 없는 형태는 분모에 넣지 않는다. Glob 은 파일만 내고
    // 개수·크기·시각도 못 센다. 넣으면 대안이 없는 일을 할 때마다 점수가 깎여
    // 정직한 경로가 막힌다. 검색 게이트 훅도 같은 둘을 예외로 뺀다.
    const directoryOnly = args.some(
      (t, n) => t === "-type" && args[n + 1] === "d",
    );
    const aggregation = args.some(
      (t) => t === "-size" || t === "-newer" || t === "-printf",
    );
    return directoryOnly || aggregation ? null : "file";
  }
  return null;
}

function isRecursiveSearchSegment(tokens: string[]): boolean {
  return searchKindOfSegment(tokens) !== null;
}

/**
 * CLI 로 부른 인덱스 검색.
 *
 * 인덱스 검색을 MCP 도구 이름으로만 세면 채널이 통째로 빠진다. 이 환경은 graphify 를
 * CLI 로 쓰는 것이 기본이고(고정 main 그래프를 serve 하는 MCP 는 worktree 와 어긋난다),
 * 실측에서 graphify 호출의 99%가 Bash 였다. qmd 는 반대로 MCP 가 주채널이고 CLI 가 8%다.
 * 둘을 다 세지 않으면 `내용 인덱스 우선` 이 41점으로 나오는데, CLI 를 넣으면 58점이다.
 *
 * 서브명령을 검색 계열로 한정하는 것은 MCP 쪽과 같은 규율이다. 조회·진단
 * (`qmd status`·`bench`·`get`, `graphify stats`·`god`·`community`)은 검색이 아니라
 * 분모 크레딧을 주지 않는다. 주면 그것만 반복 호출해 점수를 올리는 경로가 열린다.
 */
const INDEX_CLI_SEARCH: ReadonlyArray<readonly [string, RegExp]> = [
  ["qmd", /^(query|search|vsearch)$/],
  ["graphify", /^(query|explain|path|affected)$/],
];

function isIndexSearchSegment(tokens: string[]): boolean {
  let i = 0;
  if (tokens[0] === "npx" || tokens[0] === "xargs") i = 1;
  const head = tokens[i];
  if (head === undefined) return false;
  const bare = head.split("/").pop() ?? head;
  const sub = tokens[i + 1];
  if (sub === undefined) return false;
  return INDEX_CLI_SEARCH.some(
    ([binary, subcommands]) => bare === binary && subcommands.test(sub),
  );
}

interface SourceReadMatch {
  matched: boolean;
  target: string | null;
}

function sourceReadOf(
  tokens: string[],
  pipelineHasSourcePath: boolean,
): SourceReadMatch {
  const head = tokens[0];
  if (head === undefined) return { matched: false, target: null };
  const bare = head.split("/").pop() ?? head;

  // 이름 목록이 다섯 개뿐이라 awk·python3·node·perl 로 같은 읽기를 하면 판정 자체가
  // 안 됐다. 분자에서만 빠지는 게 아니라 분모에서도 빠져 축이 그 활동을 통째로 못 본다.
  // 실측 2,152건이 그 상태였고, 그중 1,427건이 소스·문서 확장자를 인자로 들고 있었다.
  if (!/^(cat|head|tail|bat|sed|awk|perl|python3?|node)$/.test(bare))
    return { matched: false, target: null };
  if (bare === "sed" && !tokens.some((t) => t === "-n" || /^-n/.test(t))) {
    return { matched: false, target: null };
  }

  // 인터프리터는 인라인 코드일 때만 본다. `node scripts/build.mjs` 는 스크립트 실행이지
  // 파일을 텍스트로 읽는 것이 아니다. 인자가 코드 파일이라는 것만으로 읽기라고 하면
  // 빌드·테스트 실행이 통째로 계측 위반이 된다.
  const isInterpreter = /^(python3?|node|perl)$/.test(bare);
  if (isInterpreter) {
    if (!tokens.some((t) => /^-[a-zA-Z]*[cep]$/.test(t)))
      return { matched: false, target: null };
    const inlined = tokens.find(
      (t) => t.includes("/") && isReadableSourcePath(stripQuotesAndCalls(t)),
    );
    return inlined === undefined
      ? { matched: false, target: null }
      : { matched: true, target: stripQuotesAndCalls(inlined) };
  }

  const fileArg = tokens
    .slice(1)
    .find((t) => !t.startsWith("-") && isReadableSourcePath(t));
  if (fileArg !== undefined) return { matched: true, target: fileArg };

  // 파일 인자가 없는 파이프 수신 세그먼트. 상류에 소스 경로가 있으면 계측 밖 읽기로 본다.
  if (bare === "sed" && pipelineHasSourcePath)
    return { matched: true, target: null };
  return { matched: false, target: null };
}

interface WriteMatch {
  rule: string;
  target: string | null;
}

const REDIRECT_TARGET = /(?:^|[^>\d])>>?\s*(["']?)([^\s|&;<>"']+)\1/;

function fileWriteOf(
  segment: string,
  tokens: string[],
  scriptWritesFile: boolean,
): WriteMatch | null {
  const head = tokens[0]?.split("/").pop() ?? "";

  if (
    head === "sed" &&
    tokens.some((t) => t === "-i" || /^-[a-zA-Z]*i$/.test(t))
  ) {
    const target = tokens
      .slice(1)
      .find((t) => !t.startsWith("-") && t.includes("."));
    return { rule: "sed-in-place", target: target ?? null };
  }
  if (head === "perl" && tokens.some((t) => /^-[a-zA-Z]*i/.test(t))) {
    const target = tokens
      .slice(1)
      .find((t) => !t.startsWith("-") && t.includes("."));
    return { rule: "perl-in-place", target: target ?? null };
  }
  if (head === "git" && tokens.includes("apply")) {
    return { rule: "git-apply", target: null };
  }
  if (head === "tee") {
    const target = tokens.slice(1).find((t) => !t.startsWith("-"));
    return { rule: "tee", target: target ?? null };
  }

  const redirect = REDIRECT_TARGET.exec(segment);
  if (redirect !== null) {
    const target = redirect[2] ?? null;
    // stderr 버리기(`2>/dev/null`)나 임시 출력은 편집이 아니다.
    if (
      target !== null &&
      target !== "/dev/null" &&
      !target.startsWith("/dev/")
    ) {
      const hasHeredoc = /<<-?\s*['"]?\w+/.test(segment);
      const looksLikeFile = isReadableSourcePath(target) || hasHeredoc;
      if (looksLikeFile) {
        return {
          rule: hasHeredoc ? "heredoc-to-file" : "redirect-to-file",
          target,
        };
      }
    }
  }

  // 파일을 여는 스크립트 heredoc. stdout만 내는 분석용은 우회가 아니다.
  if (
    scriptWritesFile &&
    /^(python3?|node|ruby|perl)$/.test(head) &&
    /<<-?\s*['"]?\w+/.test(segment)
  ) {
    return { rule: "script-heredoc-write", target: null };
  }
  return null;
}

const FORMATTER = /^(prettier|eslint|gofmt|black|rustfmt|ktlint)$/;

function isFormatterSegment(tokens: string[]): boolean {
  let i = 0;
  if (tokens[0] === "npx" || tokens[0] === "bunx") i = 1;
  const head = tokens[i]?.split("/").pop() ?? "";
  if (!FORMATTER.test(head)) return false;
  return tokens
    .slice(i + 1)
    .some((t) => t === "--write" || t === "--fix" || t === "-w" || t === "-F");
}

/** git 커밋 판정. `git -C <path> commit`처럼 값을 받는 옵션이 앞에 오는 형태를 포함한다. */
const VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

function gitCommitOf(tokens: string[]): {
  isCommit: boolean;
  isAmend: boolean;
} {
  if ((tokens[0]?.split("/").pop() ?? "") !== "git")
    return { isCommit: false, isAmend: false };
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (VALUE_OPTIONS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("--") && t.includes("=")) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  if (tokens[i] !== "commit") return { isCommit: false, isAmend: false };
  return { isCommit: true, isAmend: tokens.slice(i + 1).includes("--amend") };
}

export interface BashClassification {
  isFormatter: boolean;
  verifierKinds: string[];
  /**
   * 한 호출 안에서 검증이 커밋보다 앞섰는가. 커밋이 없는 호출은 항상 false 다.
   *
   * 이 값이 없으면 `git commit && tsc` 가 `tsc && git commit` 과 구분되지 않아,
   * 커밋한 뒤에 돈 검증도 커밋 전 검증으로 잡힌다.
   */
  hasVerifierBeforeCommit: boolean;
  /** 파일 찾기와 내용 찾기의 합집합. 진단이 둘을 함께 볼 때 쓴다. */
  isRecursiveSearch: boolean;
  /** `find -name` 류. 옳은 대안은 Glob 도구다. */
  isFileFind: boolean;
  /** `grep -r`·`rg` 류. 옳은 대안은 qmd·graphify 다. */
  isContentSearch: boolean;
  /** `qmd query`·`graphify explain` 류 CLI 인덱스 검색. */
  isIndexedSearch: boolean;
  isSourceRead: boolean;
  fileWriteRule: string | null;
  /** 쓰기 대상 경로. 축3의 코드 편집 판정에 쓴다. 추출 실패면 null. */
  fileWriteTarget: string | null;
  isCommit: boolean;
  isCommitAmend: boolean;
}

const EMPTY: BashClassification = {
  isFormatter: false,
  verifierKinds: [],
  hasVerifierBeforeCommit: false,
  isRecursiveSearch: false,
  isFileFind: false,
  isContentSearch: false,
  isIndexedSearch: false,
  isSourceRead: false,
  fileWriteRule: null,
  fileWriteTarget: null,
  isCommit: false,
  isCommitAmend: false,
};

export function classifyBash(
  commandRaw: string | null | undefined,
): BashClassification {
  if (commandRaw === null || commandRaw === undefined || commandRaw === "")
    return { ...EMPTY };

  const scriptWritesFile = SCRIPT_WRITES_FILE.test(commandRaw);
  const stripped = stripHeredocBodies(unwrapShellWrapper(commandRaw));
  const segments = splitSegments(stripped);
  const pipelineHasSourcePath = segments.some((s) =>
    s.split(/\s+/).some((t) => !t.startsWith("-") && isReadableSourcePath(t)),
  );
  // 파일 목록의 개수·크기만 세는 파이프. `find … | wc -l` 은 세그먼트가 갈려
  // find 쪽만 봐서는 안 보인다. 내용을 뒤지는 명령이 섞이면 집계가 아니다.
  const pipelineCountsOnly =
    segments.some((s) => /(^|\s)(wc|stat)(\s|$)/.test(s)) &&
    !segments.some((s) => /(^|\s)(grep|rg|cat|sed|awk)(\s|$)/.test(s));

  // 종류가 아니라 실행 횟수를 센다. Set 이면 `npx tsc && npx tsc && npx tsc` 가
  // [tsc] 하나로 접혀 공회전이 안 보인다. 한 호출로 묶는 것이 조작 경로였다.
  const verifierKinds: string[] = [];
  let isFormatter = false;
  let isFileFind = false;
  let isContentSearch = false;
  let isIndexedSearch = false;
  let isSourceRead = false;
  let fileWriteRule: string | null = null;
  let fileWriteTarget: string | null = null;
  let isCommit = false;
  let isCommitAmend = false;
  // 한 호출 안에서 검증이 커밋보다 앞섰는지. 순서를 접어버리면
  // `git commit && tsc` 와 `tsc && git commit` 이 같은 값이 되어, 순서만 바꿔서
  // 신선도를 올리는 경로가 열린다.
  let hasVerifierBeforeCommit = false;

  for (const segment of segments) {
    const tokens = meaningfulTokens(segment);
    if (tokens.length === 0) continue;

    if (isFormatterSegment(tokens)) {
      isFormatter = true;
      continue;
    }

    const segmentVerifiers = verifierKindsOf(tokens);
    if (segmentVerifiers.length > 0 && !isCommit)
      hasVerifierBeforeCommit = true;
    verifierKinds.push(...segmentVerifiers);
    const searchKind = searchKindOfSegment(tokens);
    if (searchKind === "file") isFileFind = true;
    if (searchKind === "content") isContentSearch = true;
    if (isIndexSearchSegment(tokens)) isIndexedSearch = true;

    const write = fileWriteOf(segment, tokens, scriptWritesFile);
    if (write !== null && !isScratchTarget(write.target)) {
      fileWriteRule ??= write.rule;
      fileWriteTarget ??= write.target;
    } else if (write === null) {
      // 쓰기가 아닌 세그먼트만 읽기로 본다. `cat > x.md <<EOF`가 양쪽에 계상되지 않게 한다.
      const read = sourceReadOf(tokens, pipelineHasSourcePath);
      if (read.matched && !isScratchTarget(read.target)) isSourceRead = true;
    }

    const git = gitCommitOf(tokens);
    if (git.isCommit) {
      isCommit = true;
      if (git.isAmend) isCommitAmend = true;
    }
  }

  // 개수만 세는 파이프는 Glob 으로 대체할 수 없어 분모에서 뺀다.
  const globReplaceableFind = isFileFind && !pipelineCountsOnly;

  return {
    isFormatter,
    verifierKinds: [...verifierKinds],
    // 커밋이 없으면 비교 대상이 없으므로 참을 내지 않는다.
    hasVerifierBeforeCommit: isCommit && hasVerifierBeforeCommit,
    isRecursiveSearch: globReplaceableFind || isContentSearch,
    isFileFind: globReplaceableFind,
    isContentSearch,
    isIndexedSearch,
    isSourceRead,
    fileWriteRule,
    fileWriteTarget,
    isCommit,
    isCommitAmend,
  };
}

/**
 * 어느 세그먼트가 판정을 유발했는지 돌려준다.
 *
 * 진단 화면이 명령의 첫 줄을 보여주면 `cd /repo`가 최다 위반으로 올라가 아무 정보가 없다.
 * 실제로 걸린 세그먼트를 보여줘야 고칠 대상이 보인다.
 */
export function offendingSegments(commandRaw: string | null | undefined): {
  sourceRead: string[];
  fileWrite: string[];
  recursiveSearch: string[];
} {
  const out = {
    sourceRead: [] as string[],
    fileWrite: [] as string[],
    recursiveSearch: [] as string[],
  };
  if (commandRaw === null || commandRaw === undefined || commandRaw === "")
    return out;

  const stripped = stripHeredocBodies(commandRaw);
  const segments = splitSegments(stripped);
  const pipelineHasSourcePath = segments.some((seg) =>
    seg.split(/\s+/).some((t) => !t.startsWith("-") && isReadableSourcePath(t)),
  );
  const scriptWritesFile = SCRIPT_WRITES_FILE.test(commandRaw);

  for (const segment of segments) {
    const tokens = meaningfulTokens(segment);
    if (tokens.length === 0) continue;
    if (isFormatterSegment(tokens)) continue;

    if (isRecursiveSearchSegment(tokens)) out.recursiveSearch.push(segment);

    const write = fileWriteOf(segment, tokens, scriptWritesFile);
    if (write !== null && !isScratchTarget(write.target)) {
      out.fileWrite.push(write.target ?? segment);
    } else if (write === null) {
      const read = sourceReadOf(tokens, pipelineHasSourcePath);
      if (read.matched && !isScratchTarget(read.target)) {
        out.sourceRead.push(read.target ?? segment);
      }
    }
  }
  return out;
}

/**
 * 검색 명령에서 찾으려는 대상만 뽑는다.
 *
 * 명령 전체를 비교하면 같은 것을 찾는 재검색이 거의 안 잡힌다(실측 7/2364).
 * 그렇다고 공백으로 자르면 따옴표 안의 패턴이 잘려 서로 다른 검색이 같은 것으로 뭉친다.
 * 읽기 전용과 읽기전용 금지가 둘 다 앞 두 글자로 뭉치는 식이다.
 * 그래서 따옴표 묶음을 보존해서 패턴 전체를 키로 쓴다.
 *
 * find 의 glob 은 단독으로 쓰면 확장자 하나로 전부 뭉치므로 탐색 루트와 짝지어 키를 만든다.
 */
export function searchTermOf(
  commandRaw: string | null | undefined,
): string | null {
  if (commandRaw === null || commandRaw === undefined) return null;
  for (const segment of splitSegments(stripHeredocBodies(commandRaw))) {
    const tokens = meaningfulTokens(segment);
    if (!isRecursiveSearchSegment(tokens)) continue;

    const head = tokens[0]?.split("/").pop() ?? "";
    const args = quotedTokens(segment).slice(1);

    if (head === "find") {
      const root = args.find((t) => !t.startsWith("-")) ?? ".";
      const nameIndex = args.findIndex((t) => /^-i?(name|regex)$/.test(t));
      const pattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      if (pattern === undefined) continue;
      return `find:${root}:${unquote(pattern).toLowerCase()}`;
    }

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (GREP_VALUE_OPTIONS.has(arg)) {
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      return `grep:${unquote(arg).toLowerCase()}`;
    }
  }
  return null;
}

/** 값을 받는 검색 옵션. 다음 토큰을 패턴으로 오인하지 않기 위해 건너뛴다. */
const GREP_VALUE_OPTIONS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-m",
  "--max-count",
  "-A",
  "-B",
  "-C",
  "--include",
  "--exclude",
  "--exclude-dir",
  "-g",
  "--glob",
  "-t",
  "--type",
]);

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, "");
}

/**
 * 따옴표 묶음을 하나의 토큰으로 유지하며 자른다.
 * 공백으로만 자르면 여러 단어 패턴이 쪼개져 서로 다른 검색이 같은 키가 된다.
 */
function quotedTokens(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
}
