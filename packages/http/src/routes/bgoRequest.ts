import type { Context } from "koa";
import {
  BalanceError,
  describeFailure,
} from "@bililive-tools/douyin-recorder/loadBalancer/errors.js";

// 为 Go 的 15 秒 HTTP 超时预留响应时间，预算覆盖全部端点回退和实际上游请求。
export const bgoRequestTimeout = 12_000;

export async function bgoRequest<T>(ctx: Context, request: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("抖音查询超时", "TimeoutError"));
  }, bgoRequestTimeout);
  const onClose = () => {
    if (!ctx.res.writableEnded) controller.abort(new DOMException("调用方已断开", "AbortError"));
  };
  ctx.res.once("close", onClose);
  try {
    ctx.body = await request(controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) {
      const timedOut = controller.signal.reason?.name === "TimeoutError";
      ctx.status = timedOut ? 504 : 408;
      ctx.body = {
        code: timedOut ? "BGO_REQUEST_TIMEOUT" : "BGO_REQUEST_CANCELED",
        error: timedOut ? "抖音查询超时" : "调用方已取消查询",
      };
    } else if (error instanceof BalanceError) {
      ctx.status = error.code === "BGO_BALANCE_UPSTREAM" ? 502 : 503;
      ctx.body = { code: error.code, error: error.message, ...error.details };
      if (ctx.status === 503) {
        const delay = error.details.retryAt
          ? Math.max(1, Math.ceil((Date.parse(error.details.retryAt) - Date.now()) / 1000))
          : 1;
        ctx.set("Retry-After", String(delay));
      }
    } else {
      ctx.status = 502;
      ctx.body = { code: "BGO_UPSTREAM", error: "抖音上游查询失败", ...describeFailure(error) };
    }
  } finally {
    clearTimeout(timer);
    ctx.res.off("close", onClose);
  }
}
