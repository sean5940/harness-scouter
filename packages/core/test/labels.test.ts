import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendLabel, readLabels } from "../src/labels.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "scouter-labels-")), "labels.jsonl");
}

describe("세션 라벨 저장", () => {
  it("붙인 라벨을 읽어온다", () => {
    const path = tempPath();
    appendLabel(path, {
      sessionId: "s1",
      label: "good",
      note: "메모",
      labeledAt: "2026-08-03T00:00:00.000Z",
    });
    expect(readLabels(path)).toEqual([
      {
        sessionId: "s1",
        label: "good",
        note: "메모",
        labeledAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
  });

  it("같은 세션을 다시 라벨링하면 마지막이 이긴다", () => {
    // append-only 라 두 줄이 남는다. 덮어쓰기를 안 하는 이유는 쓰는 중 죽었을 때
    // 이전 라벨까지 잃지 않기 위함이다.
    const path = tempPath();
    for (const [label, at] of [
      ["good", "2026-08-01T00:00:00.000Z"],
      ["bad", "2026-08-02T00:00:00.000Z"],
    ] as const) {
      appendLabel(path, { sessionId: "s1", label, note: null, labeledAt: at });
    }
    const rows = readLabels(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("bad");
  });

  it("파일이 없으면 빈 목록이다", () => {
    expect(readLabels(join(tmpdir(), "없는파일-scouter.jsonl"))).toEqual([]);
  });

  it("깨진 줄은 건너뛰고 나머지를 살린다", () => {
    // 사람이 직접 편집하는 파일이라 한 줄이 깨져도 전체를 못 읽게 만들면 안 된다.
    const path = tempPath();
    writeFileSync(
      path,
      [
        '{"sessionId":"s1","label":"good","note":null,"labeledAt":"2026-08-01T00:00:00.000Z"}',
        "이건 JSON 이 아니다",
        '{"sessionId":"s2","label":"bad"',
        '{"sessionId":"s3","label":"bad","note":null,"labeledAt":"2026-08-02T00:00:00.000Z"}',
        "",
      ].join("\n"),
      "utf8",
    );
    expect(readLabels(path).map((r) => r.sessionId)).toEqual(["s3", "s1"]);
  });

  it("라벨값이 good·bad 가 아니면 버린다", () => {
    const path = tempPath();
    writeFileSync(
      path,
      '{"sessionId":"s1","label":"괜찮음","labeledAt":"2026-08-01T00:00:00.000Z"}\n',
      "utf8",
    );
    expect(readLabels(path)).toEqual([]);
  });

  it("최근 라벨이 먼저 온다", () => {
    const path = tempPath();
    appendLabel(path, {
      sessionId: "old",
      label: "good",
      note: null,
      labeledAt: "2026-07-01T00:00:00.000Z",
    });
    appendLabel(path, {
      sessionId: "new",
      label: "bad",
      note: null,
      labeledAt: "2026-08-01T00:00:00.000Z",
    });
    expect(readLabels(path).map((r) => r.sessionId)).toEqual(["new", "old"]);
  });
});
