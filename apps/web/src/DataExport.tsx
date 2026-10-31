/**
 * Settings → Household → "Download everything" (owners and admins): the household's data and files as a ZIP that
 * opens without Ferret (GET /export/everything.zip, streamed). Files come out decrypted, so it asks first.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "./lib/auth";
import { Modal } from "./Modal";
import { HelpLink } from "./HelpLink";

export function DataExport({ householdName, householdId }: { householdName: string; householdId: string }) {
  const role = useQuery({
    queryKey: ["role", householdId],
    queryFn: async () => (await authClient.organization.getActiveMemberRole()).data?.role,
  });
  const [confirming, setConfirming] = useState(false);
  if (role.data !== "owner" && role.data !== "admin") return null;

  return (
    <section className="card" aria-labelledby="export-title">
      <div className="card-body gap-4">
        <div className="space-y-1">
          <h2 id="export-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--file-zip] size-5 text-primary" />
            Download everything
            <HelpLink page="guide/download-everything.html" label="Download everything" />
          </h2>
          <p className="text-sm text-base-content/70">
            All of {householdName}'s data and files in one ZIP that opens without Ferret: every item with its warranties, claims and
            maintenance history (<code>ferret.json</code>), a spreadsheet (<code>items.csv</code>), and every photo and document.
          </p>
        </div>
        <div>
          <button type="button" className="btn btn-soft btn-primary" onClick={() => setConfirming(true)}>
            <span className="icon-[tabler--download] size-5" />
            Download everything…
          </button>
        </div>
      </div>

      {confirming && (
        <Modal id="export-confirm" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-5">
            <div className="space-y-1 text-center">
              <h3 id="export-confirm-title" className="text-xl font-semibold">
                Download everything?
              </h3>
              <p className="text-base-content/80">
                The photos and documents in it aren't encrypted, so anyone who gets the file can read them. Keep it somewhere safe.
                With many photos it's large and takes a while.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" className="btn btn-secondary btn-soft" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <a href="/api/v1/export/everything.zip" download className="btn btn-primary" onClick={() => setConfirming(false)}>
                <span className="icon-[tabler--download] size-5" />
                Download
              </a>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
