import type { APIType, APIEndpoint, APIEndpointStatus, LoadBalancerConfig } from "../types.js";
import { getRoomInfo } from "../douyin_api.js";
import { BalanceError, describeFailure } from "./errors.js";

type EndpointState = APIEndpointStatus & { generation: number; isProbing: boolean };

/** 端点共享健康状态；熔断和手动重置通过代次隔离此前仍在途的结果。 */
export class APILoadBalancer {
  private endpoints: EndpointState[] = [];
  private config: LoadBalancerConfig;

  constructor(config?: Partial<LoadBalancerConfig>) {
    this.config = {
      maxFailures: 3,
      blockDuration: 3 * 60 * 1000,
      maxBlockDuration: 3 * 60 * 1000,
      retryMultiplier: 1.5,
      healthCheckInterval: 30 * 1000,
      ...config,
    };
    this.updateConfig({});
    const defaultEndpoints: APIEndpoint[] = [
      { name: "web", priority: 2, weight: 1 },
      { name: "webHTML", priority: 1, weight: 1 },
      { name: "mobile", priority: 6, weight: 1 },
      { name: "userHTML", priority: 4, weight: 1 },
    ];
    this.endpoints = defaultEndpoints.map((endpoint) => ({
      endpoint,
      failureCount: 0,
      lastFailureTime: 0,
      isBlocked: false,
      nextRetryTime: 0,
      generation: 0,
      isProbing: false,
    }));
  }

  private getNextEndpoint(candidates: EndpointState[]): EndpointState | undefined {
    const now = Date.now();
    const available = candidates
      .filter((s) => !s.isBlocked || (now >= s.nextRetryTime && !s.isProbing))
      .sort((a, b) => a.endpoint.priority - b.endpoint.priority);
    const totalWeight = available.reduce((sum, s) => sum + s.endpoint.weight, 0);
    let choice = Math.random() * totalWeight;
    for (const status of available) {
      choice -= status.endpoint.weight;
      if (choice < 0) {
        // 在第一次 await 之前占用探测名额，冷却到期不直接恢复普通流量。
        if (status.isBlocked) status.isProbing = true;
        return status;
      }
    }
    return undefined;
  }

  private recordFailure(status: EndpointState, generation: number): void {
    if (status.generation !== generation) return;
    status.failureCount = Math.min(this.config.maxFailures, status.failureCount + 1);
    status.lastFailureTime = Date.now();
    if (status.isProbing || status.failureCount >= this.config.maxFailures) {
      status.generation++;
      status.isBlocked = true;
      status.isProbing = false;
      // 固定且有上限的冷却，迟到失败既不能继续计数，也不能延后本轮恢复时间。
      status.nextRetryTime =
        Date.now() + Math.min(this.config.blockDuration, this.config.maxBlockDuration);
      console.warn(
        `API ${status.endpoint.name} has been blocked due to ${status.failureCount} failures. Next retry at: ${new Date(status.nextRetryTime).toISOString()}`,
      );
    }
  }

  private recordSuccess(status: EndpointState, generation: number): void {
    if (status.generation !== generation) return;
    if (status.isBlocked) status.generation++;
    status.failureCount = 0;
    status.lastFailureTime = 0;
    status.isBlocked = false;
    status.isProbing = false;
    status.nextRetryTime = 0;
  }

  async callWithLoadBalance(
    webRoomId: string,
    opts: Parameters<typeof getRoomInfo>[1] = {},
  ): Promise<Awaited<ReturnType<typeof getRoomInfo>>> {
    // mobile/userHTML 无有效 uid 时会在底层退回 web，不能把它们当作不同端点重试。
    const eligible = this.endpoints.filter(
      ({ endpoint }) =>
        endpoint.weight > 0 &&
        (!["mobile", "userHTML"].includes(endpoint.name) ||
          (typeof opts.uid === "string" && opts.uid.length > 0)),
    );
    const tried = new Set<APIType>();
    let lastError: BalanceError | undefined;

    while (tried.size < eligible.length) {
      opts.signal?.throwIfAborted();
      const candidates = eligible.filter((s) => !tried.has(s.endpoint.name));
      const status = this.getNextEndpoint(candidates);
      if (!status) {
        if (lastError) throw lastError;
        const probing = candidates.some((s) => s.isProbing);
        const retryAt = Math.min(...candidates.map((s) => s.nextRetryTime));
        throw new BalanceError(probing ? "BGO_BALANCE_BUSY" : "BGO_BALANCE_COOLDOWN", {
          ...(!probing && Number.isFinite(retryAt)
            ? { retryAt: new Date(retryAt).toISOString() }
            : {}),
        });
      }
      const api = status.endpoint.name;
      const generation = status.generation;
      tried.add(api);
      try {
        const result = await getRoomInfo(webRoomId, { ...opts, api });
        opts.signal?.throwIfAborted();
        // living:false 同样是成功查询，不能被计作接口失败。
        this.recordSuccess(status, generation);
        return result;
      } catch (error) {
        if (opts.signal?.aborted) {
          // 调用方取消不改变端点健康状态；等实际请求结束后才释放探测名额。
          if (status.generation === generation) status.isProbing = false;
          throw opts.signal.reason;
        }
        this.recordFailure(status, generation);
        lastError = new BalanceError("BGO_BALANCE_UPSTREAM", { api, ...describeFailure(error) });
        console.warn("抖音 API 查询失败", {
          room: webRoomId,
          attempt: tried.size,
          ...lastError.details,
        });
      }
    }
    throw lastError ?? new BalanceError("BGO_BALANCE_BUSY");
  }

  getEndpointStatus(): APIEndpointStatus[] {
    return this.endpoints.map(({ generation, ...status }) => ({
      ...status,
      endpoint: { ...status.endpoint },
    }));
  }

  resetEndpoint(apiType: APIType): void {
    const status = this.endpoints.find((s) => s.endpoint.name === apiType);
    if (!status) return;
    status.generation++;
    status.failureCount = 0;
    status.lastFailureTime = 0;
    status.isBlocked = false;
    status.isProbing = false;
    status.nextRetryTime = 0;
  }

  resetAllEndpoints(): void {
    this.endpoints.forEach((s) => this.resetEndpoint(s.endpoint.name));
  }

  updateEndpointConfig(apiType: APIType, updates: Partial<APIEndpoint>): void {
    if (updates.weight !== undefined && (!Number.isFinite(updates.weight) || updates.weight < 0)) {
      throw new Error("端点权重必须是非负有限数值");
    }
    const status = this.endpoints.find((s) => s.endpoint.name === apiType);
    if (status) {
      // 端点名称是状态标识，不允许通过配置把两个独立状态映射到同一端点。
      if (updates.priority !== undefined) status.endpoint.priority = updates.priority;
      if (updates.weight !== undefined) status.endpoint.weight = updates.weight;
    }
  }

  getConfig(): LoadBalancerConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<LoadBalancerConfig>): void {
    const config = { ...this.config, ...updates };
    for (const key of ["maxFailures", "blockDuration", "maxBlockDuration"] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
        throw new Error(`${key} 必须是正整数`);
      }
    }
    this.config = config;
  }
}

export const globalLoadBalancer = new APILoadBalancer();
