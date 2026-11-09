import { t as translateText, locale } from "./i18n";
import { tr } from "./i18n";
/**
 * Settings → Household: the household's money. Amounts are stored as numbers; this only says what they're in, so every
 * screen, the report, the spreadsheet and what the server writes (history, the bell, emails) use its symbol and
 * decimals. Nothing is converted. Owners and admins change it (server: lib/household-time.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { currencyChoices, currencyName, currencySymbol, formatMoney } from "@ferret/shared/utils";
import { useMemo } from "react";
import { api } from "./lib/api";

const label = (code: string) => {
  const symbol = currencySymbol(code, locale());
  return `${code} — ${currencyName(code, locale())}${symbol !== code ? ` (${symbol})` : ""}`;
};

export function CurrencyCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["household-settings", householdId], queryFn: api.householdSettings });
  const save = useMutation({
    mutationFn: (currency: string) => api.setHouseholdSettings({ currency }),
    onSuccess: (data) => {
      qc.setQueryData(["household-settings", householdId], data);
      // The server's own words carry amounts too (the bell, coverage).
      void qc.invalidateQueries({ queryKey: ["attention"] });
    },
  });
  const choices = useMemo(() => currencyChoices(), []);
  const currency = settings.data?.currency;

  return (
    <section className="card" aria-labelledby="currency-title">
      <div className="card-body gap-3">
        <h2 id="currency-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--coins] size-5 text-primary" />
          {translateText("Currency")}</h2>
        <p className="text-sm text-base-content/70">
          {translateText("What prices and values are in — on every screen, the insurance report and spreadsheets. Changing it doesn't convert anything: amounts already entered stay the same numbers.")}</p>
        {settings.isError && <div className="alert alert-soft alert-error text-sm">{settings.error.message}</div>}
        {currency && (
          <>
            {canManage ? (
              <div>
                <label className="label-text" htmlFor="household-currency">
                  {translateText("This household's money")}</label>
                <select id="household-currency" className="select" value={currency} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value)}>
                  <optgroup label={translateText("Most used")}>
                    {choices.common.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={translateText("All currencies")}>
                    {choices.rest.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
            ) : (
              <p className="text-sm">
                <strong>{label(currency)}</strong>
              </p>
            )}
            <p className="text-sm text-base-content/70">{tr("On this device, 1234.50 reads {v0}.", { v0: <span className="font-medium text-base-content">{formatMoney(123_450, currency, { exact: true, locale: locale() })}</span> })}</p>
            {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
          </>
        )}
      </div>
    </section>
  );
}
