import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("첫 토큰을 명령으로 읽는다", () => {
    expect(parseArgs(["diag"]).command).toBe("diag");
  });

  it("첫 토큰이 플래그면 명령 없이 도움말로 본다", () => {
    const { command, flags } = parseArgs(["--lang", "ko"]);
    expect(command).toBe("help");
    expect(flags.get("lang")).toBe("ko");
  });

  it("빈 인자는 도움말이다", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("공백으로 띄운 값을 읽는다", () => {
    expect(parseArgs(["diag", "--lang", "ko"]).flags.get("lang")).toBe("ko");
  });

  it("등호로 붙인 값을 읽는다", () => {
    expect(parseArgs(["diag", "--lang=ko"]).flags.get("lang")).toBe("ko");
  });

  it("값 없는 플래그는 true 다", () => {
    const flags = parseArgs(["status", "--all", "--lang", "en"]).flags;
    expect(flags.get("all")).toBe("true");
    expect(flags.get("lang")).toBe("en");
  });

  it("마지막 플래그에 값이 없어도 true 다", () => {
    expect(parseArgs(["status", "--all"]).flags.get("all")).toBe("true");
  });

  it("등호 뒤가 비면 빈 문자열이다", () => {
    // resolveLang 은 빈 값을 미지정으로 보고 환경 기준으로 떨어진다.
    expect(parseArgs(["diag", "--lang="]).flags.get("lang")).toBe("");
  });

  it("값 안의 등호는 그대로 둔다", () => {
    expect(parseArgs(["diag", "--db=/tmp/a=b.sqlite"]).flags.get("db")).toBe(
      "/tmp/a=b.sqlite",
    );
  });
});
