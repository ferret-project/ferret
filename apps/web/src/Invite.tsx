import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * An invitation link (#/invite/:id): says which household it's for, lets the
 * invited person sign up or sign in with the invited address, then accept or
 * decline. Accepting switches them to the new household.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AuthScreen, Splash } from "./App";
import { AuthLayout } from "./AuthLayout";
import { api } from "./lib/api";
import { authClient, signOut } from "./lib/auth";
import { navigateTo } from "./lib/navigate";

const ROLE_WORDS: Record<string, string> = {
  get owner() { return translateText("an owner"); },
  get admin() { return translateText("an admin"); },
  get member() { return translateText("a member"); },
  get viewer() { return translateText("a viewer (look and ask, no changes)"); },
};

export function InviteScreen({ id }: { id: string }) {
  const { data: session } = authClient.useSession();
  const invitation = useQuery({ queryKey: ["invitation", id], queryFn: () => api.invitation(id), retry: false });
  const respond = useMutation({
    mutationFn: async (answer: "accept" | "decline") => {
      const result =
        answer === "accept"
          ? await authClient.organization.acceptInvitation({ invitationId: id })
          : await authClient.organization.rejectInvitation({ invitationId: id });
      if (result.error) throw new Error(result.error.message || translateText("Something went wrong"));
      const joined = answer === "accept" && result.data && "member" in result.data ? result.data.member : null;
      if (joined) await authClient.organization.setActive({ organizationId: joined.organizationId });
    },
    onSuccess: () => {
      navigateTo("#/");
    },
  });

  if (invitation.isPending) return <Splash />;
  if (invitation.isError) return <Notice icon="icon-[tabler--link-off]" title={translateText("That link doesn't work")} text={invitation.error.message} />;

  const inv = invitation.data;
  const intro = (
    <p className="text-base-content/80">{tr("{v0} invited you to {v1} as ", { v0: <strong>{inv.inviterName}</strong>, v1: <strong>{inv.householdName}</strong> })}{ROLE_WORDS[inv.role] ?? inv.role}.
    </p>
  );

  if (inv.status !== "pending") {
    const why = {
      accepted: translateText("It's already been accepted."),
      rejected: translateText("It was declined."),
      canceled: translateText("It was cancelled."),
      expired: translateText("It has expired."),
    }[inv.status];
    return (
      <Notice
        icon="icon-[tabler--mail-off]"
        title={translateText("Invitation to {v0}", { v0: inv.householdName })}
        text={translateText("{v0} Ask {v1} for a new link if you still need one.", { v0: why, v1: inv.inviterName })}
        signedIn={Boolean(session)}
      />
    );
  }

  if (!session) return <AuthScreen email={inv.email} invitationId={id} intro={intro} />;

  const wrongAccount = session.user.email.toLowerCase() !== inv.email.toLowerCase();
  return (
    <AuthLayout icon="icon-[tabler--home-heart]" title={translateText("Join {v0}", { v0: inv.householdName })} subtitle={intro}>
        <div className="flex flex-col gap-4">
          {wrongAccount ? (
            <>
              <div className="alert alert-soft alert-warning text-sm">{tr("This invitation is for {v0}, but you're signed in as {v1}.", { v0: inv.email, v1: session.user.email })}</div>
              <button type="button" className="btn btn-primary" onClick={() => signOut()}>
                {translateText("Sign out and switch account")}</button>
            </>
          ) : (
            <>
              {respond.isError && <div className="alert alert-soft alert-error text-sm">{respond.error.message}</div>}
              <button type="button" className="btn btn-primary" disabled={respond.isPending} onClick={() => respond.mutate("accept")}>
                {respond.isPending && <span className="loading loading-spinner loading-sm" />}{tr("Join {v0}", { v0: inv.householdName })}</button>
              <button type="button" className="btn btn-text btn-sm" disabled={respond.isPending} onClick={() => respond.mutate("decline")}>
                {translateText("No thanks")}</button>
            </>
          )}
        </div>
    </AuthLayout>
  );
}

function Notice({ icon, title, text, signedIn }: { icon: string; title: string; text: string; signedIn?: boolean }) {
  return (
    <AuthLayout icon={icon} title={title} subtitle={text}>
      <a href="#/" className="btn btn-soft btn-primary">
        {signedIn ? translateText("Back to Ferret") : translateText("Go to sign in")}
      </a>
    </AuthLayout>
  );
}
