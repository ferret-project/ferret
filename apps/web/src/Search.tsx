/**
 * The search box on the home screens, and how search flows:
 * - **Clear**: the ✕ in the box, or Esc (a second Esc leaves the box).
 * - **Jump to it** from anywhere: `/` or ⌘K / Ctrl+K (useSearchHotkeys, in the signed-in shell); from another screen it
 *   goes home first.
 * - **Keyboard through results**: ↓ from the box to the first result, ↑/↓ between them, Esc back to the box; Enter in
 *   the box searches now and moves to the results (on a phone it just closes the keyboard).
 * - **Kept in the address** (`#/?q=drill`, `#/in/<room>?q=drill`): Back from an item returns to the results.
 * - **Recent searches** on this device, shown under the empty box while it has focus.
 */
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { navigateTo } from "./lib/navigate";

const RECENT_MAX = 6;
const recentKey = (householdId: string) => `ferret.recentSearches.${householdId}`;

/** The `?q=` on the current hash, if any. */
export function queryInHash(hash = window.location.hash) {
  const m = /\?q=([^&]*)$/.exec(hash);
  return m ? decodeURIComponent(m[1]!.replace(/\+/g, " ")) : "";
}

/** The hash without its `?q=` (what the router reads). */
export const withoutQuery = (hash: string) => hash.replace(/\?q=[^&]*$/, "");

/** Keep the search in the address without adding a history entry per keystroke. */
function writeQuery(query: string) {
  const base = withoutQuery(window.location.hash) || "#/";
  const next = query ? `${base}?q=${encodeURIComponent(query)}` : base;
  if (next !== window.location.hash) history.replaceState(history.state, "", next);
}

/** "⌘K" on a Mac (or an iPad with a keyboard), "Ctrl K" elsewhere — the hint in the empty box. */
export const COMMAND_K = /mac|iphone|ipad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent,
)
  ? "⌘K"
  : "Ctrl K";

let focusOnMount = false;
const FOCUS_EVENT = "ferret:focus-search";

/** `/` and ⌘K / Ctrl+K: to the search box — on the home screens it's there; elsewhere go home and focus it there. */
/** From a screen without the search box: go home with the cursor in it (the top bar's search, ⌘K, /). */
export function searchFromAnywhere() {
  focusOnMount = true;
  navigateTo("#/");
}

export function useSearchHotkeys(onHomeScreen: boolean) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
      const commandK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing;
      if (!commandK && !slash) return;
      if (document.querySelector("dialog[open], [role=dialog]")) return; // a dialog has the keyboard
      e.preventDefault();
      if (onHomeScreen) window.dispatchEvent(new Event(FOCUS_EVENT));
      else searchFromAnywhere();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onHomeScreen]);
}

