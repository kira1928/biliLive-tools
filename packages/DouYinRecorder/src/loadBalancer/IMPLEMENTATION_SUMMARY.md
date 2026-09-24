# 抖音负载均衡实现说明

当前行为与配置统一维护在 [LoadBalancer_README.md](./LoadBalancer_README.md)。

- `loadBalancer.ts`：端点选择、连续失败计数、固定上限冷却、单请求恢复探测和状态代次。
- `errors.ts`：稳定错误码及不含上游原始消息的错误分类。
- `loadBalancerManager.ts`：状态快照、配置更新和手动重置。
- `../stream.ts`、`../douyin_api.ts`：将取消信号传递到实际 HTTP 请求。
- `../../../http/src/routes/bgoRequest.ts`：BGO 查询总预算、断开取消及结构化 HTTP 错误响应。

旧实现的指数冷却、成功时只减一、到期直接恢复全部并发等描述已不适用，具体修复背景见 [bililive-go #1207](https://github.com/bililive-go/bililive-go/issues/1207)。
