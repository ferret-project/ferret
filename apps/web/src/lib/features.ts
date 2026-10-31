/**
 * What this server can do that depends on how it runs (GET /api/v1/me `features`): "Add from a web address" needs the
 * server's guarded downloader, the Home Assistant import its WebSocket client — not every
 * server has them. Undefined while loading (show nothing that might vanish).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useFeatures() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000 }).data?.features;
}
