import { expect, it, vi } from "vitest";
import { getRoomInfo } from "../src/douyin_api.js";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get }) } }));

it("用户页正常下播且没有 room 时仍返回成功状态", async () => {
  get.mockResolvedValue({ headers: { "set-cookie": ["__ac_nonce=test"] }, data: "主播已下播" });
  await expect(
    getRoomInfo("123", { api: "userHTML", uid: "uid", auth: "cookie" }),
  ).resolves.toMatchObject({
    living: false,
    roomId: "123",
    streams: [],
    sources: [],
  });
});
