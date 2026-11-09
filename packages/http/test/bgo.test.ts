import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import Koa from "koa";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInfo: vi.fn(),
  getStream: vi.fn(),
  resolveChannelInfoFromURL: vi.fn(),
}));

vi.mock("@bililive-tools/douyin-recorder/stream.js", () => ({
  getInfo: mocks.getInfo,
  getStream: mocks.getStream,
}));
vi.mock("@bililive-tools/douyin-recorder/index.js", () => ({
  provider: { resolveChannelInfoFromURL: mocks.resolveChannelInfoFromURL },
}));

import router from "../src/routes/bgo.js";

// 使用真实 Koa 上下文和路由匹配，但不监听端口，也不访问直播平台。
async function request(path: string) {
  const app = new Koa();
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = path;
  const res = new ServerResponse(req);
  const ctx = app.createContext(req, res);
  await router.routes()(ctx, async () => {});
  return { status: ctx.status, body: ctx.body };
}

const liveInfo = {
  title: "直播标题",
  owner: "主播",
  living: true,
  roomId: "123456",
  uid: "987654",
  api: "web",
  avatar: "https://example.com/avatar.png",
};
const streamInfo = {
  ...liveInfo,
  currentStream: {
    name: "原画",
    source: "主线路",
    url: "https://example.com/live.flv?sign=a%2Bb&expire=123",
    onlyAudio: false,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getInfo.mockResolvedValue(liveInfo);
  mocks.getStream.mockResolvedValue(streamInfo);
});

describe("bgo 兼容接口", () => {
  describe("GET /bgo/channel-info", () => {
    it("透传 bgo ChannelInfo 所需字段，并解码直播间 URL", async () => {
      const channelInfo = {
        id: "123456",
        title: "直播标题",
        owner: "主播",
        avatar: "https://example.com/avatar.png",
        uid: "987654",
      };
      mocks.resolveChannelInfoFromURL.mockResolvedValue(channelInfo);
      const url = "https://live.douyin.com/123456?foo=a+b&bar=中文";
      expect(await request(`/bgo/channel-info?url=${encodeURIComponent(url)}`)).toEqual({
        status: 200,
        body: channelInfo,
      });
      expect(mocks.resolveChannelInfoFromURL).toHaveBeenCalledExactlyOnceWith(url);
    });

    it("保留无法识别 URL 时的空响应", async () => {
      mocks.resolveChannelInfoFromURL.mockResolvedValue(null);
      expect(await request("/bgo/channel-info?url=invalid")).toEqual({
        status: 204,
        body: null,
      });
    });

    it("解析异常继续交由上层错误处理，不伪装为成功", async () => {
      mocks.resolveChannelInfoFromURL.mockRejectedValue(new Error("解析失败"));
      await expect(request("/bgo/channel-info?url=invalid")).rejects.toThrow("解析失败");
    });
  });

  describe("GET /bgo/live-info", () => {
    it.each([true, false])("返回 bgo 使用的标题、主播和开播状态：%s", async (living) => {
      mocks.getInfo.mockResolvedValue({ ...liveInfo, living });
      expect(await request("/bgo/live-info?platform=douyin&roomId=123456")).toEqual({
        status: 200,
        body: { title: liveInfo.title, owner: liveInfo.owner, living },
      });
      expect(mocks.getInfo).toHaveBeenCalledExactlyOnceWith("123456", { api: "balance" });
    });
  });

  describe("GET /bgo/stream-info", () => {
    it("保留扁平 stream 字段和完整播放 URL，并优先选择原画 FLV", async () => {
      expect(await request("/bgo/stream-info?platform=douyin&roomId=123456")).toEqual({
        status: 200,
        body: { stream: streamInfo.currentStream.url },
      });
      expect(mocks.getStream).toHaveBeenCalledExactlyOnceWith({
        channelId: "123456",
        quality: 0,
        streamPriorities: [],
        sourcePriorities: [],
        formatPriorities: ["flv"],
      });
    });
  });

  describe.each([
    [
      "live-info",
      "getInfo",
      liveInfo,
      { title: liveInfo.title, owner: liveInfo.owner, living: true },
    ],
    ["stream-info", "getStream", streamInfo, { stream: streamInfo.currentStream.url }],
  ] as const)("GET /bgo/%s 公共行为", (route, mockName, rawInfo, publicInfo) => {
    it.each(["", "platform=bilibili", "platform=Douyin"])(
      "不支持或缺少平台时返回 400：%s",
      async (platform) => {
        expect(await request(`/bgo/${route}?roomId=123456&${platform}`)).toEqual({
          status: 400,
          body: { error: "Platform not supported" },
        });
        expect(mocks.getInfo).not.toHaveBeenCalled();
        expect(mocks.getStream).not.toHaveBeenCalled();
      },
    );

    it("上游异常返回 500 和错误消息", async () => {
      mocks[mockName].mockRejectedValue(new Error("上游请求失败"));
      expect(await request(`/bgo/${route}?platform=douyin&roomId=123456`)).toEqual({
        status: 500,
        body: { error: "上游请求失败" },
      });
    });

    // 旧接口按字符串真值判断，dev=false 和 dev=0 仍然开启调试信息。
    it.each(["1", "true", "false", "0"])("dev=%s 保留完整调试结构", async (dev) => {
      expect(await request(`/bgo/${route}?platform=douyin&roomId=123456&dev=${dev}`)).toEqual({
        status: 200,
        body: { ...publicInfo, dev: rawInfo },
      });
    });

    it.each(["", "&dev="])("未启用 dev 时不泄漏额外字段：%s", async (dev) => {
      expect(await request(`/bgo/${route}?platform=douyin&roomId=123456${dev}`)).toEqual({
        status: 200,
        body: publicInfo,
      });
    });
  });
});
