import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { guardBrokenPipe } from "./stdio.js";

/** code 를 붙인 쓰기 오류. Node 가 스트림에 올리는 모양을 흉내낸다. */
function writeError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`write ${code}`);
  error.code = code;
  error.syscall = "write";
  return error;
}

describe("guardBrokenPipe", () => {
  it("EPIPE 면 넘긴 함수를 부른다", () => {
    const stream = new EventEmitter();
    const onBrokenPipe = vi.fn();
    guardBrokenPipe(stream, onBrokenPipe);

    stream.emit("error", writeError("EPIPE"));

    expect(onBrokenPipe).toHaveBeenCalledTimes(1);
  });

  it("EPIPE 를 받고 나면 스택트레이스로 죽지 않는다", () => {
    // 핸들러가 없을 때 죽던 자리다. emit 이 던지지 않는 것이 곧 안 죽는다는 뜻이다.
    const stream = new EventEmitter();
    guardBrokenPipe(stream, () => {});

    expect(() => stream.emit("error", writeError("EPIPE"))).not.toThrow();
  });

  it("다른 쓰기 오류는 삼키지 않는다", () => {
    const stream = new EventEmitter();
    const onBrokenPipe = vi.fn();
    guardBrokenPipe(stream, onBrokenPipe);

    expect(() => stream.emit("error", writeError("ENOSPC"))).toThrow("ENOSPC");
    expect(onBrokenPipe).not.toHaveBeenCalled();
  });

  it("code 가 없는 오류도 삼키지 않는다", () => {
    const stream = new EventEmitter();
    guardBrokenPipe(stream, () => {});

    expect(() => stream.emit("error", new Error("무엇인가"))).toThrow("무엇인가");
  });
});
