/**
 * Where you are in a few-step job (import a file, walk through a room): numbered steps joined by a line, the ones done
 * ticked (and links back, when they have one), the current one in the primary colour.
 */
export function Steps(props: { label: string; steps: { label: string; href?: string }[]; current: number }) {
  return (
    <nav aria-label={props.label}>
      <ol className="flex items-start">
        {props.steps.map((s, i) => {
          const done = i < props.current;
          const now = i === props.current;
          const dot = (
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                done ? "bg-primary text-primary-content" : now ? "border-2 border-primary text-primary" : "border border-base-content/25 text-base-content/70"
              }`}
            >
              {done ? <span className="icon-[tabler--check] size-4" /> : i + 1}
            </span>
          );
          const text = (
            <span className={`text-center text-xs sm:text-sm ${now ? "font-semibold text-base-content" : "text-base-content/70"}`}>{s.label}</span>
          );
          return (
            <li key={s.label} className="relative flex flex-1 flex-col items-center gap-1.5" aria-current={now ? "step" : undefined}>
              {/* The line to the next step: filled once this one is done. */}
              {i < props.steps.length - 1 && (
                <span aria-hidden className={`absolute start-[calc(50%+1.25rem)] end-[calc(-50%+1.25rem)] top-4 h-0.5 ${done ? "bg-primary" : "bg-base-content/15"}`} />
              )}
              {done && s.href ? (
                <a href={s.href} className="tap flex flex-col items-center gap-1.5 hover:[&>span:last-child]:text-primary">
                  {dot}
                  {text}
                </a>
              ) : (
                <>
                  {dot}
                  {text}
                </>
              )}
              <span className="sr-only">{done ? "(done)" : now ? "(current step)" : ""}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
