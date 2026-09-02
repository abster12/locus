import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RUNTIME } from "./runtime.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const view =
  RUNTIME === "hosted"
    ? import("./hosted-app.tsx").then((mod) => mod.HostedApp)
    : import("./App.tsx").then((mod) => mod.App);

void view.then((View) => {
  createRoot(root).render(
    <StrictMode>
      <View />
    </StrictMode>,
  );
});
