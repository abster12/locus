import { useContext } from "react";
import { HostedAuthContext } from "./hosted-auth.ts";
import { SourcesPage } from "./SourcesPage.tsx";

export function HostedAccountPage() {
  const hosted = useContext(HostedAuthContext);
  if (!hosted) return null;
  const { user, library, signOut, signOutFailed } = hosted;
  const initial = user.name.trim().slice(0, 1) || user.email.slice(0, 1).toUpperCase();
  return (
    <section className="stack">
      <div className="pagehead">
        <h1>Account</h1>
      </div>
      {signOutFailed ? <p className="bad" role="alert">Could not sign out. Try again.</p> : null}
      <div className="block" id="hosted-account">
        <h2>Account</h2>
        {user.image ? (
          <img className="account-avatar" src={user.image} alt="" width={64} height={64} />
        ) : (
          <div className="account-avatar" aria-hidden="true">
            {initial}
          </div>
        )}
        <h3>{user.name}</h3>
        <p>{user.email}</p>
        <p>Signed in with Google</p>
        <p>{library.name}</p>
        <p>Owner</p>
        <button type="button" className="btn" onClick={signOut}>
          Sign out
        </button>
      </div>
      <SourcesPage />
    </section>
  );
}