function readRecent(householdId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(householdId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(householdId: string, list: string[]) {
  try {
    if (list.length) localStorage.setItem(recentKey(householdId), JSON.stringify(list));
    else localStorage.removeItem(recentKey(householdId));
  } catch {
    /* private browsing: just not remembered */
  }
}

/**
 * The search text, kept in the address. `routeKey` is the screen (without its `?q=`): moving to another one takes
 * its own search (usually none).
 */
export function useSearchText(routeKey: string, onArrive: (query: string) => void) {
  const [search, setSearch] = useState(queryInHash);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const q = queryInHash();
    setSearch(q);
    onArrive(q.trim()); // a search that came with the link runs now, not after the typing pause
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new ?q= on the same screen (a link, an edited address). Typing writes the address too, but that's already the text.
  const inAddress = useRouterState({ select: (s) => queryInHash(`#${s.location.href}`) });
  useEffect(() => {
    setSearch((current) => {
      if (inAddress.trim() === current.trim()) return current;
      onArrive(inAddress.trim());
      return inAddress;
    });
  }, [inAddress]); // eslint-disable-line react-hooks/exhaustive-deps
  return [search, setSearch] as const;
}

export function SearchBox(props: {
  householdId: string;
  value: string;
  onChange: (v: string) => void;
  /** The debounced query, as searched (written to the address). */
  query: string;
  /** Search now (skip the pause). */
  onSubmit: () => void;
  placeholder: string;
  busy: boolean;
  /** The results list, for ↓ and Enter. */
  results: React.RefObject<HTMLElement | null>;
  scan: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState(() => readRecent(props.householdId));

  useEffect(() => writeQuery(props.query), [props.query]);

  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    if (focusOnMount) {
      focusOnMount = false;
      focus();
    }
    window.addEventListener(FOCUS_EVENT, focus);
    return () => window.removeEventListener(FOCUS_EVENT, focus);
  }, []);

  function remember(q: string) {
    const v = q.trim();
    if (!v) return;
    const next = [v, ...recent.filter((r) => r.toLowerCase() !== v.toLowerCase())].slice(0, RECENT_MAX);
    setRecent(next);
    writeRecent(props.householdId, next);
  }

  // A result opened from a search: worth remembering.
  useEffect(() => {
    const list = props.results.current;
    if (!list) return;
    const onClick = (e: Event) => {
      if ((e.target as HTMLElement).closest("a[data-result]")) remember(props.value);
    };
    list.addEventListener("click", onClick);
    return () => list.removeEventListener("click", onClick);
  });

  const firstResult = () => props.results.current?.querySelector<HTMLAnchorElement>("a[data-result]") ?? null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (props.value) props.onChange("");
      else input.current?.blur();
    } else if (e.key === "ArrowDown") {
      const first = firstResult();
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      props.onSubmit();
      remember(props.value);
      // A phone: close the keyboard so the results show. A keyboard: go to them.
      if (window.matchMedia("(pointer: coarse)").matches) input.current?.blur();
      else setTimeout(() => firstResult()?.focus(), 350);
    }
  }

  // ↑/↓ between results, Esc back to the box.
  useEffect(() => {
    const list = props.results.current;
    if (!list) return;
    const onKey = (e: KeyboardEvent) => {
      const links = [...list.querySelectorAll<HTMLAnchorElement>("a[data-result]")];
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      if (at < 0) return;
      if (e.key === "ArrowDown" && at < links.length - 1) {
        e.preventDefault();
        links[at + 1]!.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (at > 0) links[at - 1]!.focus();
        else input.current?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    list.addEventListener("keydown", onKey);
    return () => list.removeEventListener("keydown", onKey);
  });

  const showRecent = focused && !props.value && recent.length > 0;
  return (
    <div className="relative">
      <div className="flex gap-2">
        <label className="input flex-1 items-center gap-3">
          <span className="icon-[tabler--search] size-5 shrink-0 text-base-content/70" />
          <input
            ref={input}
            type="search"
            className="grow [&::-webkit-search-cancel-button]:hidden"
            placeholder={props.placeholder}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label="Search your stuff"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {props.busy && <span className="loading loading-spinner loading-sm shrink-0 text-base-content/70" aria-label="Searching" />}
          {props.value ? (
            <button
              type="button"
              className="btn btn-text btn-sm btn-circle shrink-0"
              aria-label="Clear the search"
              onClick={() => {
                props.onChange("");
                input.current?.focus();
              }}
            >
              <span className="icon-[tabler--x] size-5" />
            </button>
          ) : (
            !focused && (
              <span className="flex shrink-0 items-center gap-1 text-base-content/70 pointer-coarse:hidden" title={`${COMMAND_K} or / to search`}>
                <kbd className="kbd border-base-content/15 bg-base-200 font-sans text-sm text-base-content/70">{COMMAND_K}</kbd>
              </span>
            )
          )}
        </label>
        {props.scan}
      </div>
      {showRecent && (
        // Pressing in here mustn't take the focus from the box (that would close it before the click lands).
        <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-box border border-base-content/10 bg-base-100 p-3 shadow-lg" onMouseDown={(e) => e.preventDefault()}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm text-base-content/70">Recent searches</span>
            <button
              type="button"
              className="btn btn-text btn-xs"
              onClick={() => {
                setRecent([]);
                writeRecent(props.householdId, []);
              }}
            >
              Clear
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r} type="button" className="btn btn-soft btn-sm" onClick={() => props.onChange(r)}>
                <span className="icon-[tabler--history] size-4" />
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
