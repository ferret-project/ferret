import { useQuery } from "@tanstack/react-query";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { forgetOffline } from "./offline";

/** The household roles, as on the server (apps/server/src/auth.ts) — viewer is read-only. */
const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  member: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
};

/** Same-origin in production; proxied by Vite in dev. */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  // twoFactorClient without a redirect: the sign-in form asks for the code itself.
  plugins: [organizationClient({ ac, roles }), twoFactorClient(), passkeyClient(), magicLinkClient()],
});

/** Your role in the household (owner, admin, member, viewer), or null until it's known. */
export function useRole(householdId: string) {
  const role = useQuery({
    queryKey: ["role", householdId],
    // null, never undefined (TanStack Query refuses that) — e.g. while the server can't be reached.
    queryFn: async () => (await authClient.organization.getActiveMemberRole()).data?.role ?? null,
  });
  return role.data ?? null;
}

/** Viewers can look and ask but not change anything; the server enforces it, this hides the controls. */
export function useCanEdit(householdId: string) {
  const role = useRole(householdId);
  return role != null && role !== "viewer";
}

/** This browser can make and use passkeys (WebAuthn). */
export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

/** Sign out — and leave nothing of this account on the device (offline captures, the household kept for them). */
export async function signOut() {
  await forgetOffline();
  await authClient.signOut();
}
