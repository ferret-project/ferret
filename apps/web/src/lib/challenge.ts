/**
 * The sign-in proof-of-work check (ALTCHA, self-hosted — see the server's
 * lib/sign-in-guard.ts): solve the challenge the server sent and give back the
 * header value to retry with. Loaded only when it's needed.
 */
import type { Challenge } from "altcha-lib/types";

export const CHALLENGE_HEADER = "x-altcha";

export async function solveSignInChallenge(challenge: Challenge): Promise<string> {
  const [{ solveChallenge }, { deriveKey }] = await Promise.all([import("altcha-lib"), import("altcha-lib/algorithms/web/pbkdf2")]);
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error("Couldn't finish the check — try again");
  return btoa(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution }));
}
