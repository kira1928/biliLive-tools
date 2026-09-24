export type APIType = "web" | "webHTML" | "mobile" | "userHTML" | "balance" | "random";
export type RealAPIType = Exclude<APIType, "balance" | "random">;

export interface APIEndpoint {
  name: APIType;
  priority: number; // 优先级，数字越小优先级越高
  weight: number; // 权重，用于负载均衡
}

export interface APIEndpointStatus {
  endpoint: APIEndpoint;
  failureCount: number;
  lastFailureTime: number;
  isBlocked: boolean;
  isProbing: boolean; // 冷却结束后是否已有恢复探测在途
  nextRetryTime: number;
}

export interface LoadBalancerConfig {
  maxFailures: number; // 最大失败次数，超过后进入禁用状态
  blockDuration: number; // 禁用时长（毫秒）
  maxBlockDuration: number; // 单轮冷却上限（毫秒）
  retryMultiplier: number; // 兼容旧配置，固定冷却不再使用此参数
  healthCheckInterval: number; // 兼容旧配置，恢复由请求触发，不启动定时探测
}

export interface RoomInfo {
  living: boolean;
  nickname: string;
  sec_uid: string;
  avatar: string;
  api: RealAPIType;
  room: {
    title: string;
    cover: string;
    id_str: string;
    stream_url: any | null;
  } | null;
}
