/** A category folded into one row of a list (Everything's "Fold big categories", a category's own page). */
import type { FoldedCategory } from "@ferret/shared";
import { plural } from "@lingui/core/macro";
import { api } from "./lib/api";
import { money } from "./lib/money";

/** A folded category in the list: a few of its things' photos, its name, how many and what they're worth. */
export function FolderRow({ folder, onOpen }: { folder: FoldedCategory; onOpen: () => void }) {
  return (
    <li className="card">
      <button type="button" onClick={onOpen} className="card-body flex-row items-center gap-3 rounded-box p-3 text-start focus-visible:outline-2 focus-visible:outline-primary">
        <FolderThumb folder={folder} className="size-14" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{folder.path}</span>
          <span className="text-base-content/70 block truncate text-sm">
            {[plural(folder.count, { one: "# thing", other: "# things" }), folder.valueCents ? money(folder.valueCents, true) : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="icon-[tabler--chevron-right] size-5 shrink-0 text-base-content/40" />
      </button>
    </li>
  );
}

/** Up to four of a folded category's photos as a little grid, or a folders icon. */
export function FolderThumb({ folder, className }: { folder: FoldedCategory; className: string }) {
  if (!folder.photoIds.length) {
    return (
      <span className={`rounded-box bg-base-200 text-base-content/40 flex shrink-0 items-center justify-center ${className}`}>
        <span className="icon-[tabler--folders] size-6" />
      </span>
    );
  }
  return (
    <span className={`rounded-box bg-base-300 grid shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden ${className}`}>
      {folder.photoIds.slice(0, 4).map((id) => (
        <img key={id} src={api.thumbnailUrl(id)} alt="" loading="lazy" className="size-full object-cover" />
      ))}
    </span>
  );
}
