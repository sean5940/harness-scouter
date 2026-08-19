import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkCoherence,
  ruleDocumentPaths,
  scanHarness,
} from "../src/harness.js";

/**
 * 정합성 검사가 막는 훅만 세는지.
 *
 * "설명 없이 막는 게이트" 는 에이전트가 이유를 못 본 채 막히는 자리를 세려는 것이다.
 * 막지 않는 훅까지 세면 미기재가 부풀려지고, 고칠 필요 없는 것을 문서화하러 간다.
 * 실측(2026-08-19)에서 네 건 중 둘이 그랬다. 하나는 자동 승인만 내고, 하나는
 * 안내만 넣는 비차단 리마인더였다.
 *
 * 그래서 막는 세계와 안 막는 세계를 따로 만들고 앞에서만 세는지 본다.
 */

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "coherence-"));
  const hooks = join(root, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });

  // 막는 훅. 어느 문서에도 이름이 없다.
  writeFileSync(
    join(hooks, "blocking-gate.sh"),
    '#!/usr/bin/env bash\necho \'{"permissionDecision": "deny"}\'\n',
    "utf8",
  );
  // 자동 승인만 내는 훅. 막은 적이 없다.
  writeFileSync(
    join(hooks, "auto-allow.sh"),
    '#!/usr/bin/env bash\necho \'{"permissionDecision": "allow"}\'\n',
    "utf8",
  );
  // 안내만 넣는 비차단 훅.
  writeFileSync(
    join(hooks, "soft-reminder.sh"),
    '#!/usr/bin/env bash\necho \'{"hookSpecificOutput": {"additionalContext": "hi"}}\'\nexit 0\n',
    "utf8",
  );

  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { command: "$CLAUDE_PROJECT_DIR/.claude/hooks/blocking-gate.sh" },
              { command: "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-allow.sh" },
              {
                command:
                  'bash "$(git rev-parse --show-toplevel)/.claude/hooks/soft-reminder.sh"',
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

describe("설명 없이 막는 게이트는 막는 것만 센다", () => {
  it("막는 훅만 미기재로 잡는다", () => {
    const root = fixture();
    const report = checkCoherence(scanHarness(root), ruleDocumentPaths(root));
    expect(report.undocumentedSensors).toEqual(["blocking-gate.sh"]);
  });

  it("자동 승인과 비차단 안내는 세지 않는다", () => {
    const root = fixture();
    const report = checkCoherence(scanHarness(root), ruleDocumentPaths(root));
    expect(report.undocumentedSensors).not.toContain("auto-allow.sh");
    expect(report.undocumentedSensors).not.toContain("soft-reminder.sh");
  });

  it("문서에 이름이 있으면 막는 훅도 안 잡는다", () => {
    const root = fixture();
    mkdirSync(join(root, ".agent", "references"), { recursive: true });
    writeFileSync(
      join(root, ".agent", "references", "gates.md"),
      "blocking-gate.sh 는 이러이러해서 막습니다.\n",
      "utf8",
    );
    const report = checkCoherence(scanHarness(root), ruleDocumentPaths(root));
    expect(report.undocumentedSensors).toEqual([]);
  });
});
