import { t as translateText, currentLanguage } from "./i18n";
/**
 * Making a household: the first one (App.tsx `CreateHousehold`, when an account has none) and any after it
 * ("New household…" in the household switcher, the account menu and the More page).
 */
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { Modal } from "./Modal";
import { deviceTimeZone } from "./TimeZone";
import { currencyForLocale } from "@ferret/shared/utils";

/** The longest household name the server takes (HOUSEHOLD_NAME_MAX in auth.ts). */
export const HOUSEHOLD_NAME_MAX = 100;

/**
 * Makes a household and switches to it (Better Auth makes a new one the active household, and refreshes the
 * household list itself). Its time zone and currency start as this device's (the currency from its language's
 * country: de-AT → euros); Settings → Household changes them. Throws with the
 * server's reason — e.g. a hosted plan's "one free household".
 */
export async function createHousehold(name: string) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 6)}`;
  const result = await authClient.organization.create({ name, slug });
  if (result.error || !result.data) throw new Error(result.error?.message || translateText("Could not create the household"));
  await api.setHouseholdSettings({ timeZone: deviceTimeZone(), currency: currencyForLocale(navigator.language), language: currentLanguage() }, result.data.id).catch(() => {});
  return result.data;
}

/** "New household…": a name, then you're in it, on its Home. */
export function NewHouseholdDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name")).trim();
    setBusy(true);
    setError(null);
    try {
      await createHousehold(name);
      onClose();
      navigateTo("#/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal id="new-household" onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-1 text-center">
          <h3 id="new-household-title" className="text-2xl font-semibold text-base-content">
            {translateText("New household")}</h3>
          <p className="text-base-content/80">{translateText("A separate inventory — say, a holiday home or your parents' place. You can invite people to it later.")}</p>
        </div>
        <div>
          <label className="label-text" htmlFor="new-household-name">
            {translateText("Household name")}</label>
          <input
            id="new-household-name"
            name="name"
            className="input"
            placeholder={translateText("e.g. The Lake House")}
            maxLength={HOUSEHOLD_NAME_MAX}
            required
            pattern=".*\S.*"
            title={translateText("A name with at least one letter or number")}
            autoFocus
          />
        </div>
        {error && <div className="alert alert-soft alert-error">{error}</div>}
        <div className="flex flex-wrap items-center justify-end gap-4">
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="loading loading-spinner loading-sm" />}
            {translateText("Create household")}</button>
        </div>
      </form>
    </Modal>
  );
}
