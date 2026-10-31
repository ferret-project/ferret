/**
 * #/shopping — what to buy: tracked things that have run out, or are at or below their "keep at least" (server:
 * stock.shoppingList). Laid out like a shopping cart: how many of each (a stepper), tick what goes in the trolley, then
 * "Bought these" adds them to stock, which takes them off the list. Copy or share it as text.
 */
import { BarSearch } from "./Nav";
import type { ShoppingItem } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";
import { money } from "./Overview";

export function Shopping({ householdId }: { householdId: string }) {
  const list = useQuery({ queryKey: ["shopping", householdId], queryFn: api.shopping });
  const canEdit = useCanEdit(householdId);
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const items = list.data?.items ?? [];
  const canShare = typeof navigator.share === "function";
  // How many of each to buy (the suggestion until changed), and what's in the trolley.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [inCart, setInCart] = useState<Set<string>>(new Set());
  const countOf = (i: ShoppingItem) => counts[i.id] ?? i.buy;
  const ticked = items.filter((i) => inCart.has(i.id));
  const estimate = (rows: ShoppingItem[]) => rows.reduce((n, i) => n + (i.unitCents ?? 0) * countOf(i), 0);
  const priced = items.some((i) => i.unitCents != null);
  const bought = useMutation({
    // One at a time: each is a stock movement (and its undo) of its own.
    mutationFn: async (rows: ShoppingItem[]) => {
      for (const i of rows) await api.adjustStock(i.id, countOf(i));
      return rows.length;
    },
    onSuccess: () => {
      setInCart(new Set());
      setCounts({});
      for (const key of ["shopping", "attention", "overview", "items", "stock"]) void qc.invalidateQueries({ queryKey: [key, householdId] });
    },
  });

  async function copy() {
    if (!list.data) return;
    await navigator.clipboard.writeText(list.data.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label="Back">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">Shopping list</h1>
          <HelpLink page="guide/stock.html#shopping-list" label="Shopping list" />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pb-24">
        {list.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {bought.isSuccess && (
          <div className="alert alert-soft alert-success" role="status">
            <span className="icon-[tabler--circle-check] size-5" />
            Added to stock — {bought.data} {bought.data === 1 ? "thing" : "things"} off the list.
          </div>
        )}
        {list.data && items.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--shopping-cart-check] size-10 text-primary" />
              <h2 className="text-lg font-semibold">Nothing to buy</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                Things you track show up here when they run out, or drop to the number you keep at least — set it on the item's
                Stock card.
              </p>
            </div>
          </div>
        )}
        {items.length > 0 && (
          // FlyonUI "Shopping Cart": the list, and beside it (below on a phone) what's in the trolley.
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <ul className="card divide-y divide-base-content/10">
              {items.map((i) => (
                <Row
                  key={i.id}
                  item={i}
                  canEdit={canEdit}
                  count={countOf(i)}
                  onCount={(n) => setCounts({ ...counts, [i.id]: n })}
                  inCart={inCart.has(i.id)}
                  onCart={(on) => {
                    const next = new Set(inCart);
                    if (on) next.add(i.id);
                    else next.delete(i.id);
                    setInCart(next);
                  }}
                />
              ))}
            </ul>
            <section className="card lg:sticky lg:top-20" aria-labelledby="cart-title">
              <div className="card-body gap-4">
                <h2 id="cart-title" className="text-lg font-semibold text-base-content">
                  {canEdit ? "In the trolley" : "To buy"}
                </h2>
                <dl className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-base-content/70">On the list</dt>
                    <dd className="font-medium">{items.length}</dd>
                  </div>
                  {canEdit && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-base-content/70">Ticked</dt>
                      <dd className="font-medium">{ticked.length}</dd>
                    </div>
                  )}
                  {priced && (
                    <div className="flex justify-between gap-2 border-t border-base-content/10 pt-2">
                      <dt className="text-base-content/70">About{canEdit && ticked.length ? " (ticked)" : ""}</dt>
                      <dd className="font-semibold">{money(estimate(canEdit && ticked.length ? ticked : items))}</dd>
                    </div>
                  )}
                </dl>
                {priced && <p className="-mt-2 text-xs text-base-content/70">From what each cost last time, where it's known.</p>}
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-primary" disabled={!ticked.length || bought.isPending} onClick={() => bought.mutate(ticked)}>
                      {bought.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--shopping-cart-check] size-5" />}
                      {ticked.length ? `Bought ${ticked.length === 1 ? "it" : `these ${ticked.length}`}` : "Tick what you bought"}
                    </button>
                    {bought.isError && <p className="text-sm text-error">{bought.error.message}</p>}
                  </>
                )}
                <div className="flex flex-wrap gap-2 border-t border-base-content/10 pt-3">
                  <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => void copy()}>
                    <span className={`${copied ? "icon-[tabler--check]" : "icon-[tabler--copy]"} size-4`} />
                    {copied ? "Copied" : "Copy list"}
                  </button>
                  {canShare && (
                    <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => void navigator.share({ title: "Shopping list", text: list.data!.text }).catch(() => {})}>
                      <span className="icon-[tabler--share] size-4" />
                      Share
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Row(props: { item: ShoppingItem; canEdit: boolean; count: number; onCount: (n: number) => void; inCart: boolean; onCart: (on: boolean) => void }) {
  const { item, canEdit, count } = props;
  const out = item.quantity === 0;
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-2 p-4 ${props.inCart ? "bg-primary/5" : ""}`}>
      {canEdit && (
        <input
          type="checkbox"
          className="checkbox checkbox-primary"
          aria-label={`${item.name} is in the trolley`}
          checked={props.inCart}
          onChange={(e) => props.onCart(e.target.checked)}
        />
      )}
      {item.photoId ? (
        <img src={api.thumbnailUrl(item.photoId)} alt="" loading="lazy" className="size-14 shrink-0 rounded-box bg-base-300 object-cover" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-box bg-base-200 text-base-content/40">
          <span className="icon-[tabler--box] size-6" />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-40">
        <a href={itemHref(item.id)} className={`tap block truncate font-medium hover:underline ${props.inCart ? "text-base-content/70 line-through" : ""}`}>
          {item.name}
        </a>
        <p className="text-sm text-base-content/70">
          <span className={out ? "font-medium text-error" : "text-warning"}>{out ? "None left" : `${item.quantity} left`}</span>
          {item.minQuantity != null ? ` · keep at least ${item.minQuantity}` : ""}
          {item.place ? ` · ${item.place}` : ""}
        </p>
        {item.forTask && <p className="text-sm text-warning">For {forTaskText(item.forTask)}</p>}
      </div>
      <div className="ms-auto flex items-center gap-3">
        {canEdit ? (
          // How many to buy: a stepper.
          <div className="join" role="group" aria-label={`How many ${item.name} to buy`}>
            <button type="button" className="btn btn-soft btn-sm join-item btn-square" aria-label="One fewer" disabled={count <= 1} onClick={() => props.onCount(count - 1)}>
              <span className="icon-[tabler--minus] size-4" />
            </button>
            <span className="join-item flex min-w-10 items-center justify-center bg-base-200 px-2 text-sm font-medium tabular-nums" aria-live="polite">
              {count}
            </span>
            <button type="button" className="btn btn-soft btn-sm join-item btn-square" aria-label="One more" disabled={count >= 10000} onClick={() => props.onCount(count + 1)}>
              <span className="icon-[tabler--plus] size-4" />
            </button>
          </div>
        ) : (
          <span className="text-sm text-base-content/70">Buy {count}</span>
        )}
        {item.unitCents != null && <span className="w-16 text-end text-sm font-medium tabular-nums">{money(item.unitCents * count)}</span>}
      </div>
    </li>
  );
}

/** "Replace furnace filter, due 2026-11-03" → "Replace furnace filter, due Nov 3". */
function forTaskText(text: string) {
  return text.replace(/due (\d{4}-\d{2}-\d{2})$/, (_, d: string) => `due ${new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
}
