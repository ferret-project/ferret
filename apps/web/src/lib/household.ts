import { createContext, useContext } from "react";

/** The household being looked at, for the screens under the signed-in layout (App.tsx `Screens`). */
export const HouseholdContext = createContext<{ householdId: string; householdName: string } | null>(null);

export function useHousehold() {
  const household = useContext(HouseholdContext);
  if (!household) throw new Error("useHousehold() outside a household's screens");
  return household;
}
