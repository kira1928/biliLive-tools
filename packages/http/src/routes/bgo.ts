import Router from "@koa/router";

import { getInfo, getStream } from "@bililive-tools/douyin-recorder/stream.js";
import { provider } from "@bililive-tools/douyin-recorder/index.js";
import { bgoRequest } from "./bgoRequest.js";

const router = new Router({
  prefix: "/bgo",
});

router.get("/channel-info", async (ctx) => {
  const { url } = ctx.request.query;
  const info = await provider.resolveChannelInfoFromURL(url as string);
  ctx.body = info;
});

router.get("/live-info", async (ctx) => {
  const { roomId, platform, dev } = ctx.request.query;
  if (platform !== "douyin") {
    ctx.body = { error: "Platform not supported" };
    ctx.status = 400;
    return;
  }
  await bgoRequest(ctx, async (signal) => {
    const info = await getInfo(roomId as string, { api: "balance", signal });
    const body = {
      title: info.title,
      owner: info.owner,
      living: info.living,
    };
    if (dev) {
      body["dev"] = info;
    }
    return body;
  });
});

router.get("/stream-info", async (ctx) => {
  const { roomId, platform, dev } = ctx.request.query;
  if (platform !== "douyin") {
    ctx.body = { error: "Platform not supported" };
    ctx.status = 400;
    return;
  }
  await bgoRequest(ctx, async (signal) => {
    const info = await getStream({
      signal,
      channelId: roomId as string,
      quality: 0,
      streamPriorities: [],
      sourcePriorities: [],
      formatPriorities: ["flv"],
    });
    const body = { stream: info.currentStream.url };
    if (dev) {
      body["dev"] = info;
    }
    return body;
  });
});

export default router;
