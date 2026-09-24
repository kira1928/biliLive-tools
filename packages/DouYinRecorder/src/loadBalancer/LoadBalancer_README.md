# 抖音端点负载均衡与熔断

`getInfo(roomId, { api: "balance" })` 使用跨房间共享的端点健康状态。修复背景见 [bililive-go #1207](https://github.com/bililive-go/bililive-go/issues/1207)。

## 状态转换

正常端点连续失败达到 `maxFailures` 后进入冷却。成功查询立即清零连续失败计数，`living: false` 也属于成功。

每轮冷却为 `min(blockDuration, maxBlockDuration)`，默认 3 分钟。进入冷却时推进状态代次，此前在途请求的成功或失败不再修改当前健康状态。旧请求自身的查询结果仍可返回给调用方。

冷却到期后，由后续请求占用唯一的恢复探测名额。探测成功后恢复普通请求，失败则重新冷却；调用方取消不计为端点失败。探测名额在实际请求结束后释放，不通过 `Promise.race()` 提前释放。

手动重置同样推进代次，隔离重置前的结果。状态快照包含 `isBlocked`、`isProbing`、`failureCount`、`lastFailureTime`、`nextRetryTime`，其修改不会影响真实端点。

## 端点选择

每次查询最多尝试每个符合条件的端点一次。没有非空字符串 `uid` 时只选择 `web` 和 `webHTML`，避免 `mobile`、`userHTML` 在底层回退到同一个 `web` 接口。

| 端点       | 优先级 | 权重 | 要求           |
| ---------- | -----: | ---: | -------------- |
| `webHTML`  |      1 |    1 | 房间号         |
| `web`      |      2 |    1 | 房间号         |
| `userHTML` |      4 |    1 | 房间号及 `uid` |
| `mobile`   |      6 |    1 | 房间号及 `uid` |

保持加权随机选择，优先级用于候选排序，不代表严格的优先回退次序。权重设为 0 可停用端点。

## 配置

| 参数                  | 默认值 | 说明                               |
| --------------------- | -----: | ---------------------------------- |
| `maxFailures`         |      3 | 触发熔断的连续失败次数             |
| `blockDuration`       | 180000 | 每轮冷却时间，毫秒                 |
| `maxBlockDuration`    | 180000 | 每轮冷却上限，毫秒                 |
| `retryMultiplier`     |    1.5 | 保留旧配置兼容性，固定冷却不再使用 |
| `healthCheckInterval` |  30000 | 保留旧配置兼容性，不启动定时探测   |

前三项必须是正整数。运行时配置只影响后续状态转换，既有冷却不会因调整配置而延期。

```typescript
import { loadBalancer } from "@bililive-tools/douyin-recorder/loadBalancer/loadBalancerManager.js";

loadBalancer.updateConfig({ maxFailures: 3, blockDuration: 60_000 });
loadBalancer.getStatus();
loadBalancer.resetAPI("web");
```

## BGO 接口错误与取消

`/bgo/live-info` 和 `/bgo/stream-info` 保持成功响应格式，失败返回如下诊断字段：

| 错误码                 | HTTP 状态 | 含义                                                      |
| ---------------------- | --------: | --------------------------------------------------------- |
| `BGO_BALANCE_COOLDOWN` |       503 | 当前查询可用的端点均在冷却，附 `retryAt` 和 `Retry-After` |
| `BGO_BALANCE_BUSY`     |       503 | 恢复探测已占用，或没有启用的端点                          |
| `BGO_BALANCE_UPSTREAM` |       502 | 本次负载均衡查询的上游尝试失败                            |
| `BGO_UPSTREAM`         |       502 | 直接取流等路径的上游失败                                  |
| `BGO_REQUEST_TIMEOUT`  |       504 | 整次查询超过 12 秒预算                                    |
| `BGO_REQUEST_CANCELED` |       408 | 调用方断开；连接已关闭时不会收到响应                      |

上游错误还可包含 `api`、`kind`（`http`、`timeout`、`parse`、`network`、`unknown`）、`upstreamStatus`。不回传原始异常消息，避免泄漏 Cookie、签名 URL 或 HTML。`444` 只表示观察到的上游 HTTP 状态，不推断其成因。

12 秒预算覆盖所有端点回退，给 Go 客户端的 15 秒超时保留响应时间。超时或客户端断开通过同一个 `AbortSignal` 传递给 Cookie、nonce、页面和 API 的实际 Axios 请求；两个 HTML 路径也使用带 10 秒超时的专用客户端。

## 修复范围与验证

此实现不新增正常状态的全局串行限制、请求队列或固定请求速率，也不修改直接取流的端点选择。大量房间的请求速率与吞吐参数仍需要实际测量，不能直接把个别部署的实验参数设为所有用户的默认值。

新增测试无需访问抖音：覆盖并发迟到结果、冷却上限、单探测、状态重置、端点去重、正常下播、实际请求结束前不释放探测、超时与断开传播，以及错误脱敏。上游 444 和 HTML 页面变化的根因仍需另行调查。

```bash
pnpm --dir packages/DouYinRecorder exec vitest run
pnpm --dir packages/http exec vitest run test/bgoRequest.test.ts
```
