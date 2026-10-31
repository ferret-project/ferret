/**
 * Service providers: the plumber, the HVAC company, the appliance repair shop.
 * A list with one-tap call/email, each provider's page with the tasks they do
 * and every job they've done (with what it cost), and the picker the
 * maintenance dialogs use. Cards and rows follow the FlyonUI patterns used
 * elsewhere (Settings' member rows, the Modal form layout).
 */
import { BarSearch } from "./Nav";
import type { Provider, ProviderInput } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type Choice, Combobox } from "./Combobox";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref, MAINTENANCE_HREF, PROVIDERS_HREF, providerHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { money } from "./Overview";
import { navigateTo } from "./lib/navigate";

export const providersKey = (householdId: string) => ["providers", householdId];
export function useProviders(householdId: string) {
  return useQuery({ queryKey: providersKey(householdId), queryFn: async () => (await api.providers()).data });
}

const TRADES = ["Plumber", "Electrician", "HVAC", "Appliance repair", "Handyman", "Roofer", "Landscaper", "Pest control", "Cleaner", "Locksmith", "Pool & spa", "Insurance agent"];

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** "example.com" → a link that works. */
const websiteUrl = (site: string) => (/^https?:\/\//i.test(site) ? site : `https://${site}`);

/** Call / email / website / map buttons for a provider (the ones they have). */
function ContactButtons({ p, size = "btn-sm" }: { p: Provider; size?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {p.phone && (
        <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} className={`btn btn-soft btn-primary ${size}`}>
          <span className="icon-[tabler--phone] size-4" />
          {p.phone}
        </a>
      )}
      {p.email && (
        <a href={`mailto:${p.email}`} className={`btn btn-soft btn-primary ${size}`} aria-label={`Email ${p.name}`}>
          <span className="icon-[tabler--mail] size-4" />
          Email
        </a>
      )}
      {p.website && (
        <a href={websiteUrl(p.website)} target="_blank" rel="noreferrer" className={`btn btn-soft btn-primary ${size}`} aria-label={`${p.name}'s website`}>
          <span className="icon-[tabler--world] size-4" />
          Website
        </a>
      )}
      {p.address && (
        <a href={`https://maps.apple.com/?q=${encodeURIComponent(p.address)}`} target="_blank" rel="noreferrer" className={`btn btn-soft btn-primary ${size}`}>
          <span className="icon-[tabler--map-pin] size-4" />
          Map
        </a>
      )}
    </div>
  );
}

