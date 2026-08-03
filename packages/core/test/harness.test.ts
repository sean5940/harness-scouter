import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkCoherence,
  ruleDocumentPaths,
  scanHarness,
  summarizeHarness,
} from "../src/harness.js";

/**
 * 하네스 구조 스캔의 회귀 테스트.
 *
 * 이 스캔이 있어야 "차단 0건"이 센서가 좋아서인지 없어서인지 갈린다.
 * 행동 지표만으로는 훅을 하나도 안 깐 하네스가 만점을 받는다.
 */

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "scouter-harness-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "/h/pre-commit-gate.sh" }] },
        ],
        PostToolUse: [
          { matcher: "Edit", hooks: [{ command: "/h/post-review-agent.sh" }] },
        ],
        Stop: [{ hooks: [{ command: "/h/drift-scan.sh" }] }],
      },
      permissions: { deny: ["Bash(rm -rf:*)"], allow: ["Bash(ls)"] },
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { lint: "eslint .", dev: "vite", test: "vitest" },
    }),
    "utf8",
  );
  writeFileSync(join(root, "CLAUDE.md"), "규칙\n둘\n셋\n", "utf8");
  mkdirSync(join(root, ".claude", "skills", "review"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "review", "SKILL.md"), "x\n");
  mkdirSync(join(root, ".claude", "skills", "planning"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "planning", "SKILL.md"), "y\n");
  return root;
}

describe("하네스 구조 스캔", () => {
  it("훅을 방향과 단계로 나눠 센다", () => {
    const inv = scanHarness(fixture());
    const hooks = inv.sensors.filter((s) => s.kind === "hook");
    expect(hooks).toHaveLength(3);
    // PreToolUse 는 행동 전에 방향을 트니 feedforward, PostToolUse 는 결과를 보니 feedback.
    expect(hooks.find((h) => h.name === "pre-commit-gate.sh")?.direction).toBe(
      "feedforward",
    );
    expect(
      hooks.find((h) => h.name === "post-review-agent.sh")?.direction,
    ).toBe("feedback");
    expect(hooks.find((h) => h.name === "drift-scan.sh")?.stage).toBe(
      "monitoring",
    );
  });

  it("모델을 부르는 훅은 inferential 로 가른다", () => {
    const inv = scanHarness(fixture());
    expect(
      inv.sensors.find((s) => s.name === "post-review-agent.sh")?.execution,
    ).toBe("inferential");
    expect(
      inv.sensors.find((s) => s.name === "pre-commit-gate.sh")?.execution,
    ).toBe("computational");
  });

  it("deny 는 센서고 allow 는 아니다", () => {
    const inv = scanHarness(fixture());
    const perms = inv.sensors.filter((s) => s.kind === "permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]?.name).toBe("Bash(rm -rf:*)");
  });

  it("검증 스크립트만 센서로 세고 실행 스크립트는 뺀다", () => {
    const inv = scanHarness(fixture());
    const scripts = inv.sensors.filter((s) => s.kind === "script");
    expect(scripts.map((s) => s.name).sort()).toEqual([
      "npm run lint",
      "npm run test",
    ]);
  });

  it("검사 성격 스킬은 수동 센서, 나머지는 가이드", () => {
    // 기억해야 도는 센서라 자동 발동과 갈라 센다.
    const inv = scanHarness(fixture());
    expect(inv.sensors.find((s) => s.kind === "skill")?.name).toBe("review");
    expect(inv.guides.some((g) => g.name === "planning")).toBe(true);
    expect(inv.guides.some((g) => g.name === "review")).toBe(false);
  });

  it("규칙 문서를 분량과 함께 센다", () => {
    const inv = scanHarness(fixture());
    const doc = inv.guides.find((g) => g.kind === "rule-doc");
    expect(doc?.name).toBe("CLAUDE.md");
    expect(doc?.lines).toBeGreaterThan(0);
  });

  it("센서 없는 단계를 짚어낸다", () => {
    // CI 가 없으면 통합 후 단계가 빈다. 없는 것과 못 본 것을 구별해야 한다.
    const sum = summarizeHarness(scanHarness(fixture()));
    expect(sum.emptyStages).toContain("post-integration");
  });

  it("설정이 하나도 없어도 죽지 않는다", () => {
    const empty = mkdtempSync(join(tmpdir(), "scouter-empty-"));
    const sum = summarizeHarness(scanHarness(empty));
    expect(sum.sensorCount).toBe(0);
    expect(sum.emptyStages).toHaveLength(4);
  });
});

describe("가이드·센서 동기화", () => {
  it("문서에 이름이 안 나오는 훅을 짚어낸다", () => {
    // 설명을 못 본 채 막히는 게이트다. Fowler 가 남긴 미해결 질문 중 하나.
    const root = fixture();
    writeFileSync(
      join(root, "CLAUDE.md"),
      "커밋 전 pre-commit-gate.sh 가 검증을 확인합니다.\n",
      "utf8",
    );
    const report = checkCoherence(scanHarness(root), ruleDocumentPaths(root));
    expect(report.undocumentedSensors).toContain("post-review-agent.sh");
    expect(report.undocumentedSensors).not.toContain("pre-commit-gate.sh");
  });

  it("확장자를 뺀 이름으로 적혀 있어도 인정한다", () => {
    const root = fixture();
    writeFileSync(
      join(root, "CLAUDE.md"),
      "drift-scan 이 매 세션 끝에 돕니다.\n",
    );
    const report = checkCoherence(scanHarness(root), ruleDocumentPaths(root));
    expect(report.undocumentedSensors).not.toContain("drift-scan.sh");
  });

  it("검사에 쓴 문서 수를 함께 낸다", () => {
    // 범위가 결론을 크게 바꾼다. 같은 저장소에서 규칙 문서만 보면 21종, 스킬까지 넣으면 4종이었다.
    const report = checkCoherence(
      scanHarness(fixture()),
      ruleDocumentPaths(fixture()),
    );
    expect(report.documentsChecked).toBeGreaterThan(0);
    expect(report.sensorsChecked).toBe(3);
  });

  it("읽을 문서가 없으면 전부 미기재로 나온다", () => {
    const report = checkCoherence(scanHarness(fixture()), []);
    expect(report.documentsChecked).toBe(0);
    expect(report.undocumentedSensors).toHaveLength(3);
  });
});
