import { useState } from "react";

/** A read-only field with a copy button (FlyonUI "copy from input group"). */
export function CopyField({ label, value, icon }: { label: string; value: string; icon: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <label className="input flex items-center gap-3">
      <span className={`${icon} my-auto size-5 shrink-0 text-base-content/80`} />
      <span className="sr-only">{label}</span>
      <input type="text" className="grow font-mono text-sm" value={value} readOnly onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn btn-text btn-sm btn-square my-auto" aria-label={`Copy ${label}`} onClick={copy}>
        <span className={`${copied ? "icon-[tabler--copy-check] text-success" : "icon-[tabler--copy]"} size-5`} />
      </button>
    </label>
  );
}

