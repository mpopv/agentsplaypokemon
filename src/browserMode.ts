interface WebMcpModelContext {
  registerTool?: unknown;
}

export function isWebMcpCapableBrowser(modelContext: unknown): boolean {
  if (!modelContext || typeof modelContext !== "object") return false;
  return typeof (modelContext as WebMcpModelContext).registerTool === "function";
}
