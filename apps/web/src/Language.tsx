/**
 * Language, per device (lib/i18n.ts) — in the account menu and on the phone's More page, beside Appearance. Shown only
 * when this build has a language besides English. Partly translated ones say how far along they are.
 *
 * Picking one also saves it with the account, so emails and notifications come in it too (server: lib/language.ts);
 * `useAccountLanguage` keeps the two in step.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId } from "react";
import { api } from "./lib/api";
import { LANGUAGES, MOSTLY_TRANSLATED, chosenOnDevice, currentLanguage, setLanguage } from "./lib/i18n";

/** Saves the choice with the account (best effort: offline, it's saved next time), then switches. */
async function choose(code: string) {
  await api.setMyLanguage(code === "en" ? null : code).catch(() => {});
  setLanguage(code);
}

/**
 * Signed in: a device that hasn't chosen a language takes the account's (a new phone is in your language straight
 * away); an account without one takes this device's, so what Ferret sends matches what you read.
 */
export function useAccountLanguage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000 });
  const account = me.data?.language;
  useEffect(() => {
    if (account === undefined) return;
    const here = currentLanguage();
    if (account && account !== here && !chosenOnDevice() && LANGUAGES.some((l) => l.code === account)) setLanguage(account);
    else if (account === null && here !== "en") void api.setMyLanguage(here).then(() => qc.invalidateQueries({ queryKey: ["me"] }), () => {});
  }, [account, qc]);
}

export function LanguageChoice({ inMenu = false }: { inMenu?: boolean }) {
  const { t } = useLingui();
  const id = useId();
  if (LANGUAGES.length < 2) return null;
  const select = (
    <select id={id} className={`select ${inMenu ? "select-sm" : ""} w-full`} value={currentLanguage()} onChange={(e) => void choose(e.target.value)}>
      {LANGUAGES.map(({ code, name, percent }) => (
        <option key={code} value={code}>
          {percent >= MOSTLY_TRANSLATED ? name : t`${name} (${percent}% translated)`}
        </option>
      ))}
    </select>
  );
  if (inMenu) {
    return (
      <li className="px-3 pb-1" role="none">
        <label className="dropdown-title block px-1 pt-1 text-xs" htmlFor={id}>
          <Trans>Language</Trans>
        </label>
        {select}
      </li>
    );
  }
  return (
    <div>
      <label className="mb-2 block text-sm font-semibold" htmlFor={id}>
        <Trans>Language</Trans>
      </label>
      {select}
    </div>
  );
}
