/** A small "?" that opens the matching page of the help (/docs, apps/docs). */
export function HelpLink({ page, label }: { page: string; label: string }) {
  return (
    <a href={`/docs/${page}`} className="btn btn-text btn-sm btn-square text-base-content/70" aria-label={`Help: ${label}`} title="Help">
      <span className="icon-[tabler--help-circle] size-5" />
    </a>
  );
}
