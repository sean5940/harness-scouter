import { describe, expect, it } from "vitest";

import { classifyBash } from "../src/bash.js";

/**
 * 적대적 검토에서 재현된 결함들의 회귀 테스트.
 *
 * 전부 "명령 원문 전체에 정규식을 매칭"해서 생긴 것들이라, 세그먼트 판정으로 바꾼 뒤
 * 다시 원문 매칭으로 되돌아가지 않게 고정한다.
 */

describe("커밋 메시지 안의 문자열은 실행이 아니다", () => {
  it("커밋 메시지에 tsc가 있어도 검증 실행으로 세지 않는다", () => {
    // 이 오탐 174건 중에는 커밋이 자기 메시지로 스스로를 신선하다고 판정한 사례가 있었다.
    const command = `git add . && git commit -q -m "revert 후 npx tsc 대조"`;
    const k = classifyBash(command);
    expect(k.verifierKinds).toEqual([]);
    expect(k.isCommit).toBe(true);
  });

  it("커밋 메시지에 grep -r가 있어도 재귀 검색으로 세지 않는다", () => {
    const command = `git commit -m "grep -r 대신 qmd를 쓰도록 바꿈"`;
    expect(classifyBash(command).isRecursiveSearch).toBe(false);
  });
});

describe("여러 줄 명령의 둘째 줄부터도 판정한다", () => {
  it("개행으로 이은 검증을 잡는다", () => {
    // 전체 명령의 30%가 여러 줄이고, 개행으로 잇기만 해도 축이 오르는 조작 레버였다.
    const k = classifyBash("cd /repo\nnpx tsc --noEmit");
    expect(k.verifierKinds).toContain("tsc");
  });

  it("개행 뒤의 재귀 검색을 잡는다", () => {
    expect(
      classifyBash("echo start\ngrep -rn foo src/").isRecursiveSearch,
    ).toBe(true);
  });
});

describe("git 서브커맨드 앞의 값 옵션", () => {
  it.each([
    ["git -C /repo commit -m x", true, false],
    ["git -c user.name=x commit -m y", true, false],
    ["git --git-dir=/r/.git commit -m z", true, false],
    ["git -C /repo commit --amend --no-edit", true, true],
    ["git -C /repo status", false, false],
  ])("%s → commit=%s amend=%s", (command, isCommit, isAmend) => {
    const k = classifyBash(command);
    expect(k.isCommit).toBe(isCommit);
    expect(k.isCommitAmend).toBe(isAmend);
  });
});

describe("find 술어", () => {
  it.each([
    ["find . -iname '*.ts'", true],
    ["find . -name '*.ts'", true],
    ["find . -regex '.*ts'", true],
    ["find . -type f", false],
  ])("%s → %s", (command, expected) => {
    expect(classifyBash(command).isRecursiveSearch).toBe(expected);
  });
});

describe("npm 래퍼 스크립트", () => {
  it.each([
    ["npm run typecheck", "tsc"],
    ["npm run lint", "eslint"],
    ["yarn format:check", "prettier"],
    ["pnpm run test:unit", "test"],
  ])("%s → %s", (command, kind) => {
    expect(classifyBash(command).verifierKinds).toContain(kind);
  });

  it("래퍼를 놓치면 레포마다 값이 달라진다", () => {
    // raw npx tsc를 쓰는 레포와 npm run typecheck를 쓰는 레포가 다르게 잡히면
    // 레포 간 비교가 성립하지 않는다.
    const raw = classifyBash("npx tsc --noEmit").verifierKinds;
    const wrapped = classifyBash("npm run typecheck").verifierKinds;
    expect(wrapped).toEqual(raw);
  });
});

describe("임시 경로 예외는 대상 경로에만 적용한다", () => {
  it("console.log가 들어간 편집이 사라지지 않는다", () => {
    // 초판은 명령 전체에 .log 검사를 걸어 이런 편집이 통째로 축에서 빠졌다.
    const command = "cat <<'EOF' > app/foo.ts\nconsole.log(1)\nEOF";
    const k = classifyBash(command);
    expect(k.fileWriteRule).toBe("heredoc-to-file");
    expect(k.fileWriteTarget).toBe("app/foo.ts");
  });

  it("임시 파일 쓰기는 여전히 면제한다", () => {
    expect(
      classifyBash("cat <<'EOF' > /tmp/x.json\n{}\nEOF").fileWriteRule,
    ).toBeNull();
  });

  it("stderr 버리기는 편집이 아니다", () => {
    expect(
      classifyBash("npx tsc --noEmit 2>/dev/null").fileWriteRule,
    ).toBeNull();
  });
});

describe("쓰기 대상 경로를 뽑는다", () => {
  it.each([
    ["sed -i '' 's/a/b/' app/foo.ts", "app/foo.ts"],
    ["cat > src/x.md <<'EOF'\nhi\nEOF", "src/x.md"],
  ])("%s → %s", (command, target) => {
    expect(classifyBash(command).fileWriteTarget).toBe(target);
  });

  it("문서를 bash로 고친 것도 계측 우회지만 코드 편집은 아니다", () => {
    // 축5a는 잡고 축3 커밋 분모에는 안 들어가야 한다.
    const k = classifyBash("sed -i '' 's/a/b/' docs/design.md");
    expect(k.fileWriteRule).toBe("sed-in-place");
    expect(k.fileWriteTarget).toBe("docs/design.md");
  });
});

describe("읽기와 쓰기를 동시에 세지 않는다", () => {
  it("heredoc으로 파일을 쓰는 명령은 읽기가 아니다", () => {
    const k = classifyBash("cat > notes.md <<'EOF'\nhi\nEOF");
    expect(k.fileWriteRule).not.toBeNull();
    expect(k.isSourceRead).toBe(false);
  });
});
