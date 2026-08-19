import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ScouterDb } from "../src/db.js";
import type { ExtractedFacts } from "../src/extract.js";
import type { ExecMode, SessionRow } from "../src/types.js";

/**
 * 세션 병합 회귀 테스트.
 *
 * 한 세션의 기록은 메인 파일과 subagent 파일 여러 개에 흩어지고, 증분 스캔은 그중
 * 한 파일의 새 줄만 들고 온다. 그래서 같은 세션에 대한 upsert가 여러 번 일어나고,
 * 그중 일부는 타임스탬프도 entrypoint도 스킬도 없는 조각이다.
 *
 * 조각이 기존 값을 지우면 그 세션은 listSessions()의 `started_at IS NOT NULL`에
 * 걸려 코퍼스에서 통째로 빠진다. 실측(2026-08-19)에서 111개 중 32개가 이렇게 빠져
 * 있었고, 하필 파일을 많이 걸친 큰 세션들이었다(결손 세션 평균 12.3파일 대 정상 2.4).
 */

function emptyFacts(): ExtractedFacts {
  return {
    sessions: new Map(),
    toolCalls: [],
    toolResults: [],
    artifacts: [],
    sessionEvents: [],
    usages: [],
    stdoutTails: new Map(),
  };
}

function session(over: Partial<SessionRow>): SessionRow {
  return {
    sessionId: "s1",
    project: "/p",
    cwd: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    model: null,
    ccVersion: null,
    entrypoint: null,
    execMode: "unknown" as ExecMode,
    skillsJson: "[]",
    assistantTurns: 0,
    ...over,
  };
}

function factsFor(row: SessionRow): ExtractedFacts {
  const facts = emptyFacts();
  facts.sessions.set(row.sessionId, row);
  return facts;
}

function newDb(): ScouterDb {
  const dir = mkdtempSync(join(tmpdir(), "scouter-merge-"));
  return new ScouterDb(join(dir, "t.sqlite"));
}

/** 파일 하나 분량의 추출 결과를 반영한다. */
function apply(db: ScouterDb, path: string, row: SessionRow): void {
  db.applyFile(path, { mtimeMs: 1, byteOffset: 1 }, factsFor(row), false);
}

describe("세션 upsert가 조각 파일에 값을 잃지 않는다", () => {
  it("타임스탬프 없는 조각이 뒤에 와도 started_at·ended_at이 남는다", () => {
    const db = newDb();
    apply(
      db,
      "/main.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        endedAt: "2026-08-11T07:00:00.000Z",
      }),
    );
    // subagent 파일의 증분에 timestamp가 하나도 없는 경우.
    apply(db, "/sub.jsonl", session({ startedAt: null, endedAt: null }));

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(found?.started_at).toBe("2026-08-11T06:00:00.000Z");
    expect(found?.ended_at).toBe("2026-08-11T07:00:00.000Z");
    db.close();
  });

  it("여러 파일의 시각을 최소·최대로 넓힌다", () => {
    const db = newDb();
    apply(
      db,
      "/a.jsonl",
      session({
        startedAt: "2026-08-11T09:00:00.000Z",
        endedAt: "2026-08-11T10:00:00.000Z",
      }),
    );
    apply(
      db,
      "/b.jsonl",
      session({
        startedAt: "2026-08-11T08:00:00.000Z",
        endedAt: "2026-08-11T11:00:00.000Z",
      }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(found?.started_at).toBe("2026-08-11T08:00:00.000Z");
    expect(found?.ended_at).toBe("2026-08-11T11:00:00.000Z");
    db.close();
  });

  it("entrypoint 없는 조각이 exec_mode를 unknown으로 되돌리지 않는다", () => {
    const db = newDb();
    apply(
      db,
      "/main.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        entrypoint: "cli",
        execMode: "interactive" as ExecMode,
      }),
    );
    apply(
      db,
      "/sub.jsonl",
      session({
        startedAt: "2026-08-11T06:30:00.000Z",
        execMode: "unknown" as ExecMode,
      }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(found?.exec_mode).toBe("interactive");
    db.close();
  });

  it("파일마다 다른 스킬을 합집합으로 모은다", () => {
    const db = newDb();
    apply(
      db,
      "/a.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        skillsJson: JSON.stringify(["planning"]),
      }),
    );
    apply(
      db,
      "/b.jsonl",
      session({
        startedAt: "2026-08-11T06:30:00.000Z",
        skillsJson: JSON.stringify(["implement", "planning"]),
      }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    const skills = JSON.parse(found?.skills_json ?? "[]") as string[];
    expect([...skills].sort()).toEqual(["implement", "planning"]);
    db.close();
  });

  it("cwd가 있으면 디렉토리 이름을 되돌린 추측 대신 그 경로를 쓴다", () => {
    const db = newDb();
    // 디렉토리 이름은 `/`와 `.`을 똑같이 `-`로 인코딩해서 원리적으로 복원할 수 없다.
    // `-Users-sean-jung-Source-sean-soomgo-ai-config` 하나가
    // `/Users/sean.jung/Source/sean-soomgo-ai-config`와
    // `/Users/sean/jung/Source/sean/soomgo/ai/config` 양쪽으로 읽힌다.
    apply(
      db,
      "/main.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        project: "/Users/sean/jung/Source/sean/soomgo/ai/config",
        cwd: "/Users/sean.jung/Source/sean-soomgo-ai-config",
      }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(found?.project).toBe(
      "/Users/sean.jung/Source/sean-soomgo-ai-config",
    );
    db.close();
  });

  it("cwd 없는 조각이 이미 채운 cwd를 지우지 않는다", () => {
    const db = newDb();
    apply(
      db,
      "/main.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        project: "/fallback",
        cwd: "/Users/sean.jung/Source/wt-MG-3660",
      }),
    );
    apply(
      db,
      "/sub.jsonl",
      session({
        startedAt: "2026-08-11T06:30:00.000Z",
        project: "/fallback",
        cwd: null,
      }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(found?.project).toBe("/Users/sean.jung/Source/wt-MG-3660");
    db.close();
  });

  it("스킬 없는 조각이 이미 모은 스킬을 지우지 않는다", () => {
    const db = newDb();
    apply(
      db,
      "/a.jsonl",
      session({
        startedAt: "2026-08-11T06:00:00.000Z",
        skillsJson: JSON.stringify(["review"]),
      }),
    );
    apply(
      db,
      "/b.jsonl",
      session({ startedAt: "2026-08-11T06:30:00.000Z", skillsJson: "[]" }),
    );

    const found = db.listSessions().find((s) => s.session_id === "s1");
    expect(JSON.parse(found?.skills_json ?? "[]")).toEqual(["review"]);
    db.close();
  });
});
