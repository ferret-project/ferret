import { tn } from "./../i18n";
import { t as translateText } from "./../i18n";
import { locale } from "./../i18n";
import type { LocationNode, PlacesTree } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const placesKey = (householdId: string) => ["places", householdId];

/** Properties with their locations as a tree; shared by the Places screen and location pickers. */
export function usePlaces(householdId: string) {
  return useQuery({ queryKey: placesKey(householdId), queryFn: api.places });
}

/** Find a location anywhere in the tree, with the property it belongs to. */
export function findLocation(tree: PlacesTree | undefined, id: string) {
  for (const property of tree?.properties ?? []) {
    const walk = (nodes: LocationNode[]): LocationNode | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = walk(n.children);
        if (found) return found;
      }
    };
    const node = walk(property.locations);
    if (node) return { property, node };
  }
}

const things = (n: number) => tn(n, "{v0} thing", "{v0} things", { v0: n.toLocaleString(locale()) });

/** "12 things (3 here)" — the "here" part only when some of them are in places inside it. */
export function countLabel(n: LocationNode) {
  return n.totalCount === n.itemCount ? things(n.totalCount) : translateText("{v0} ({v1} here)", { v0: things(n.totalCount), v1: n.itemCount.toLocaleString(locale()) });
}
