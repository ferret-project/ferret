/**
 * Settings → Claude & API → Webhooks: the household's events POSTed to another app (n8n, Home Assistant, a script),
 * signed with each webhook's secret. Owners and admins only. The address is never shown again (it may hold a token),
 * only its host; the secret is shown once when made, and again on request.
 */
import type { WebhookDelivery, WebhookEvent, WebhookSummary } from "@ferret/shared";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph, plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CopyField } from "./CopyField";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { DialogActions, Modal } from "./Modal";

/** What each event means, in the order they're offered: changes first, then what needs attention. */
const EVENT_GROUPS: { label: MessageDescriptor; events: { event: WebhookEvent; label: MessageDescriptor }[] }[] = [
  {
    label: msg`As things change`,
    events: [
      { event: "item.created", label: msg`A thing is added` },
      { event: "item.updated", label: msg`A thing is changed` },
      { event: "item.gone", label: msg`A thing is gone (sold, given away, lost…)` },
      { event: "item.deleted", label: msg`A thing is deleted` },
      { event: "items.imported", label: msg`Things are imported` },
      { event: "stock.low", label: msg`Something runs low (onto the shopping list)` },
    ],
  },
  {
    label: msg`When something needs attention (once each)`,
    events: [
      { event: "task.due", label: msg`Maintenance is due within a week` },
      { event: "task.overdue", label: msg`Maintenance is overdue` },
      { event: "warranty.ending", label: msg`A warranty ends within a month` },
      { event: "return.closing", label: msg`A return window is closing` },
      { event: "recall.found", label: msg`A recall matches a thing` },
      { event: "loan.due", label: msg`Something lent or borrowed is due back` },
    ],
  },
];

const KEY = ["webhooks"];

export function Webhooks({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: KEY, queryFn: api.listWebhooks, enabled: canManage });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  if (!canManage) return null;
  const enabled = hooks.data?.enabled;
  const opened = hooks.data?.data.find((w) => w.id === open);

  return (
    <section className="card" aria-labelledby="webhooks-title">
      <div className="card-body gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <h2 id="webhooks-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--webhook] size-5 text-primary" />
              <Trans>Webhooks</Trans>
              <HelpLink page="guide/webhooks.html" label={t`Webhooks`} />
            </h2>
            <p className="text-sm text-base-content/70">
              <Trans>Tell n8n, Home Assistant or your own script when things change in this household, or when something needs doing.</Trans>
            </p>
          </div>
          {enabled && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Add</Trans>
            </button>
          )}
        </div>

        {hooks.isPending && <span className="loading loading-spinner text-primary" />}
        {hooks.isError && <div className="alert alert-soft alert-error">{hooks.error.message}</div>}
        {hooks.data && !enabled && <p className="text-sm text-base-content/70"><Trans>This server doesn't send webhooks.</Trans></p>}
        {hooks.data && enabled && hooks.data.data.length === 0 && (
          <div className="rounded-box border border-dashed border-base-content/20 p-6 text-center text-sm text-base-content/70">
            <Trans>None yet. Add the address of an n8n or Home Assistant webhook, or your own.</Trans>
          </div>
        )}
        {hooks.data && hooks.data.data.length > 0 && (
          <ul className="space-y-2">
            {hooks.data.data.map((w) => (
              <WebhookRow key={w.id} hook={w} onOpen={() => setOpen(w.id)} onChanged={refresh} />
            ))}
          </ul>
        )}
      </div>

      {adding && (
        <WebhookForm
          local={hooks.data?.local ?? false}
          onClose={() => setAdding(false)}
          onSaved={(made) => {
            setAdding(false);
            void refresh();
            if ("secret" in made) setSecret({ name: made.name, secret: made.secret as string });
          }}
        />
      )}
      {opened && <WebhookDialog hook={opened} local={hooks.data?.local ?? false} onClose={() => setOpen(null)} onChanged={refresh} />}
      {secret && <SecretDialog name={secret.name} secret={secret.secret} onClose={() => setSecret(null)} first />}
    </section>
  );
}

/** How a webhook is doing, in a few words. */
function statusOf(w: WebhookSummary): { tone: "error" | "warning" | "muted"; text: string } {
  if (w.disabledAt) {
    return { tone: "error", text: w.lastError ? t`Switched off — its deliveries kept failing (${ph({ error: w.lastError })})` : t`Switched off — its deliveries kept failing` };
  }
  if (w.paused) return { tone: "warning", text: t`Paused` };
  if (w.lastError) return { tone: "error", text: w.lastError };
  if (w.lastDeliveryAt) return { tone: "muted", text: t`Last sent ${ph({ when: formatWhen(w.lastDeliveryAt) })}` };
  return { tone: "muted", text: t`Nothing sent yet` };
}

