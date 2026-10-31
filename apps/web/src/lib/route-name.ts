import { type AnyRouteMatch, useMatches } from "@tanstack/react-router";
import type { Route } from "./route";

/** Which screen is showing (a route's `staticData.name`, router.tsx); a link that went nowhere is "notfound". */
export function useRouteName(): Route["name"] {
  return useMatches({ select: routeName });
}

function routeName(matches: AnyRouteMatch[]): Route["name"] {
  if (matches.some((m) => m.status === "notFound")) return "notfound";
  return matches.at(-1)?.staticData.name ?? "notfound";
}
