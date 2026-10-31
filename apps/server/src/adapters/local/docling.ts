import type { Documents } from "../../ports";

/**
 * docling-serve — PDFs and document photos to Markdown (the Documents port), using its
 * async API so long documents don't hold a connection open.
 */
export class DoclingDocuments implements Documents {
  constructor(
    private readonly baseUrl: string,
    /** Extra form fields, e.g. pipeline=vlm and vlm_pipeline_model_api (DOCLING_OPTIONS). */
    private readonly options: Record<string, string>,
    /** Give up on one document after this long (long manuals take a while on the VLM pipeline). */
    private readonly deadlineMs = 30 * 60_000,
  ) {}

  async toMarkdown(data: Uint8Array, filename: string, contentType: string) {
    const form = new FormData();
    for (const [key, value] of Object.entries(this.options)) form.append(key, value);
    form.set("to_formats", "md");
    form.set("image_export_mode", "placeholder");
    form.append("files", new Blob([data as Uint8Array<ArrayBuffer>], { type: contentType }), filename);

    const task = await this.call<{ task_id: string }>("/v1/convert/file/async", { method: "POST", body: form });
    const deadline = Date.now() + this.deadlineMs;
    for (;;) {
      // Long-poll: docling answers as soon as the task finishes, or after `wait` seconds.
      const status = await this.call<{ task_status: string }>(`/v1/status/poll/${task.task_id}?wait=20`);
      if (status.task_status === "success" || status.task_status === "partial_success") break;
      if (status.task_status === "failure") throw new Error(`docling couldn't convert ${filename}`);
      if (Date.now() > deadline) throw new Error(`docling took too long on ${filename}`);
    }
    const result = await this.call<{ document?: { md_content?: string | null }; errors?: unknown[] }>(
      `/v1/result/${task.task_id}`,
    );
    const markdown = result.document?.md_content?.trim();
    if (markdown == null) throw new Error(`docling returned no text for ${filename}: ${JSON.stringify(result.errors)}`);
    return markdown;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), { ...init, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`docling ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
