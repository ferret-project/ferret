/**
 * Settings → Household → Signing key: the public half of the key a thing's export is signed with (lib/signing.ts on
 * the server), to compare with an export's VERIFY.txt or to give to whoever checks one. Public, so anyone here sees it.
 */
import { useQuery } from "@tanstack/react-query";
import type { SigningKey } from "@ferret/shared";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { api } from "./lib/api";
import { copyText } from "./lib/secure-context";

export function SigningKeyCard({ householdId }: { householdId: string }) {
  const key = useQuery({ queryKey: ["signing-key", householdId], queryFn: api.signingKey, staleTime: Infinity });
  return (
    <section className="card" aria-labelledby="signing-key-title">
      <div className="card-body gap-3">
        <h2 id="signing-key-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--signature] size-5 text-primary" />
          <Trans>Signing key</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>
            A thing's signed ZIP (Print or export on its page) is signed with this household's key, so anyone can check nothing in it has changed. Each ZIP carries the key; compare its
            fingerprint with this one to know it's yours. The key is kept in the server's backups, so old exports still check out after a restore.
          </Trans>
        </p>
        {key.isPending && <span className="loading loading-spinner text-primary" />}
        {key.isError && <p className="text-sm text-error">{key.error.message}</p>}
        {key.data && <KeyDetails signingKey={key.data} />}
      </div>
    </section>
  );
}

/** A signing key's fingerprint and public key, with Copy and the allowed_signers file ssh-keygen wants. */
export function KeyDetails({ signingKey }: { signingKey: SigningKey }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-base-content/70"><Trans>Fingerprint</Trans></dt>
        <dd className="break-all font-mono">{signingKey.fingerprint}</dd>
        <dt className="text-base-content/70"><Trans>Public key</Trans></dt>
        <dd className="break-all font-mono text-xs">{signingKey.publicKey}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-soft"
          onClick={async () => {
            await copyText(signingKey.publicKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <span className={`${copied ? "icon-[tabler--copy-check] text-success" : "icon-[tabler--copy]"} size-5`} />
          {copied ? t`Copied` : t`Copy public key`}
        </button>
        <a className="btn btn-soft" download="allowed_signers" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${signingKey.allowedSigners}\n`)}`}>
          <span className="icon-[tabler--download] size-5" />
          <Trans>Download allowed_signers</Trans>
        </a>
      </div>
    </>
  );
}
