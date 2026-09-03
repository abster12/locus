/** Hash to open after a hosted session when the visitor did not pick a room. */
export function hostedDefaultHash(hash: string, itemTotal: number): string {
  const raw = hash.replace(/^#/, "");
  if (raw !== "" && raw !== "/") return hash.startsWith("#") ? hash : `#${raw}`;
  return itemTotal === 0 ? "#/account" : "#/recent";
}
