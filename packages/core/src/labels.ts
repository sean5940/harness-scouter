import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 세션 라벨은 파생 사실 DB 밖에 둔다.
 *
 * 이 도구의 설계 원칙은 "정의를 바꿀 때 재파싱이 필요 없다"이고, 실제로는 정의를 손볼
 * 때마다 DB 를 지우고 다시 스캔한다. 라벨을 그 DB 에 두면 정의 수정 한 번에 사람이 쌓은
 * 판정이 통째로 사라진다. M1.5 타당성 게이트는 라벨 30건을 요구하는데 30건을 모으는 동안
 * 정의를 한 번도 안 고칠 수는 없으므로, 같은 그릇에 두면 게이트에 영원히 도달하지 못한다.
 *
 * 라벨은 트랜스크립트에서 다시 뽑을 수 없는 유일한 입력이다. 나머지는 전부 재생성된다.
 */

export interface SessionLabel {
  sessionId: string;
  label: "good" | "bad";
  note: string | null;
  labeledAt: string;
}

export function defaultLabelPath(): string {
  return join(homedir(), ".harness-scouter", "labels.jsonl");
}

/**
 * append-only 로 쌓는다.
 *
 * 덮어쓰기를 하면 쓰는 중 죽었을 때 이전 라벨까지 잃는다. 같은 세션을 다시 라벨링하면
 * 읽을 때 마지막 줄이 이긴다.
 */
export function appendLabel(path: string, label: SessionLabel): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(label)}\n`, "utf8");
}

/**
 * 세션마다 마지막 라벨만 남겨 읽는다.
 *
 * 파싱 안 되는 줄은 건너뛴다. 사람이 직접 편집하는 파일이라 한 줄이 깨져도 나머지를
 * 못 읽게 만들면 안 된다.
 */
export function readLabels(path: string): SessionLabel[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const bySession = new Map<string, SessionLabel>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const row = parsed as Record<string, unknown>;
    const sessionId = row["sessionId"];
    const label = row["label"];
    if (typeof sessionId !== "string") continue;
    if (label !== "good" && label !== "bad") continue;
    bySession.set(sessionId, {
      sessionId,
      label,
      note: typeof row["note"] === "string" ? row["note"] : null,
      labeledAt:
        typeof row["labeledAt"] === "string" ? row["labeledAt"] : "(시각 없음)",
    });
  }
  return [...bySession.values()].sort((a, b) =>
    b.labeledAt.localeCompare(a.labeledAt),
  );
}
