import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isCodexInAppBrowser } from "./browserMode";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");

const Page = isCodexInAppBrowser(document.modelContext)
  ? (await import("./AgentApp")).AgentApp
  : (await import("./App")).App;

createRoot(root).render(<StrictMode><Page /></StrictMode>);
