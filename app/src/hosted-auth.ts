import { createContext } from "react";

export type HostedAuthValue = {
  user: { id: string; name: string; email: string; image: string | null };
  library: { id: string; name: string; role: "owner" };
  signOut: () => void;
  signOutFailed: boolean;
};

export const HostedAuthContext = createContext<HostedAuthValue | null>(null);
