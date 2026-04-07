/**
 * HTTP client for the Pressa REST API.
 */

export interface CompileRequest {
  latex: string;
  compiler?: "pdflatex" | "xelatex" | "lualatex";
}

export interface CompileResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  compilation_time_ms: number;
  usage: {
    plan: string;
    compilations_this_month: number;
    monthly_limit: number | null;
  };
}

export interface CompileErrorResponse {
  error: string;
  log?: string;
  line?: number;
}

export interface UsageResponse {
  user: {
    email: string;
    username: string;
    plan: string;
  };
  usage: {
    compilations_this_month: number;
    monthly_limit: number | null;
    remaining: number | null;
    resets_at: string;
  };
  api_key: {
    prefix: string;
    name: string | null;
    total_requests: number;
    last_used_at: string | null;
  };
}

export class PressaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PressaApiError";
  }
}

export class PressaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('API URL must use HTTPS');
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async compile(request: CompileRequest): Promise<CompileResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await this.request("/api/v1/compile", {
        method: "POST",
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Compilation failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as CompileResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async usage(): Promise<UsageResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await this.request("/api/v1/usage", {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Usage request failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as UsageResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...init.headers,
      },
    });
  }

  private async safeJson(response: Response): Promise<Record<string, unknown> | null> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