function WebhookRow({ hook, onOpen, onChanged }: { hook: WebhookSummary; onOpen: () => void; onChanged: () => void }) {
  const test = useMutation({ mutationFn: () => api.testWebhook(hook.id), onSettled: onChanged });
  const status = statusOf(hook);
  const tested = test.data;
  const bad = status.tone === "error";
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-box p-2 hover:bg-neutral/10">
      <div className="avatar avatar-placeholder">
        <div className={`size-10 rounded-full ${bad ? "bg-error/10 text-error" : "bg-primary/10 text-primary"}`}>
          <span className={`${bad ? "icon-[tabler--alert-triangle]" : hook.paused ? "icon-[tabler--player-pause]" : "icon-[tabler--webhook]"} size-5`} />
        </div>
      </div>
      <button type="button" className="min-w-0 flex-1 text-start" onClick={onOpen}>
        <h3 className="flex flex-wrap items-center gap-2 font-medium text-base-content">
          <span className="truncate">{hook.name}</span>
          <span className="badge badge-soft badge-secondary badge-sm max-w-full truncate">{hook.host}</span>
        </h3>
        {tested ? (
          <p className={`text-sm ${tested.delivered ? "text-success" : "text-error"}`}>
            {tested.delivered ? t`Test delivered (${ph({ status: tested.status ?? "" })})` : (tested.error ?? t`Not delivered`)}
          </p>
        ) : test.isError ? (
          <p className="text-sm text-error">{test.error.message}</p>
        ) : (
          <p className={`text-sm ${status.tone === "error" ? "text-error" : status.tone === "warning" ? "text-warning" : "text-base-content/70"}`}>
            {status.text} · {plural(hook.events.length, { one: "# event", other: "# events" })}
          </p>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
        <button type="button" className="btn btn-text btn-sm" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending && <span className="loading loading-spinner loading-xs" />}
          <Trans>Send a test</Trans>
        </button>
        <button type="button" className="btn btn-text btn-sm btn-square" aria-label={t`Open ${ph({ name: hook.name })}`} onClick={onOpen}>
          <span className="icon-[tabler--chevron-right] size-5" />
        </button>
      </div>
    </li>
  );
}

