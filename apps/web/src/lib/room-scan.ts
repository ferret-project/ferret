import { useQuery } from "@tanstack/react-query";
import { usePlan } from "../PlanUsage";
import { api } from "./api";

/** Room scans can be offered: the server has the vision model, and the household's plan has AI. */
export function useRoomScanOn(householdId: string) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const plan = usePlan(householdId);
  return Boolean(me.data?.features.roomScan) && (plan.data?.plan?.limits.ai ?? true);
}
