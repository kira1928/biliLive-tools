import { EventEmitter } from "node:events";
import type { Context } from "koa";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BalanceError } from "@bililive-tools/douyin-recorder/loadBalancer/errors.js";
import { bgoRequest, bgoRequestTimeout } from "../src/routes/bgoRequest.js";

function context() {
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  return { res, set: vi.fn(), status: 200, body: undefined } as unknown as Context;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ["BGO_BALANCE_COOLDOWN", 503],
  ["BGO_BALANCE_BUSY", 503],
  ["BGO_BALANCE_UPSTREAM", 502],
] as const)("%s 保留分类并映射 HTTP %s", async (code, status) => {
  const ctx = context();
  const details =
    code === "BGO_BALANCE_COOLDOWN"
      ? { retryAt: new Date(Date.now() + 180_000).toISOString() }
      : {};
  await bgoRequest(ctx, async () => {
    throw new BalanceError(code, details);
  });
  expect(ctx.status).toBe(status);
  expect(ctx.body).toMatchObject({ code, ...details });
  if (status === 503)
    expect(ctx.set).toHaveBeenCalledWith(
      "Retry-After",
      code === "BGO_BALANCE_COOLDOWN" ? "180" : "1",
    );
  expect(ctx.res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("上游错误正文不能泄漏 Cookie 或签名 URL", async () => {
  const ctx = context();
  await bgoRequest(ctx, async () => {
    throw Object.assign(new Error("Cookie: secret; https://example.com/?sign=secret"), {
      response: { status: 444 },
    });
  });
  expect(ctx.status).toBe(502);
  expect(ctx.body).toMatchObject({ code: "BGO_UPSTREAM", kind: "http", upstreamStatus: 444 });
  expect(JSON.stringify(ctx.body)).not.toContain("secret");
});

it("未开播属于成功响应", async () => {
  const ctx = context();
  await bgoRequest(ctx, async () => ({ living: false }));
  expect(ctx.status).toBe(200);
  expect(ctx.body).toEqual({ living: false });
  expect(ctx.res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("总预算超时触发实际调用的 AbortSignal，并等实际调用结束", async () => {
  const ctx = context();
  let signal!: AbortSignal;
  let reject!: (error: unknown) => void;
  let completed = false;
  const call = bgoRequest(ctx, async (s) => {
    signal = s;
    return new Promise((_, rej) => {
      reject = rej;
    });
  }).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(bgoRequestTimeout);
  expect(signal.aborted).toBe(true);
  expect(completed).toBe(false);
  reject(signal.reason);
  await call;
  expect(ctx.status).toBe(504);
  expect(ctx.body).toMatchObject({ code: "BGO_REQUEST_TIMEOUT" });
  expect(ctx.res.listenerCount("close")).toBe(0);
});

it("客户端断开立即取消上游，清理事件监听和超时计时器", async () => {
  const ctx = context();
  let signal!: AbortSignal;
  const call = bgoRequest(ctx, async (s) => {
    signal = s;
    return new Promise((_, reject) =>
      s.addEventListener("abort", () => reject(s.reason), { once: true }),
    );
  });
  ctx.res.emit("close");
  await call;
  expect(signal.aborted).toBe(true);
  expect(ctx.body).toMatchObject({ code: "BGO_REQUEST_CANCELED" });
  expect(ctx.res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
