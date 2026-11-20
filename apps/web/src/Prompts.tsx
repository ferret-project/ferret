/**
 * Settings → Server → AI prompts (the server admin): extra instructions added to the end of one of Ferret's built-in
 * prompts, for people steering their own models. Added to, never replacing (lib/ai-prompts.ts on the server), so the
 * reply's shape and later fixes to the prompts stay. Advanced on purpose: a bad instruction makes AI worse everywhere.
 */
import type { PromptKind } from "@ferret/shared";
import { PROMPT_EXTRA_MAX } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { api } from "./lib/api";
import { HelpLink } from "./HelpLink";

export const PROMPT_NAMES: Record<PromptKind, MessageDescriptor> = {
  photo: msg`Photos of things`,
  document: msg`Documents (receipts, manuals, warranties)`,
  describe: msg`Describe it (typed or spoken)`,
  roomScan: msg`Room scans`,
  ask: msg`Ask Ferret`,
};

export function AiPrompts() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["server-prompts"], queryFn: api.promptSettings });
  const [kind, setKind] = useState<PromptKind>("photo");
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const prompts = status.data?.data;
  const current = prompts?.find((p) => p.kind === kind);
  const save = useMutation({
    mutationFn: (extra: string | null) => api.setPromptExtra(kind, extra),
    onSuccess: (data) => {
      qc.setQueryData(["server-prompts"], data);
      setConfirming(false);
    },
  });
  // The box shows the chosen prompt's saved instructions — again after switching prompts or saving.
  useEffect(() => setDraft(current?.extra ?? ""), [current?.kind, current?.extra]);
  if (!prompts || !current) return null;
  const dirty = draft.trim() !== (current.extra ?? "");

  return (
    <section className="card" aria-labelledby="ai-prompts-title">
      <div className="card-body gap-3">
        <h2 id="ai-prompts-title" className="card-title flex flex-wrap items-center gap-2">
          <span className="icon-[tabler--message-cog] size-5 text-primary" />
          <Trans>AI prompts</Trans>
          <span className="badge badge-soft badge-warning badge-sm"><Trans>Advanced</Trans></span>
          <HelpLink page="hosting/ai.html#ai-prompts" label={t`AI prompts`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Add your own instructions to the end of what Ferret asks its AI models — for example "For video games, the brand is
          the publisher". Ferret's own instructions stay, and improvements to them still arrive with updates. Instructions that
          fight Ferret's can make AI worse for every household on this server; reset them if answers look odd.</Trans>
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium"><Trans>Prompt</Trans></span>
          <select className="select" value={kind} onChange={(e) => { setKind(e.target.value as PromptKind); setConfirming(false); save.reset(); }}>
            {prompts.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.extra ? t`${t(PROMPT_NAMES[p.kind])} — changed` : t(PROMPT_NAMES[p.kind])}
              </option>
            ))}
          </select>
        </label>
        <details className="rounded-box border border-base-content/15">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium"><Trans>Ferret's built-in prompt</Trans></summary>
          {/* The prompt itself, in English as the model gets it. */}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-base-content/15 px-3 py-2 text-xs">{current.builtIn}</pre>
        </details>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium"><Trans>Your extra instructions</Trans></span>
          <textarea
            className="textarea min-h-28"
            value={draft}
            maxLength={PROMPT_EXTRA_MAX}
            placeholder={t`None — the built-in prompt as it is`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="text-xs text-base-content/70"><Trans>Added after the built-in prompt, in the language you write them in (English works best).</Trans></span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft.trim() || null)}>
            <Trans>Save</Trans>
          </button>
          {current.extra && !confirming && (
            <button type="button" className="btn btn-soft" disabled={save.isPending} onClick={() => setConfirming(true)}>
              <Trans>Reset to default</Trans>
            </button>
          )}
          {confirming && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm"><Trans>Remove your instructions from this prompt?</Trans></span>
              <button type="button" className="btn btn-error btn-soft" disabled={save.isPending} onClick={() => save.mutate(null)}>
                <Trans>Reset</Trans>
              </button>
              <button type="button" className="btn btn-text" onClick={() => setConfirming(false)}>
                <Trans>Cancel</Trans>
              </button>
            </span>
          )}
        </div>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
      </div>
    </section>
  );
}
