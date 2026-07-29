import { describe, expect, it } from "vitest";

import {
  classifyBash,
  isEffectivePartialRead,
  verifierOutcome,
} from "../src/definitions.js";

describe("축1 no-op 가드", () => {
  it("파일 전체를 덮는 읽기는 부분읽기가 아니다", () => {
    expect(isEffectivePartialRead(500, 500, 1)).toBe(false);
  });

  it("limit이 파일보다 커도 결과가 전체면 부분읽기가 아니다", () => {
    // `limit: 2000`은 Read의 기본 상한과 같아 아무것도 좁히지 않는다.
    expect(isEffectivePartialRead(300, 300, 1)).toBe(false);
  });

  it("앞부분만 읽으면 부분읽기다", () => {
    expect(isEffectivePartialRead(1000, 200, 1)).toBe(true);
  });

  it("중간부터 읽으면 줄 수가 전체와 같아도 부분읽기다", () => {
    expect(isEffectivePartialRead(1000, 1000, 50)).toBe(true);
  });

  it("크기를 모르면 판정하지 않는다", () => {
    expect(isEffectivePartialRead(null, 100, 1)).toBe(false);
  });
});

describe("bash 분류 — 파일 쓰기", () => {
  it("커밋 메시지 heredoc을 파일 쓰기로 세지 않는다", () => {
    // 느슨한 패턴은 메시지 본문의 `>` 하나에 걸려 커밋을 전부 오분류했다.
    const command = `git commit -m "$(cat <<'EOF'\nfix: 화살표 -> 처리\n\n본문에 > 기호가 있다\nEOF\n)"`;
    expect(classifyBash(command).fileWriteRule).toBeNull();
  });

  it("heredoc을 파일로 리다이렉트하면 쓰기다", () => {
    expect(classifyBash("cat <<'EOF' > src/a.ts\nx\nEOF").fileWriteRule).toBe(
      "heredoc-to-file",
    );
  });

  it("리다이렉트가 heredoc 앞에 와도 쓰기다", () => {
    expect(classifyBash("cat > src/a.ts <<'EOF'\nx\nEOF").fileWriteRule).toBe(
      "heredoc-to-file",
    );
  });

  it("sed -i는 쓰기다", () => {
    expect(classifyBash("sed -i '' 's/a/b/' src/a.ts").fileWriteRule).toBe(
      "sed-in-place",
    );
  });

  it("임시 경로 쓰기는 계측 밖 편집이 아니다", () => {
    expect(
      classifyBash("cat <<'EOF' > /tmp/scratch.json\n{}\nEOF").fileWriteRule,
    ).toBeNull();
  });

  it("포매터는 분자에서 뺀다", () => {
    expect(
      classifyBash("npx prettier --write src/a.ts").fileWriteRule,
    ).toBeNull();
  });

  it("파일을 열지 않는 분석용 heredoc은 쓰기가 아니다", () => {
    expect(
      classifyBash("python3 - <<'EOF'\nprint(sum([1,2]))\nEOF").fileWriteRule,
    ).toBeNull();
  });

  it("파일을 여는 스크립트 heredoc은 쓰기다", () => {
    const command = "python3 - <<'EOF'\nopen('out.ts','w').write('x')\nEOF";
    expect(classifyBash(command).fileWriteRule).toBe("script-heredoc-write");
  });
});

describe("bash 분류 — 소스 읽기", () => {
  it("sed -n으로 소스를 보면 계측 밖 읽기다", () => {
    expect(classifyBash("sed -n '1,30p' src/a.ts").isSourceRead).toBe(true);
  });

  it("임시 파일을 보는 것은 우회가 아니다", () => {
    expect(classifyBash("sed -n '1,5p' /tmp/corpus.jsonl").isSourceRead).toBe(
      false,
    );
  });
});

describe("bash 분류 — 재귀 검색", () => {
  it.each([
    ["grep -rn foo src/", true],
    ["rg foo", true],
    ["find . -name '*.ts'", true],
    ["grep foo a.txt", false],
  ])("%s → %s", (command, expected) => {
    expect(classifyBash(command).isRecursiveSearch).toBe(expected);
  });
});

describe("bash 분류 — 커밋", () => {
  it("amend는 따로 표시한다", () => {
    const k = classifyBash("git commit --amend --no-edit");
    expect(k.isCommit).toBe(true);
    expect(k.isCommitAmend).toBe(true);
  });
});

describe("verifier 성패 판정", () => {
  it("exit code가 명시되면 그걸 쓴다", () => {
    expect(verifierOutcome("...\nEXIT=0")).toBe("pass");
    expect(verifierOutcome("...\nEXIT=2")).toBe("fail");
  });

  it("타입 에러는 실패다", () => {
    expect(verifierOutcome("src/a.ts(3,5): error TS2345: ...")).toBe("fail");
  });

  it("판정할 수 없으면 null을 낸다", () => {
    // is_error로 대신 판정하면 tsc의 정보성 비영 종료를 도구 실패로 세게 된다.
    expect(verifierOutcome("some unrelated output")).toBeNull();
    expect(verifierOutcome(null)).toBeNull();
  });
});
