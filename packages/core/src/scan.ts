import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ScouterDb, type ScanStats } from "./db.js";
import { extractFacts } from "./extract.js";
import { decodeProjectDir, parseJsonlFile } from "./parser.js";

export function defaultTranscriptRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export function defaultDbPath(): string {
  return join(homedir(), ".harness-scouter", "scouter.sqlite");
}

export interface ScanOptions {
  root?: string;
  onProgress?: (done: number, total: number) => void;
}

/** 워크플로 실행 기록. 대화 트랜스크립트가 아니라 스킵한다. */
const NON_TRANSCRIPT_FILES = new Set(["journal.jsonl"]);

/**
 * 프로젝트 디렉토리 아래 트랜스크립트를 전부 모은다.
 *
 * 최상위에 메인 세션 파일이 있고, 세션 아이디 아래 subagents 디렉토리와 workflows
 * 디렉토리에 subagent 파일이 따로 쌓인다. subagent 파일도 같은 sessionId를 쓰므로
 * 부모 세션에 합쳐진다. 이걸 빼면 위임한 작업이 통째로 측정에서 빠져
 * "위임하면 점수가 오르는" 구멍이 생긴다.
 */
async function collectTranscripts(
  dir: string,
  project: string,
  out: Array<{ path: string; project: string }>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTranscripts(full, project, out);
    } else if (
      entry.name.endsWith(".jsonl") &&
      !NON_TRANSCRIPT_FILES.has(entry.name)
    ) {
      out.push({ path: full, project });
    }
  }
}

/**
 * 트랜스크립트를 훑어 사실 테이블을 갱신한다.
 *
 * 변경된 파일만 커서 이후부터 읽으므로 두 번째 실행부터는 새로 쌓인 줄만 처리한다.
 * 전체 재파싱은 파일이 잘렸거나 mtime이 역행했을 때만 그 파일에 한해 일어난다.
 */
export async function scan(
  db: ScouterDb,
  options: ScanOptions = {},
): Promise<ScanStats> {
  const root = options.root ?? defaultTranscriptRoot();
  const stats: ScanStats = {
    filesScanned: 0,
    filesChanged: 0,
    entriesParsed: 0,
    malformedLines: 0,
    fullReparses: 0,
  };

  const projectDirs = await readdir(root, { withFileTypes: true });
  const targets: Array<{ path: string; project: string }> = [];
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const project = decodeProjectDir(dirent.name);
    await collectTranscripts(join(root, dirent.name), project, targets);
  }

  let done = 0;
  for (const target of targets) {
    stats.filesScanned += 1;
    const cursor = db.getCursor(target.path);
    let result;
    try {
      result = await parseJsonlFile(target.path, cursor);
    } catch {
      // 스캔 중 지워진 파일. 다음 회차에 사라진 채로 남는다.
      done += 1;
      continue;
    }

    if (result.entries.length > 0) {
      stats.filesChanged += 1;
      stats.entriesParsed += result.entries.length;
      stats.malformedLines += result.malformedLines;
      if (result.reparsedFromStart && cursor !== null) stats.fullReparses += 1;

      const facts = extractFacts(
        result.entries,
        target.project,
        target.path,
      );
      db.applyFile(
        target.path,
        { mtimeMs: result.mtimeMs, byteOffset: result.byteOffset },
        facts,
        result.reparsedFromStart && cursor !== null,
      );
    }

    done += 1;
    options.onProgress?.(done, targets.length);
  }

  return stats;
}
