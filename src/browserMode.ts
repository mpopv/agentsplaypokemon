interface CodexModelContext {
  codexExecuteTool?: unknown;
  codexGetTools?: unknown;
}

export function isCodexInAppBrowser(modelContext: unknown): boolean {
  if (!modelContext || typeof modelContext !== "object") return false;
  const context = modelContext as CodexModelContext;
  return (
    typeof context.codexGetTools === "function" &&
    typeof context.codexExecuteTool === "function"
  );
}
