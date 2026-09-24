import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRoomInfo } from "../src/douyin_api.js";
import { describeFailure } from "../src/loadBalancer/errors.js";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get }) } }));
vi.mock("../src/sign.js", () => ({
  ABogus: class {
    generateAbogus() {
      return ["query", "", "ua"];
    }
  },
}));

beforeEach(() => {
  get.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["web", "webHTML", "mobile", "userHTML"] as const)(
  "%s 请求使用可取消的实际传输",
  async (api) => {
    const controller = new AbortController();
    let stopped = false;
    get.mockImplementationOnce(
      (_url, options) =>
        new Promise((_, reject) => {
          expect(options.signal).toBe(controller.signal);
          options.signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const call = getRoomInfo("123", { api, uid: "uid", auth: "cookie", signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toBe(controller.signal.reason);
    expect(stopped).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  },
);

it("获取匿名 Cookie 的预请求也可取消", async () => {
  const controller = new AbortController();
  get.mockImplementationOnce(
    (_url, options) =>
      new Promise((_, reject) => {
        expect(options.signal).toBe(controller.signal);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  const call = getRoomInfo("123", { api: "web", signal: controller.signal });
  controller.abort();
  await expect(call).rejects.toBe(controller.signal.reason);
  expect(get).toHaveBeenCalledTimes(1);
});

it("nonce 成功后用户页请求继续使用同一个取消信号", async () => {
  const signal = new AbortController().signal;
  get.mockResolvedValueOnce({ headers: { "set-cookie": ["__ac_nonce=test"] } });
  get.mockRejectedValueOnce(new Error("No match found in HTML"));
  await expect(
    getRoomInfo("123", { api: "userHTML", uid: "uid", auth: "cookie", signal }),
  ).rejects.toThrow();
  expect(get).toHaveBeenCalledTimes(2);
  for (const [, options] of get.mock.calls) expect(options.signal).toBe(signal);
});

it.each([
  [new SyntaxError("secret HTML"), { kind: "parse" }],
  [new Error("No match found in HTML"), { kind: "parse" }],
  [Object.assign(new Error("secret"), { code: "ECONNRESET" }), { kind: "network" }],
  [Object.assign(new Error("secret"), { code: "ETIMEDOUT" }), { kind: "timeout" }],
  [new Error("secret"), { kind: "unknown" }],
  [undefined, { kind: "unknown" }],
])("只提取稳定错误分类：%s", (error, expected) => {
  expect(describeFailure(error)).toEqual(expected);
});
