/**
 * Settings → Household: the household's money. Amounts are stored as numbers; this only says what they're in, so every
 * screen, the report, the spreadsheet and what the server writes (history, the bell, emails) use its symbol and
 * decimals. Nothing is converted. Owners and admins change it (server: lib/household-time.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AMAZON_SITES, currencyChoices, currencyName, currencySymbol, formatMoney } from "@ferret/shared/utils";
import { useMemo } from "react";
import { api } from "./lib/api";
import { Trans } from "@lingui/react/macro";
import { ph, t } from "@lingui/core/macro";

const label = (code: string) => {
  const symbol = currencySymbol(code);
  return `${code} — ${currencyName(code)}${symbol !== code ? ` (${symbol})` : ""}`;
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
          <Trans>Currency</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>What prices and values are in — on every screen, the insurance report and spreadsheets. Changing it doesn't convert
          anything: amounts already entered stay the same numbers.</Trans>
        </p>
        {settings.isError && <div className="alert alert-soft alert-error text-sm">{settings.error.message}</div>}
        {currency && (
          <>
            {canManage ? (
              <div>
                <label className="label-text" htmlFor="household-currency">
                  <Trans>This household's money</Trans>
                </label>
                <select id="household-currency" className="select" value={currency} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value)}>
                  <optgroup label={t`Most used`}>
                    {choices.common.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t`All currencies`}>
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
            <p className="text-sm text-base-content/70">
              <Trans>On this device, 1234.50 reads</Trans> <span className="font-medium text-base-content">{formatMoney(123_450, currency, { exact: true })}</span>.
            </p>
            {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Settings → Household: which Amazon "Search Amazon" opens (the shopping list, things kept stocked). Worked out from the
 * household's time zone and currency until someone picks one.
 */
export function AmazonStoreCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["household-settings", householdId], queryFn: api.householdSettings });
  const save = useMutation({
    mutationFn: (amazonSite: string | null) => api.setHouseholdSettings({ amazonSite }),
    onSuccess: (data) => {
      qc.setQueryData(["household-settings", householdId], data);
      void qc.invalidateQueries({ queryKey: ["shopping", householdId] });
    },
  });
  const s = settings.data;
  const label = (site: string) => {
    const store = AMAZON_SITES.find((a) => a.site === site);
    return store ? `${store.country} — ${site.replace(/^www\./, "")}` : site;
  };

  return (
    <section className="card" aria-labelledby="amazon-title">
      <div className="card-body gap-3">
        <h2 id="amazon-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--shopping-cart] size-5 text-primary" />
          <Trans>Amazon store</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Where Search Amazon looks for parts and supplies on the shopping list. Ferret works it out from the household's time
          zone and currency; pick one if it's wrong.</Trans>
        </p>
        {settings.isError && <div className="alert alert-soft alert-error text-sm">{settings.error.message}</div>}
        {s &&
          (canManage ? (
            <div>
              <label className="label-text" htmlFor="household-amazon">
                <Trans>This household's Amazon</Trans>
              </label>
              <select
                id="household-amazon"
                className="select"
                value={s.amazonSiteChosen ?? ""}
                disabled={save.isPending}
                onChange={(e) => save.mutate(e.target.value || null)}
              >
                <option value="">{t`Worked out: ${ph({ store: label(s.amazonSite) })}`}</option>
                {AMAZON_SITES.map((a) => (
                  <option key={a.site} value={a.site}>
                    {label(a.site)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-sm">
              <strong>{label(s.amazonSite)}</strong>
            </p>
          ))}
        {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
      </div>
    </section>
  );
}
