import { t as translateText } from "./i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { languageOf, type Language } from "@ferret/shared/i18n";
import { api } from "./lib/api";
import { t, LanguageSelector } from "./i18n";

export function LanguageSettings({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const key = ["household-settings", householdId];
  const settings = useQuery({ queryKey: key, queryFn: api.householdSettings });
  const save = useMutation({ mutationFn: (language: Language) => api.setHouseholdSettings({ language }), onSuccess: (data) => queryClient.setQueryData(key, data) });
  return <section className="card"><div className="card-body gap-4">
    <h2 className="card-title">{t("Language")}</h2>
    <LanguageSelector account />
    <p className="text-sm text-base-content/70">{t("Your language is used on all your devices and for your notifications. Changing it does not change stored names, dates or amounts.")}</p>
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span>{t("Household default language")}</span>
      <select className="select select-sm w-auto" aria-label={t("Household default language")} disabled={!canManage || save.isPending || !settings.data} value={settings.data?.language ?? "en"} onChange={(event) => save.mutate(languageOf(event.target.value))}>
        <option value="en" lang="en">{translateText("English")}</option><option value="hu" lang="hu">{translateText("Magyar")}</option>
      </select>
    </label>
    <p className="text-sm text-base-content/70">{t("Used for shared messages and external borrowers. Each person's own language takes priority.")}</p>
    {(settings.error || save.error) && <p role="alert" className="text-error">{(settings.error || save.error)?.message}</p>}
  </div></section>;
}
