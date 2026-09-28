/**
 * HTTP client for the Pressa REST API.
 */

export interface CompileRequest {
  latex: string;
  compiler?: "pdflatex" | "xelatex" | "lualatex";
  assets?: Record<string, string>;
  use_stored_assets?: string[];
}

export interface CompileResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  compilation_time_ms: number;
  assets_count?: number;
  assets_total_bytes?: number;
  stored_assets_used?: string[];
  ephemeral_assets_used?: string[];
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

export interface RenderRequest {
  data: Record<string, unknown>;
}

export interface RenderResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  render_time_ms: number;
  compilation_time_ms: number;
  template: {
    id: number;
    name: string;
    version: number;
  };
  usage: {
    plan: string;
    compilations_this_month: number;
    monthly_limit: number | null;
  };
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

export interface TemplateListItem {
  id: number;
  name: string;
  description: string | null;
  updated_at: string;
  latex_size_bytes: number;
  has_instructions: boolean;
  // "liquid" for a placeholder template filled by `render`, null for raw
  // LaTeX compiled as-is.
  placeholder_engine: "liquid" | null;
  // V1.5 P0 (post-launch UX fix). `studio_compatible` is true when the
  // template can be opened in Pressa Studio (i.e. it uses Liquid
  // placeholders). `studio_url` is an absolute URL the agent can hand back
  // to the user; null when the template is legacy V1 or Studio is
  // disabled on the deployment.
  studio_compatible: boolean;
  studio_url: string | null;
}

export interface TemplateListResponse {
  templates: TemplateListItem[];
}

export interface TemplateResponse {
  id: number;
  name: string;
  description: string | null;
  latex_content: string;
  instructions: string | null;
  updated_at: string;
  latex_size_bytes: number;
  placeholder_engine: "liquid" | null;
  // Present only on placeholder templates: the fields `render` expects.
  schema?: Record<string, unknown>;
  version?: number;
  // V1.5 P0 (post-launch UX fix). Same semantics as on TemplateListItem.
  studio_compatible: boolean;
  studio_url: string | null;
}

// "liquid": placeholder template filled by `render`. "none": raw LaTeX whose
// braces only look like placeholders. Omitted: keep the template's kind.
export type PlaceholderEngine = "liquid" | "none";

export interface SaveTemplateOptions {
  latexContent?: string;
  description?: string;
  instructions?: string;
  placeholderEngine?: PlaceholderEngine;
}

export interface TemplateSaveResponse {
  template: TemplateResponse;
  created: boolean;
  // True when this call converted a raw LaTeX template to a placeholder one.
  promoted: boolean;
}

export interface Asset {
  id: number;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
  content_base64?: string;
}

export interface AssetListResponse {
  assets: Asset[];
  count: number;
  total_bytes: number;
  count_limit: number | null;
  total_bytes_limit: number;
  remaining_bytes: number | null;
}

export interface AssetSaveResponse {
  asset: Asset;
  created: boolean;
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
  private readonly apiKey: string | null;

  /**
   * `apiKey` may be null, which puts the client in anonymous mode: no
   * Authorization header is sent and the server serves the keyless tier on
   * POST /api/v1/compile. Other endpoints answer 401, which is correct -
   * they need a real account.
   */
  constructor(baseUrl: string, apiKey: string | null) {
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

  async render(idOrName: string, data: Record<string, unknown>): Promise<RenderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const encoded = encodeURIComponent(idOrName);
      const response = await this.request(`/api/v2/templates/${encoded}/render`, {
        method: "POST",
        body: JSON.stringify({ data }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Render failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as RenderResponse;
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

  async listTemplates(): Promise<TemplateListResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await this.request("/api/v1/templates", {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `List templates failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as TemplateListResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getTemplate(idOrName: string): Promise<{ template: TemplateResponse }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const encoded = encodeURIComponent(idOrName);
      const response = await this.request(`/api/v1/templates/${encoded}`, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Get template failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as { template: TemplateResponse };
    } finally {
      clearTimeout(timeout);
    }
  }

  async saveTemplate(name: string, options: SaveTemplateOptions): Promise<TemplateSaveResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const { latexContent, description, instructions, placeholderEngine } = options;
      const body: Record<string, string> = { name };
      if (latexContent !== undefined) body.latex_content = latexContent;
      if (description) body.description = description;
      if (instructions !== undefined) body.instructions = instructions;
      if (placeholderEngine) body.placeholder_engine = placeholderEngine;

      const response = await this.request("/api/v1/templates", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const respBody = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (respBody?.error as string) ?? `Save template failed (HTTP ${response.status})`,
          response.status,
          respBody,
        );
      }

      return (await response.json()) as TemplateSaveResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async deleteTemplate(idOrName: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const encoded = encodeURIComponent(idOrName);
      const response = await this.request(`/api/v1/templates/${encoded}`, {
        method: "DELETE",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Delete template failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAssets(): Promise<AssetListResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await this.request("/api/v1/assets", {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `List assets failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as AssetListResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAsset(idOrName: string): Promise<{ asset: Asset }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const encoded = encodeURIComponent(idOrName);
      const response = await this.request(`/api/v1/assets/${encoded}`, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Get asset failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }

      return (await response.json()) as { asset: Asset };
    } finally {
      clearTimeout(timeout);
    }
  }

  async saveAsset(name: string, contentBase64: string, contentType?: string): Promise<AssetSaveResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const body: Record<string, string> = { name, content_base64: contentBase64 };
      if (contentType) body.content_type = contentType;

      const response = await this.request("/api/v1/assets", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const respBody = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (respBody?.error as string) ?? `Save asset failed (HTTP ${response.status})`,
          response.status,
          respBody,
        );
      }

      return (await response.json()) as AssetSaveResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async deleteAsset(idOrName: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const encoded = encodeURIComponent(idOrName);
      const response = await this.request(`/api/v1/assets/${encoded}`, {
        method: "DELETE",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await this.safeJson(response) as Record<string, unknown> | null;
        throw new PressaApiError(
          (body?.error as string) ?? `Delete asset failed (HTTP ${response.status})`,
          response.status,
          body,
        );
      }
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
        // Omitted entirely when anonymous. A present-but-empty Bearer value
        // would earn a 401 rather than the anonymous tier, because the server
        // treats a supplied-but-invalid key as a hard error on purpose.
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
