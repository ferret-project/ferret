import { t as translateText } from "./i18n";
/** A small "?" that opens the matching page of the help (/docs, apps/docs). */
export function HelpLink({ page, label }: { page: string; label: string }) {
  return (
    <a href={`/docs/${page}`} className="btn btn-text btn-sm btn-square text-base-content/70" aria-label={translateText("Help: {v0}", { v0: label })} title={translateText("Help")}>
      <span className="icon-[tabler--help-circle] size-5" />
    </a>
  );
}
