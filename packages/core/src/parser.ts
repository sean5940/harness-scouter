import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { RawEntry } from "./types.js";

export interface FileCursor {
  path: string;
  mtimeMs: number;
  byteOffset: number;
}

export interface ParseResult {
  entries: RawEntry[];
  /** 완전한 줄까지만 소비한 위치. 쓰기 중인 파일의 잘린 마지막 줄을 다음 회차로 넘긴다. */
  byteOffset: number;
  mtimeMs: number;
  /** JSON.parse에 실패해 버린 줄 수. 0이 아니면 진단에 남긴다. */
  malformedLines: number;
  /** 커서를 무시하고 전체를 다시 읽었는지. 파일이 잘리거나 mtime이 역행하면 true. */
  reparsedFromStart: boolean;
}

/**
 * JSONL 파일을 커서 이후부터 읽는다.
 *
 * append-only라 증분이 성립하지만 두 가지 예외가 있다. 파일이 줄었으면(로테이션·삭제 후
 * 재생성) 오프셋이 엉뚱한 줄 가운데를 가리키고, mtime이 역행했으면 다른 파일로 교체된
 * 것이다. 두 경우 모두 그 파일만 처음부터 다시 읽는다.
 */
export async function parseJsonlFile(
  path: string,
  cursor: FileCursor | null,
): Promise<ParseResult> {
  const info = await stat(path);
  const size = info.size;
  const mtimeMs = info.mtimeMs;

  let start = 0;
  let reparsedFromStart = true;
  if (
    cursor !== null &&
    cursor.byteOffset <= size &&
    cursor.mtimeMs <= mtimeMs
  ) {
    start = cursor.byteOffset;
    reparsedFromStart = false;
  }

  if (start >= size) {
    return {
      entries: [],
      byteOffset: start,
      mtimeMs,
      malformedLines: 0,
      reparsedFromStart,
    };
  }

  const entries: RawEntry[] = [];
  let malformedLines = 0;
  let consumed = start;

  const stream = createReadStream(path, { start, encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let sawTrailingFragment = false;
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (consumed + lineBytes > size) {
      // 개행으로 끝나지 않은 마지막 조각. 다음 회차에 완성된 줄로 다시 읽는다.
      sawTrailingFragment = true;
      break;
    }
    consumed += lineBytes;
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as RawEntry);
    } catch {
      malformedLines += 1;
    }
  }
  rl.close();
  stream.destroy();

  // 파일이 개행 없이 끝나면 마지막 줄은 위 루프에서 소비되지 않는다.
  if (!sawTrailingFragment) consumed = size;

  return {
    entries,
    byteOffset: consumed,
    mtimeMs,
    malformedLines,
    reparsedFromStart,
  };
}

/** 트랜스크립트 디렉토리 이름은 작업 경로를 인코딩한 것이라, 표시용 경로로 되돌린다. */
export function decodeProjectDir(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}
