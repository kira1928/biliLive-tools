export type FailureKind = "http" | "timeout" | "parse" | "network" | "unknown";

// 仅传递稳定分类，不复制可能含 Cookie、签名 URL 或 HTML 的上游 message。
export function describeFailure(error: unknown): {
  kind: FailureKind;
  upstreamStatus?: number;
} {
  const value = error as { response?: { status?: number }; code?: string; message?: string };
  const status = value?.response?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    return { kind: "http", upstreamStatus: status };
  }
  if (["ECONNABORTED", "ETIMEDOUT"].includes(value?.code ?? "")) return { kind: "timeout" };
  if (
    error instanceof SyntaxError ||
    /No (?:room )?match found in HTML/.test(value?.message ?? "")
  ) {
    return { kind: "parse" };
  }
  if (
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_NETWORK"].includes(
      value?.code ?? "",
    )
  ) {
    return { kind: "network" };
  }
  return { kind: "unknown" };
}

export class BalanceError extends Error {
  constructor(
    public readonly code: "BGO_BALANCE_COOLDOWN" | "BGO_BALANCE_BUSY" | "BGO_BALANCE_UPSTREAM",
    public readonly details: {
      api?: string;
      kind?: FailureKind;
      upstreamStatus?: number;
      retryAt?: string;
    } = {},
  ) {
    super(
      {
        BGO_BALANCE_COOLDOWN: "所有可用的抖音 API 端点正在冷却",
        BGO_BALANCE_BUSY: "抖音 API 端点正在恢复探测，请稍后重试",
        BGO_BALANCE_UPSTREAM: "抖音上游查询失败",
      }[code],
    );
    this.name = "BalanceError";
  }
}
