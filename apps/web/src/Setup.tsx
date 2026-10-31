/**
 * The first-time checklist on a new household's dashboard: a home, its rooms, categories, the first things, the
 * family. Each step is ticked from what's really there (not from clicks), and it goes away once done — or when hidden.
 */
import type { Overview } from "@ferret/shared";
import { useState } from "react";
import { useCategories } from "./Catalog";
import { authClient, useCanEdit } from "./lib/auth";
import { CATEGORIES_HREF, IMPORT_HREF, PLACES_HREF, SETTINGS_HREF, WALKTHROUGH_HREF } from "./lib/route";

const hiddenKey = (householdId: string) => `ferret-setup-hidden-${householdId}`;

function isHidden(householdId: string) {
  try {
    return localStorage.getItem(hiddenKey(householdId)) === "1";
  } catch {
    return false;
  }
}

export function SetupChecklist({ householdId, o }: { householdId: string; o: Overview }) {
  const categories = useCategories(householdId);
  const org = authClient.useActiveOrganization();
  const [hidden, setHidden] = useState(() => isHidden(householdId));
  const canEdit = useCanEdit(householdId);
  const steps: { label: string; detail: string; done: boolean; href: string; action: string }[] = [
    { label: "Add your home", detail: "A property — or several: a cabin, a storage unit.", done: o.properties > 0, href: PLACES_HREF, action: "Places" },
    { label: "Add its rooms", detail: "Kitchen, garage, shelves and closets inside them.", done: o.locations > 0, href: PLACES_HREF, action: "Places" },
    {
      label: "Choose categories",
      detail: "Start from the suggested ones and change them later.",
      done: (categories.data?.length ?? 0) > 0,
      href: CATEGORIES_HREF,
      action: "Categories",
    },
    {
      label: "Add your first things",
      detail: "Walk through a room with your camera, or import a spreadsheet.",
      done: o.total.items > 0,
      href: WALKTHROUGH_HREF,
      action: "Walk through",
    },
    {
      label: "Invite your household",
      detail: "So everyone can find things — viewers can only look.",
      done: (org.data?.members.length ?? 0) > 1,
      href: SETTINGS_HREF,
      action: "Invite",
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  // A household well under way doesn't need it; nor does one that's done or said so.
  if (!canEdit || hidden || left === 0 || o.total.items >= 25 || !categories.data || !org.data) return null;
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="card" aria-labelledby="setup-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="icon-[tabler--rocket] size-6 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 id="setup-title" className="text-lg font-semibold text-base-content">
              Getting started
            </h2>
            <p className="text-sm text-base-content/70">
              {steps.length - left} of {steps.length} done
            </p>
          </div>
          <button
            type="button"
            className="btn btn-text btn-sm"
            onClick={() => {
              setHidden(true);
              try {
                localStorage.setItem(hiddenKey(householdId), "1");
              } catch {
                // Hidden for now, then.
              }
            }}
          >
            Hide
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-base-content/10" aria-hidden>
          <div className="h-full rounded-full bg-primary" style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} />
        </div>
        <ol className="flex flex-col divide-y divide-base-content/10">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-center gap-3 py-3">
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  s.done ? "bg-success text-success-content" : i === next ? "border-2 border-primary text-primary" : "border border-base-content/25 text-base-content/70"
                }`}
              >
                {s.done ? <span className="icon-[tabler--check] size-4" /> : i + 1}
                <span className="sr-only">{s.done ? " (done)" : ""}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block font-medium ${s.done ? "text-base-content/70 line-through" : "text-base-content"}`}>{s.label}</span>
                {!s.done && <span className="block text-sm text-base-content/70">{s.detail}</span>}
              </span>
              {!s.done && (
                <span className="flex flex-wrap justify-end gap-2">
                  <a href={s.href} className={`btn btn-sm ${i === next ? "btn-primary" : "btn-soft btn-primary"}`}>
                    {s.action}
                  </a>
                  {s.href === WALKTHROUGH_HREF && (
                    <a href={IMPORT_HREF} className="btn btn-soft btn-primary btn-sm">
                      Import
                    </a>
                  )}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
