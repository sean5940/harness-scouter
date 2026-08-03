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
  return /^\/tmp\/|^\/private\/tmp\/|\/var\/folders\/|scratchpad|\.log$|\.tmp$/.test(
    target,
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

function verifierKindsOf(tokens: string[]): string[] {
  const kinds = new Set<string>();
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

function isRecursiveSearchSegment(tokens: string[]): boolean {
  let i = 0;
  if (tokens[0] === "npx" || tokens[0] === "xargs") i = 1;
  const head = tokens[i];
  if (head === undefined) return false;
  const bare = head.split("/").pop() ?? head;
  if (/^(rg|ag|ack)$/.test(bare)) return true;
  if (bare === "grep") {
    return tokens
      .slice(i + 1)
      .some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive");
  }
  if (bare === "find") {
    return tokens
      .slice(i + 1)
      .some((t) => /^-i?name$/.test(t) || t === "-iregex" || t === "-regex");
  }
  return false;
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

  if (!/^(cat|head|tail|bat|sed)$/.test(bare))
    return { matched: false, target: null };
  if (bare === "sed" && !tokens.some((t) => t === "-n" || /^-n/.test(t))) {
    return { matched: false, target: null };
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
  isRecursiveSearch: boolean;
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
  isRecursiveSearch: false,
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
  const stripped = stripHeredocBodies(commandRaw);
  const segments = splitSegments(stripped);
  const pipelineHasSourcePath = segments.some((s) =>
    s.split(/\s+/).some((t) => !t.startsWith("-") && isReadableSourcePath(t)),
  );

  const verifierKinds = new Set<string>();
  let isFormatter = false;
  let isRecursiveSearch = false;
  let isSourceRead = false;
  let fileWriteRule: string | null = null;
  let fileWriteTarget: string | null = null;
  let isCommit = false;
  let isCommitAmend = false;

  for (const segment of segments) {
    const tokens = meaningfulTokens(segment);
    if (tokens.length === 0) continue;

    if (isFormatterSegment(tokens)) {
      isFormatter = true;
      continue;
    }

    for (const kind of verifierKindsOf(tokens)) verifierKinds.add(kind);
    if (isRecursiveSearchSegment(tokens)) isRecursiveSearch = true;

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

  return {
    isFormatter,
    verifierKinds: [...verifierKinds],
    isRecursiveSearch,
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
  const out = { sourceRead: [] as string[], fileWrite: [] as string[], recursiveSearch: [] as string[] };
  if (commandRaw === null || commandRaw === undefined || commandRaw === "") return out;

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
  "-e", "--regexp", "-f", "--file", "-m", "--max-count",
  "-A", "-B", "-C", "--include", "--exclude", "--exclude-dir",
  "-g", "--glob", "-t", "--type",
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
