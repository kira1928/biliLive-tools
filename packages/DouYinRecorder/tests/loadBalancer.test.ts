import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APILoadBalancer } from "../src/loadBalancer/loadBalancer.js";
import { getRoomInfo } from "../src/douyin_api.js";

vi.mock("../src/douyin_api.js", () => ({ getRoomInfo: vi.fn() }));
const query = vi.mocked(getRoomInfo);
const offline = { living: false, api: "web", roomId: "1" } as Awaited<
  ReturnType<typeof getRoomInfo>
>;
const upstreamError = Object.assign(new Error("Cookie=secret; https://example.com/?sign=secret"), {
  response: { status: 444 },
});
function deferred() {
  let resolve!: (value: typeof offline) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<typeof offline>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function onlyWeb(config: ConstructorParameters<typeof APILoadBalancer>[0] = {}) {
  const balancer = new APILoadBalancer(config);
  for (const api of ["webHTML", "mobile", "userHTML"] as const) {
    balancer.updateEndpointConfig(api, { weight: 0 });
  }
  return balancer;
}
function webState(balancer: APILoadBalancer) {
  return balancer.getEndpointStatus().find((s) => s.endpoint.name === "web")!;
}
async function fail(balancer: APILoadBalancer) {
  query.mockRejectedValue(upstreamError);
  await expect(balancer.callWithLoadBalance("1")).rejects.toMatchObject({
    code: "BGO_BALANCE_UPSTREAM",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  query.mockReset();
  vi.spyOn(Math, "random").mockReturnValue(0.25);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("抖音共享端点熔断", () => {
  it("20 个在途失败不能放大计数或延长已经开始的冷却", async () => {
    const balancer = onlyWeb();
    query.mockRejectedValue(upstreamError);
    const pending = Array.from({ length: 20 }, () => deferred());
    for (const item of pending) query.mockImplementationOnce(() => item.promise);
    const calls = pending.map((_, i) => balancer.callWithLoadBalance(String(i)).catch((e) => e));
    for (let i = 0; i < 3; i++) {
      pending[i].reject(upstreamError);
      await calls[i];
    }
    const blocked = webState(balancer);
    expect(blocked.failureCount).toBe(3);
    expect(blocked.nextRetryTime).toBe(Date.now() + 180_000);
    vi.setSystemTime(Date.now() + 60_000);
    for (let i = 3; i < pending.length; i++) pending[i].reject(upstreamError);
    await Promise.all(calls);
    expect(webState(balancer)).toEqual(blocked);
    expect(query).toHaveBeenCalledTimes(20);
  });

  it("迟到成功不能解除新一轮熔断", async () => {
    const balancer = onlyWeb({ maxFailures: 1 });
    const old = deferred();
    query.mockImplementationOnce(() => old.promise);
    const call = balancer.callWithLoadBalance("old");
    await fail(balancer);
    const blocked = webState(balancer);
    old.resolve(offline);
    await call;
    expect(webState(balancer)).toEqual(blocked);
  });

  it("冷却到期只允许一个探测，成功后才恢复普通请求", async () => {
    const balancer = onlyWeb({ maxFailures: 1 });
    await fail(balancer);
    await expect(balancer.callWithLoadBalance("early")).rejects.toMatchObject({
      code: "BGO_BALANCE_COOLDOWN",
      details: { retryAt: new Date(Date.now() + 180_000).toISOString() },
    });
    vi.setSystemTime(webState(balancer).nextRetryTime);
    const probe = deferred();
    query.mockImplementationOnce(() => probe.promise);
    const call = balancer.callWithLoadBalance("probe");
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => balancer.callWithLoadBalance("other").catch((e) => e)),
    );
    expect(outcomes.every((e) => e.code === "BGO_BALANCE_BUSY")).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(webState(balancer)).toMatchObject({ isBlocked: true, isProbing: true });
    probe.resolve(offline);
    await call;
    expect(webState(balancer)).toMatchObject({
      isBlocked: false,
      isProbing: false,
      failureCount: 0,
      nextRetryTime: 0,
    });
    query.mockResolvedValue(offline);
    await expect(balancer.callWithLoadBalance("next")).resolves.toEqual(offline);
  });

  it("反复失败的探测每次最多冷却配置上限", async () => {
    const balancer = onlyWeb({ maxFailures: 1, blockDuration: 600_000, maxBlockDuration: 180_000 });
    for (let i = 0; i < 10; i++) {
      await fail(balancer);
      expect(webState(balancer).nextRetryTime - Date.now()).toBe(180_000);
      expect(webState(balancer).failureCount).toBe(1);
      vi.setSystemTime(webState(balancer).nextRetryTime);
    }
  });

  it("成功的未开播查询清零连续失败计数", async () => {
    const balancer = onlyWeb();
    await fail(balancer);
    await fail(balancer);
    query.mockResolvedValue(offline);
    await expect(balancer.callWithLoadBalance("offline")).resolves.toEqual(offline);
    expect(webState(balancer).failureCount).toBe(0);
    await fail(balancer);
    expect(webState(balancer)).toMatchObject({ failureCount: 1, isBlocked: false });
  });

  it.each([undefined, 123, "", "uid"])("一次查询不会重复端点，uid=%s", async (uid) => {
    const balancer = new APILoadBalancer();
    query.mockRejectedValue(upstreamError);
    await expect(balancer.callWithLoadBalance("1", { uid })).rejects.toMatchObject({
      code: "BGO_BALANCE_UPSTREAM",
    });
    const apis = query.mock.calls.map(([, opts]) => opts!.api);
    expect(new Set(apis).size).toBe(apis.length);
    expect(apis.length).toBe(uid === "uid" ? 4 : 2);
    if (uid !== "uid") expect(apis.sort()).toEqual(["web", "webHTML"]);
  });

  it("HTML 解析失败后仍能使用另一有效端点", async () => {
    const balancer = new APILoadBalancer();
    query.mockRejectedValueOnce(new Error("No match found in HTML")).mockResolvedValueOnce(offline);
    await expect(balancer.callWithLoadBalance("1")).resolves.toEqual(offline);
    expect(query.mock.calls.map(([, opts]) => opts!.api)).toEqual(["webHTML", "web"]);
  });

  it.each(["success", "failure"])("手动重置隔离旧结果：%s", async (outcome) => {
    const balancer = onlyWeb({ maxFailures: 1 });
    const old = deferred();
    query.mockImplementationOnce(() => old.promise);
    const call = balancer.callWithLoadBalance("old").catch((e) => e);
    balancer.resetAllEndpoints();
    await fail(balancer);
    const current = webState(balancer);
    if (outcome === "success") old.resolve(offline);
    else old.reject(upstreamError);
    await call;
    expect(webState(balancer)).toEqual(current);
  });

  it("取消探测后等实际请求结束才释放名额，取消不计失败", async () => {
    const balancer = onlyWeb({ maxFailures: 1 });
    await fail(balancer);
    vi.setSystemTime(webState(balancer).nextRetryTime);
    const controller = new AbortController();
    const probe = deferred();
    query.mockImplementationOnce(() => probe.promise);
    const call = balancer
      .callWithLoadBalance("probe", { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    await expect(balancer.callWithLoadBalance("other")).rejects.toMatchObject({
      code: "BGO_BALANCE_BUSY",
    });
    const retryAt = webState(balancer).nextRetryTime;
    probe.reject(controller.signal.reason);
    expect(await call).toBe(controller.signal.reason);
    expect(webState(balancer)).toMatchObject({
      failureCount: 1,
      isBlocked: true,
      isProbing: false,
      nextRetryTime: retryAt,
    });
    query.mockResolvedValue(offline);
    await expect(balancer.callWithLoadBalance("next")).resolves.toEqual(offline);
  });

  it("预先取消的请求不触达上游", async () => {
    const signal = AbortSignal.abort();
    await expect(onlyWeb().callWithLoadBalance("1", { signal })).rejects.toBe(signal.reason);
    expect(query).not.toHaveBeenCalled();
  });

  it("对外状态快照不能修改真实端点", () => {
    const balancer = onlyWeb();
    balancer.getEndpointStatus()[0].endpoint.weight = 0;
    expect(webState(balancer).endpoint.weight).toBe(1);
  });

  it("返回错误和日志不含上游 Cookie 或签名地址", async () => {
    const balancer = onlyWeb();
    query.mockRejectedValue(upstreamError);
    const error = await balancer.callWithLoadBalance("1").catch((e) => e);
    expect(error).toMatchObject({
      code: "BGO_BALANCE_UPSTREAM",
      details: { api: "web", kind: "http", upstreamStatus: 444 },
    });
    expect(
      error.message + JSON.stringify(error) + JSON.stringify(vi.mocked(console.warn).mock.calls),
    ).not.toContain("secret");
  });
});
