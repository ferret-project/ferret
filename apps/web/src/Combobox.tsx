/**
 * Type-to-filter pickers, for lists that grow too long for a <select>: items
 * (the 10 most recently changed until you type, then a search) and places
 * (filtered by their path). The chosen id goes in a hidden input named `name`,
 * so forms read it from FormData like any field. FlyonUI input + dropdown menu,
 * opened by React; keyboard: ↑/↓, Enter, Escape.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api } from "./lib/api";
import { usePlaces } from "./lib/places";

export interface Choice {
  id: string;
  label: string;
  /** A second line, e.g. where an item is kept. */
  detail?: string | null;
  /** A thumbnail, for items with a photo. */
  image?: string;
}

export function Combobox(props: {
  id: string;
  name: string;
  label: string;
  placeholder: string;
  value: Choice | null;
  onChange: (choice: Choice | null) => void;
  /** Choices for what's been typed so far. */
  choices: Choice[];
  onQuery: (query: string) => void;
  loading?: boolean;
  /** Above the choices, e.g. "Recently changed" before anything is typed. */
  heading?: string;
  /** What "nothing chosen" means here, e.g. "No particular place" (offered as the first choice). */
  noneLabel?: string;
  empty?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const options: (Choice | null)[] = [...(props.noneLabel && !text ? [null] : []), ...props.choices];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function type(value: string) {
    setText(value);
    setActive(0);
    setOpen(true);
    props.onQuery(value);
  }

  function choose(choice: Choice | null) {
    props.onChange(choice);
    setText("");
    props.onQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + options.length) % Math.max(options.length, 1));
    } else if (e.key === "Enter" && open) {
      e.preventDefault(); // don't submit the form
      if (options[active] !== undefined) choose(options[active]!);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // close the list, not the dialog
      setOpen(false);
    }
  }

  const showing = open && !props.disabled;
  return (
    <div ref={box} className={`dropdown relative w-full ${showing ? "open" : ""}`}>
      <label className="label-text" htmlFor={props.id}>
        {props.label}
      </label>
      <input type="hidden" name={props.name} value={props.value?.id ?? ""} />
      <div className="input">
        <span className="icon-[tabler--search] my-auto me-2 size-4 shrink-0 text-base-content/70" />
        <input
          id={props.id}
          // A chosen value shows as the placeholder (typing searches); in full colour so it reads as chosen.
          className={`grow ${props.value ? "placeholder:text-base-content" : ""}`}
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && options[active] !== undefined ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={props.disabled}
          placeholder={props.value ? props.value.label : props.placeholder}
          value={text}
          onChange={(e) => type(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {props.loading && showing && <span className="loading loading-spinner loading-xs my-auto" />}
        {props.value && !text && (
          <button type="button" className="btn btn-text btn-xs btn-circle my-auto" aria-label={`Clear ${props.label}`} onClick={() => choose(null)}>
            <span className="icon-[tabler--x] size-4" />
          </button>
        )}
      </div>
      {props.value && !showing && props.value.detail && <p className="helper-text truncate">{props.value.detail}</p>}
      {showing && (
        <ul
          id={listId}
          role="listbox"
          aria-label={props.label}
          className="dropdown-menu dropdown-open:opacity-100 absolute start-0 top-full z-20 mt-1 max-h-72 w-full min-w-0 overflow-y-auto"
        >
          {props.heading && <li className="dropdown-title px-3 text-xs">{props.heading}</li>}
          {options.map((o, i) => (
            <li
              key={o?.id ?? "none"}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`dropdown-item cursor-pointer gap-3 px-3 ${i === active ? "dropdown-active bg-base-content/10" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onClick={() => choose(o)}
            >
              {o?.image ? (
                <img src={o.image} alt="" className="size-8 shrink-0 rounded-field object-cover" />
              ) : props.choices.some((c) => c.image) ? (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40">
                  <span className={`${o ? "icon-[tabler--box]" : "icon-[tabler--circle-off]"} size-4`} />
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className={`block truncate ${o ? "text-base-content" : "text-base-content/70"}`}>{o ? o.label : props.noneLabel}</span>
                {o?.detail && <span className="block truncate text-xs text-base-content/70">{o.detail}</span>}
              </span>
              {o?.id === props.value?.id && <span className="icon-[tabler--check] size-4 shrink-0 text-primary" />}
            </li>
          ))}
          {options.length === 0 && !props.loading && <li className="px-3 py-2 text-sm text-base-content/70">{props.empty ?? "No matches"}</li>}
        </ul>
      )}
    </div>
  );
}

/** Pick an item: the 10 most recently changed until you type, then a search (names, brands, meaning…). */
export function ItemPicker(props: {
  householdId: string;
  id: string;
  name: string;
  label: string;
  value: Choice | null;
  onChange: (choice: Choice | null) => void;
  noneLabel?: string;
  /** Only boxes (for "put it in a box"). */
  boxes?: boolean;
  /** Leave these out (e.g. the item itself). */
  exclude?: string[];
}) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: ["items", props.householdId, "picker", q, props.boxes],
    queryFn: () => api.listItems(q, { limit: 10, boxes: props.boxes }),
    placeholderData: (previous) => previous,
  });
  const choices = (results.data?.data ?? []).filter((it) => !props.exclude?.includes(it.id)).map((it) => ({
    id: it.id,
    label: it.name,
    detail: [it.brand, it.place].filter(Boolean).join(" · ") || null,
    image: it.photoId ? api.thumbnailUrl(it.photoId) : undefined,
  }));
  return (
    <Combobox
      {...props}
      placeholder={props.boxes ? "Type to find a box" : "Type to find an item"}
      choices={choices}
      onQuery={setQuery}
      loading={results.isFetching}
      heading={q ? undefined : "Recently changed"}
      empty={q ? `Nothing matches "${q}"` : props.boxes ? "No boxes yet — mark an item as a box" : "No items yet"}
    />
  );
}

/** Pick a place (room, closet, shelf…), filtered by its path as you type. `skip` leaves out a location and what's inside it. */
export function PlacePicker(props: {
  householdId: string;
  id: string;
  name: string;
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel: string;
  /** Only this property's places (e.g. moving a location within its property). */
  propertyId?: string;
  skip?: string;
}) {
  const places = usePlaces(props.householdId);
  const [query, setQuery] = useState("");
  const all: Choice[] = [];
  for (const p of places.data?.properties ?? []) {
    if (props.propertyId && p.id !== props.propertyId) continue;
    const walk = (nodes: typeof p.locations) =>
      nodes.forEach((n) => {
        if (n.id === props.skip) return;
        all.push({ id: n.id, label: n.name, detail: n.path });
        walk(n.children);
      });
    walk(p.locations);
  }
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const choices = all.filter((c) => words.every((w) => c.detail!.toLowerCase().includes(w)));
  const value = props.value ? (all.find((c) => c.id === props.value) ?? null) : null;
  return (
    <Combobox
      id={props.id}
      name={props.name}
      label={props.label}
      noneLabel={props.noneLabel}
      placeholder={props.noneLabel}
      value={value}
      onChange={(c) => props.onChange(c?.id ?? null)}
      choices={choices}
      onQuery={setQuery}
      disabled={!places.data}
      empty={all.length ? "No place matches that" : "No places yet — add them under Places"}
    />
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
