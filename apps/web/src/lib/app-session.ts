/**
 * The phone app's sign-in in its web screens (lib/install.ts inFerretApp). The app opens a one-time link and the server
 * sets a cookie only its web view has (apps/server lib/app-web-session.ts), so requests work like a key's: one
 * household, maybe read-only, never a real sign-in. Who and which household come from /api/v1/me instead of a session.
 */
import { useQuery } from "@tanstack/react-query";
import { inFerretApp } from "./install";

export type AppAccess = {
  user: { id: string; name: string; email: string };
  household: { id: string; name: string; role: string; readOnly: boolean } | null;
};

/** Null when the app's sign-in has ended (disconnected, left the household) or isn't there. */
export async function appAccess(): Promise<AppAccess | null> {
  const res = await fetch("/api/v1/me", { credentials: "include" });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AppAccess;
}

export function useAppAccess() {
  return useQuery({ queryKey: ["app-access"], queryFn: appAccess, enabled: inFerretApp, staleTime: 60_000, retry: 1 });
}
