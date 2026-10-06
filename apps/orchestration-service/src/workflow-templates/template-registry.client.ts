import { WorkflowTemplateSchema, WorkflowTemplateSummarySchema, type WorkflowTemplate, type WorkflowTemplateSummary } from "@alterx/contracts";

/** The template doesn't exist (or is no longer active) in the Capability Registry. */
export class WorkflowTemplateNotFoundError extends Error {
  constructor(templateId: string) { super(`Template ${templateId} was not found`); this.name = "WorkflowTemplateNotFoundError"; }
}

export interface WorkflowTemplateRegistry {
  list(): Promise<WorkflowTemplateSummary[]>;
  get(templateId: string): Promise<WorkflowTemplate>;
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Reads templates from intelligence-service's Capability Registry routes. */
export class HttpWorkflowTemplateRegistry implements WorkflowTemplateRegistry {
  constructor(private readonly baseUrl: string, private readonly fetchJson: Fetch = fetch as unknown as Fetch) {}

  async list(): Promise<WorkflowTemplateSummary[]> {
    const body = await this.read("/internal/capability-registry/templates");
    return WorkflowTemplateSummarySchema.array().parse(body);
  }

  async get(templateId: string): Promise<WorkflowTemplate> {
    const body = await this.read(`/internal/capability-registry/templates/${encodeURIComponent(templateId)}`, templateId);
    return WorkflowTemplateSchema.parse(body);
  }

  private async read(path: string, templateId?: string): Promise<unknown> {
    const response = await this.fetchJson(new URL(path, this.baseUrl).toString(), { headers: { accept: "application/json" } });
    if (response.status === 404 && templateId !== undefined) throw new WorkflowTemplateNotFoundError(templateId);
    if (!response.ok) throw new Error(`Capability Registry template request failed with status ${response.status}`);
    return response.json();
  }
}