function Shell({ title, back, action, children }: { title: string; back: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start min-w-0 items-center gap-2">
          <a href={back} className="btn btn-text btn-sm btn-square" aria-label="Back">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{title}</h1>
        </div>
        <BarSearch />
        <div className="navbar-end items-center">{action}</div>
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}

/** #/providers */
export function Providers({ householdId }: { householdId: string }) {
  const providers = useProviders(householdId);
  const canEdit = useCanEdit(householdId);
  const [adding, setAdding] = useState(false);
  return (
    <Shell
      title="Providers"
      back="#/"
      action={
        canEdit && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <span className="icon-[tabler--plus] size-4" />
            Provider
          </button>
        )
      }
    >
      {providers.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
      {providers.isError && <div className="alert alert-soft alert-error">{providers.error.message}</div>}
      {providers.data?.length === 0 && (
        <div className="card">
          <div className="card-body items-center gap-3 text-center">
            <span className="icon-[tabler--address-book] size-10 text-primary" />
            <h2 className="text-lg font-semibold">Who works on your home?</h2>
            <p className="max-w-sm text-sm text-base-content/70">
              Keep your plumber, electrician and HVAC company here — one tap to call, and a record of every job and what it cost.
            </p>
            {canEdit && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                <span className="icon-[tabler--plus] size-5" />
                Add a provider
              </button>
            )}
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {providers.data?.map((p) => (
          <li key={p.id} className="card">
            <div className="card-body gap-3 p-4">
              <a href={providerHref(p.id)} className="flex items-center gap-3">
                <div className="avatar avatar-placeholder">
                  <div className="size-11 rounded-full bg-primary/10 text-primary">
                    <span className="text-lg">{p.name.slice(0, 1).toUpperCase()}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold text-base-content">{p.name}</h2>
                  <p className="truncate text-sm text-base-content/70">
                    {[p.trade, p.contactName].filter(Boolean).join(" · ") || "Service provider"}
                  </p>
                  <p className="text-xs text-base-content/70">
                    {p.visits
                      ? `${p.visits} ${p.visits === 1 ? "job" : "jobs"} · last ${formatDate(p.lastVisit!)}${p.spentCents ? ` · ${money(p.spentCents)}` : ""}`
                      : "No jobs recorded yet"}
                  </p>
                </div>
                <span className="icon-[tabler--chevron-right] size-5 text-base-content/40" />
              </a>
              <ContactButtons p={p} size="btn-xs" />
            </div>
          </li>
        ))}
      </ul>
      {adding && <ProviderDialog householdId={householdId} onClose={() => setAdding(false)} />}
    </Shell>
  );
}

/** #/providers/:id — contact, notes, the tasks they do, and every job with its cost. */
export function ProviderPage({ id, householdId }: { id: string; householdId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const provider = useQuery({ queryKey: [...providersKey(householdId), id], queryFn: () => api.provider(id) });
  const visits = useQuery({ queryKey: [...providersKey(householdId), id, "visits"], queryFn: () => api.providerVisits(id) });
  const tasks = useQuery({ queryKey: ["maintenance", householdId, "provider", id], queryFn: () => api.listMaintenance({ providerId: id }) });
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteProvider(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersKey(householdId) });
      navigateTo(PROVIDERS_HREF);
    },
  });
  const p = provider.data;
  return (
    <Shell
      title={p?.name ?? ""}
      back={PROVIDERS_HREF}
      action={
        canEdit &&
        p && (
          <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => setEditing(true)}>
            <span className="icon-[tabler--pencil] size-4" />
            Edit
          </button>
        )
      }
    >
      {provider.isError && <div className="alert alert-soft alert-error">{provider.error.message}</div>}
      {p && (
        <>
          <section className="card">
            <div className="card-body gap-3 p-4 sm:p-6">
              <div>
                <h1 className="text-xl font-semibold text-base-content">{p.name}</h1>
                <p className="text-sm text-base-content/70">{[p.trade, p.contactName].filter(Boolean).join(" · ")}</p>
              </div>
              <ContactButtons p={p} />
              {p.address && <p className="text-sm text-base-content/70">{p.address}</p>}
              {p.notes && <p className="whitespace-pre-line text-sm text-base-content/80">{p.notes}</p>}
              <p className="text-sm text-base-content/70">
                {p.visits ? `${p.visits} ${p.visits === 1 ? "job" : "jobs"}, ${money(p.spentCents)} in all` : "No jobs recorded yet"}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-base-content">
              <span className="icon-[tabler--tool] size-5 text-primary" />
              Usually does
            </h2>
            {tasks.data?.data.length ? (
              <ul className="card divide-y divide-base-content/10 px-4">
                {tasks.data.data.map((t) => (
                  <li key={t.id} className="py-2">
                    <a href={MAINTENANCE_HREF} className="tap link link-hover text-base-content">
                      {t.title}
                    </a>
                    <span className="block text-sm text-base-content/70">
                      {[t.itemName, t.dueOn && `next ${formatDate(t.dueOn)}`].filter(Boolean).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-base-content/70">No maintenance tasks name them yet — choose them under "Who does it" on a task.</p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 font-semibold text-base-content">
              <span className="icon-[tabler--history] size-5 text-primary" />
              Jobs
            </h2>
            {visits.data?.data.length ? (
              <ul className="card divide-y divide-base-content/10 px-4">
                {visits.data.data.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
                    <span className="w-24 shrink-0 text-sm text-base-content/70">{formatDate(v.doneOn)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base-content">{v.taskTitle}</span>
                      <span className="block text-sm text-base-content/70">
                        {v.itemId ? (
                          <a href={itemHref(v.itemId)} className="tap link link-hover">
                            {v.itemName}
                          </a>
                        ) : null}
                        {v.itemId && v.note ? " · " : ""}
                        {v.note}
                      </span>
                    </span>
                    {v.costCents != null && <span className="shrink-0 font-medium text-base-content">{money(v.costCents)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-base-content/70">Mark a task done and choose them as who did it, and the job shows up here.</p>
            )}
          </section>

          {canEdit && (
            <button
              type="button"
              className="btn btn-text btn-error btn-sm self-start"
              disabled={remove.isPending}
              onClick={() => window.confirm(`Remove ${p.name}? Their past jobs stay on the tasks.`) && remove.mutate()}
            >
              <span className="icon-[tabler--trash] size-4" />
              Remove provider
            </button>
          )}
          {editing && <ProviderDialog householdId={householdId} provider={p} onClose={() => setEditing(false)} />}
        </>
      )}
    </Shell>
  );
}

/** Add or edit a provider. `onCreated` hands back a new one (e.g. to pick it in a task). */
export function ProviderDialog(props: { householdId: string; provider?: Provider; initialName?: string; onClose: () => void; onCreated?: (p: Provider) => void }) {
  const qc = useQueryClient();
  const p = props.provider;
  const save = useMutation({
    mutationFn: (input: ProviderInput) => (p ? api.updateProvider(p.id, input) : api.createProvider(input)),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: providersKey(props.householdId) });
      if (!p) props.onCreated?.(saved);
      props.onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim() || null;
    save.mutate({
      name: String(f.get("name")).trim(),
      trade: text("trade"),
      contactName: text("contactName"),
      phone: text("phone"),
      email: text("email"),
      website: text("website"),
      address: text("address"),
      notes: text("notes"),
    });
  }
  const input = (name: keyof ProviderInput, label: string, attrs: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label-text" htmlFor={`provider-${name}`}>
        {label}
      </label>
      <input id={`provider-${name}`} name={name} className="input" defaultValue={(p?.[name] as string | null | undefined) ?? ""} {...attrs} />
    </div>
  );
  return (
    <Modal id="provider-dialog" title={p ? `Edit ${p.name}` : "New service provider"} onClose={props.onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {input("name", "Name", { required: true, maxLength: 120, autoFocus: true, placeholder: "e.g. Cool Air Co", defaultValue: p?.name ?? props.initialName ?? "" })}
            <div>
              <label className="label-text" htmlFor="provider-trade">
                Trade
              </label>
              <input id="provider-trade" name="trade" className="input" list="provider-trades" defaultValue={p?.trade ?? ""} maxLength={60} placeholder="e.g. HVAC" />
              <datalist id="provider-trades">
                {TRADES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {input("phone", "Phone", { type: "tel", autoComplete: "tel", maxLength: 40 })}
            {input("email", "Email", { type: "email", autoComplete: "email", maxLength: 200 })}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {input("contactName", "Contact person", { maxLength: 120, placeholder: "Who you deal with" })}
            {input("website", "Website", { inputMode: "url", maxLength: 300, placeholder: "coolair.example" })}
          </div>
          {input("address", "Address", { autoComplete: "street-address", maxLength: 300 })}
          <div>
            <label className="label-text" htmlFor="provider-notes">
              Notes
            </label>
            <textarea id="provider-notes" name="notes" className="textarea" rows={3} defaultValue={p?.notes ?? ""} maxLength={5000} placeholder="Account number, hours, who to ask for…" />
          </div>
        </div>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {p ? "Save" : "Add provider"}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** Pick a provider (filtered as you type), with "+ Add …" to make a new one on the spot. */
export function ProviderPicker(props: {
  householdId: string;
  id: string;
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel: string;
}) {
  const providers = useProviders(props.householdId);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const all: Choice[] = (providers.data ?? []).map((p) => ({ id: p.id, label: p.name, detail: p.trade }));
  const q = query.trim().toLowerCase();
  const matches = all.filter((c) => !q || `${c.label} ${c.detail ?? ""}`.toLowerCase().includes(q));
  const ADD = "__add__";
  return (
    <>
      <Combobox
        id={props.id}
        name={props.id}
        label={props.label}
        placeholder={props.noneLabel}
        noneLabel={props.noneLabel}
        value={all.find((c) => c.id === props.value) ?? null}
        onChange={(c) => (c?.id === ADD ? setAdding(query.trim()) : props.onChange(c?.id ?? null))}
        choices={[...matches, { id: ADD, label: q ? `+ Add "${query.trim()}" as a provider` : "+ Add a provider" }]}
        onQuery={setQuery}
      />
      {adding !== null && (
        <ProviderDialog householdId={props.householdId} initialName={adding} onClose={() => setAdding(null)} onCreated={(p) => props.onChange(p.id)} />
      )}
    </>
  );
}
