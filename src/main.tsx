import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isWebMcpCapableBrowser } from "./browserMode";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");

const Page = isWebMcpCapableBrowser(document.modelContext)
  ? (await import("./AgentApp")).AgentApp
  : (await import("./App")).App;

createRoot(root).render(<StrictMode><Page /></StrictMode>);