function EventPicker({ value, onChange }: { value: WebhookEvent[]; onChange: (v: WebhookEvent[]) => void }) {
  const toggle = (e: WebhookEvent) => onChange(value.includes(e) ? value.filter((x) => x !== e) : [...value, e]);
  return (
    <div className="space-y-4">
      {EVENT_GROUPS.map((g) => (
        <fieldset key={g.events[0]!.event} className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-base-content">{t(g.label)}</legend>
          {g.events.map((e) => (
            <label key={e.event} className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="checkbox checkbox-primary checkbox-sm mt-0.5" checked={value.includes(e.event)} onChange={() => toggle(e.event)} />
              <span className="min-w-0 text-sm">
                {t(e.label)} <code className="text-xs text-base-content/70">{e.event}</code>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

/** Adding a webhook, or changing one (`hook`): a blank address keeps the one it has. */
function WebhookForm({
  hook,
  local,
  onClose,
  onSaved,
}: {
  hook?: WebhookSummary;
  local: boolean;
  onClose: () => void;
  onSaved: (w: WebhookSummary | (WebhookSummary & { secret: string })) => void;
}) {
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? ["item.created", "item.updated", "item.gone"]);
  const save = useMutation({
    mutationFn: () =>
      hook
        ? api.updateWebhook(hook.id, { name: name.trim(), events, ...(url.trim() ? { url: url.trim() } : {}) })
        : api.addWebhook({ name: name.trim(), url: url.trim(), events }),
    onSuccess: onSaved,
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Modal id="webhook-form" title={hook ? t`Change ${ph({ name: hook.name })}` : t`Add a webhook`} onClose={onClose}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div>
          <label className="label-text" htmlFor="webhook-name">
            <Trans>Name</Trans>
          </label>
          <input id="webhook-name" className="input" placeholder={t`e.g. n8n`} maxLength={60} required autoFocus={!hook} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label-text" htmlFor="webhook-url">
            <Trans>Address</Trans>
          </label>
          <input
            id="webhook-url"
            type="url"
            className="input font-mono text-sm"
            // not translated
            placeholder={hook ? t`Leave blank to keep ${ph({ host: hook.host })}` : "https://n8n.example.com/webhook/…"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required={!hook}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-base-content/70">
            {local ? (
              <Trans>Ferret POSTs JSON here. It can be on this server's own network (n8n, Home Assistant). The address is kept encrypted and only its host is shown again.</Trans>
            ) : (
              <Trans>Ferret POSTs JSON here — an address on the internet. The address is kept encrypted and only its host is shown again.</Trans>
            )}
          </p>
        </div>
        <EventPicker value={events} onChange={setEvents} />
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !events.length}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {hook ? <Trans>Save</Trans> : <Trans>Add</Trans>}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

function SecretDialog({ name, secret, onClose, first }: { name: string; secret: string; onClose: () => void; first?: boolean }) {
  return (
    <Modal id="webhook-secret" title={t`Signing secret for ${ph({ name })}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-base-content/80">
          {first ? (
            <Trans>Every delivery is signed with this secret (the Ferret-Signature header). Give it to the receiver so it can check a delivery really came from this Ferret.</Trans>
          ) : (
            <Trans>The receiver checks each delivery's Ferret-Signature header with this secret.</Trans>
          )}
        </p>
        <CopyField label={t`Secret`} value={secret} icon="icon-[tabler--key]" />
        <a href="/docs/guide/webhooks.html#checking-the-signature" className="link link-primary text-sm">
          <Trans>How to check the signature</Trans>
        </a>
        <DialogActions>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            <Trans>Done</Trans>
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/** One webhook: its deliveries, its secret, pause / turn on, change, remove. */
function WebhookDialog({ hook, local, onClose, onChanged }: { hook: WebhookSummary; local: boolean; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const logKey = ["webhook-deliveries", hook.id];
  const log = useQuery({ queryKey: logKey, queryFn: () => api.webhookDeliveries(hook.id) });
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "remove" | null>(null);
  const changed = () => {
    onChanged();
    void qc.invalidateQueries({ queryKey: logKey });
  };
  const pause = useMutation({ mutationFn: (paused: boolean) => api.updateWebhook(hook.id, { paused }), onSuccess: changed });
  const show = useMutation({ mutationFn: () => api.webhookSecret(hook.id), onSuccess: (r) => setSecret(r.secret) });
  const rotate = useMutation({
    mutationFn: () => api.rotateWebhookSecret(hook.id),
    onSuccess: (r) => {
      setConfirm(null);
      setSecret(r.secret);
      changed();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteWebhook(hook.id),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });
  const retry = useMutation({ mutationFn: (deliveryId: string) => api.retryWebhookDelivery(hook.id, deliveryId), onSuccess: changed });
  const status = statusOf(hook);
  const off = hook.paused || hook.disabledAt;
  const until = hook.previousSecretUntil ? formatWhen(hook.previousSecretUntil) : null;

  return (
    <Modal id="webhook" title={hook.name} onClose={onClose}>
      <div className="flex flex-col gap-6">
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="badge badge-soft badge-secondary">{hook.host}</span>
            {hook.local && <span className="badge badge-soft badge-info"><Trans>This server's network allowed</Trans></span>}
          </p>
          <p className={`text-sm ${status.tone === "error" ? "text-error" : status.tone === "warning" ? "text-warning" : "text-base-content/70"}`}>{status.text}</p>
          <div className="flex flex-wrap gap-2">
            {off ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={pause.isPending} onClick={() => pause.mutate(false)}>
                <span className="icon-[tabler--player-play] size-4" />
                <Trans>Turn on</Trans>
              </button>
            ) : (
              <button type="button" className="btn btn-soft btn-secondary btn-sm" disabled={pause.isPending} onClick={() => pause.mutate(true)}>
                <span className="icon-[tabler--player-pause] size-4" />
                <Trans>Pause</Trans>
              </button>
            )}
            <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setEditing(true)}>
              <span className="icon-[tabler--pencil] size-4" />
              <Trans>Change</Trans>
            </button>
          </div>
          {hook.paused && <p className="text-xs text-base-content/70"><Trans>While it's paused, nothing is kept to send later.</Trans></p>}
        </div>

        <section className="space-y-2" aria-labelledby="webhook-secret-title">
          <h3 id="webhook-secret-title" className="font-medium text-base-content">
            <Trans>Signing secret</Trans>
          </h3>
          {until && (
            <p className="text-sm text-base-content/70">
              <Trans>The old secret also signs until {until}, so the receiver can switch over.</Trans>
            </p>
          )}
          {confirm === "rotate" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm"><Trans>Make a new secret? The old one keeps working for a day.</Trans></span>
              <button type="button" className="btn btn-primary btn-sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                <Trans>New secret</Trans>
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirm(null)}>
                <Trans>Cancel</Trans>
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-soft btn-secondary btn-sm" disabled={show.isPending} onClick={() => show.mutate()}>
                <span className="icon-[tabler--eye] size-4" />
                <Trans>Show secret</Trans>
              </button>
              <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setConfirm("rotate")}>
                <span className="icon-[tabler--refresh] size-4" />
                <Trans>Rotate</Trans>
              </button>
            </div>
          )}
        </section>

        <section className="space-y-2" aria-labelledby="webhook-log-title">
          <h3 id="webhook-log-title" className="font-medium text-base-content">
            <Trans>Recent deliveries</Trans>
          </h3>
          {log.isPending && <span className="loading loading-spinner text-primary" />}
          {log.isError && <div className="alert alert-soft alert-error">{log.error.message}</div>}
          {log.data && log.data.data.length === 0 && <p className="text-sm text-base-content/70"><Trans>None yet.</Trans></p>}
          {log.data && log.data.data.length > 0 && (
            <ul className="divide-y divide-base-300 rounded-box border border-base-300">
              {log.data.data.map((d) => (
                <DeliveryRow key={d.id} delivery={d} canRetry={!off} retrying={retry.isPending && retry.variables === d.id} onRetry={() => retry.mutate(d.id)} />
              ))}
            </ul>
          )}
          {retry.isError && <div className="alert alert-soft alert-error">{retry.error.message}</div>}
          <p className="text-xs text-base-content/70"><Trans>The last 50, kept for 30 days.</Trans></p>
        </section>

        <section className="space-y-2 border-t border-base-300 pt-4">
          {confirm === "remove" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm"><Trans>Remove this webhook and its deliveries?</Trans></span>
              <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                <Trans>Remove</Trans>
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirm(null)}>
                <Trans>Keep</Trans>
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-text btn-error btn-sm" onClick={() => setConfirm("remove")}>
              <span className="icon-[tabler--trash] size-4" />
              <Trans>Remove webhook</Trans>
            </button>
          )}
          {(pause.isError || show.isError || rotate.isError || remove.isError) && (
            <div className="alert alert-soft alert-error">{(pause.error ?? show.error ?? rotate.error ?? remove.error)?.message}</div>
          )}
        </section>
      </div>

      {editing && (
        <WebhookForm
          hook={hook}
          local={local}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      )}
      {secret && <SecretDialog name={hook.name} secret={secret} onClose={() => setSecret(null)} />}
    </Modal>
  );
}

function DeliveryRow({ delivery: d, canRetry, retrying, onRetry }: { delivery: WebhookDelivery; canRetry: boolean; retrying: boolean; onRetry: () => void }) {
  const icon = d.status === "sent" ? "icon-[tabler--circle-check] text-success" : d.status === "failed" ? "icon-[tabler--circle-x] text-error" : "icon-[tabler--clock] text-base-content/70";
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <span className={`${icon} size-5 shrink-0`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <code className="text-sm">{d.event}</code> <span className="text-base-content/70">· {formatWhen(d.createdAt)}</span>
        </p>
        <p className={`text-xs ${d.status === "failed" ? "text-error" : "text-base-content/70"}`}>
          {d.status === "sent"
            ? d.responseStatus
              ? t`Delivered — answered ${ph({ status: d.responseStatus })}`
              : t`Delivered`
            : d.status === "pending"
              ? d.attempts
                ? t`Trying again soon (${ph({ error: d.error ?? "" })})`
                : t`Waiting to be sent`
              : (d.error ?? t`Not delivered`)}
          {d.attempts > 1 && ` · ${plural(d.attempts, { one: "# try", other: "# tries" })}`}
        </p>
      </div>
      {d.status === "failed" && canRetry && (
        <button type="button" className="btn btn-text btn-sm" disabled={retrying} onClick={onRetry}>
          {retrying && <span className="loading loading-spinner loading-xs" />}
          <Trans>Retry</Trans>
        </button>
      )}
    </li>
  );
}

const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
