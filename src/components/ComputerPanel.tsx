import type {
  ComputerFileHistoryEntry,
  ComputerFileView,
  ComputerTreeEntry
} from "../../shared/types";
import { FileTree } from "./FileTree";

interface ComputerPanelProps {
  treeByPath: Record<string, ComputerTreeEntry[]>;
  expandedPaths: Set<string>;
  selectedPath: string;
  selectedFile: ComputerFileView | null;
  history: ComputerFileHistoryEntry[];
  revision: number;
  onToggle(path: string): void;
  onSelect(path: string): void;
}

export function ComputerPanel({
  treeByPath,
  expandedPaths,
  selectedPath,
  selectedFile,
  history,
  revision,
  onToggle,
  onSelect
}: ComputerPanelProps) {
  const content = selectedFile
    ? selectedFile.encoding === "utf8"
      ? selectedFile.content
      : "Binary file. The spectator view does not render it."
    : "Select a text file to inspect it.";
  const lines = content.split("\n");

  return (
    <section className="computer-panel" aria-labelledby="computer-heading">
      <div className="section-heading">
        <h2 id="computer-heading">SHARED COMPUTER</h2>
        <span className="revision-label">FILESYSTEM REV {revision}</span>
      </div>
      <div className="computer-browser">
        <FileTree
          treeByPath={treeByPath}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
        <div className="file-view">
          <div className="file-tab">
            <span title={selectedPath}>{selectedPath}</span>
            <span>{selectedFile ? formatBytes(selectedFile.size) : "—"}</span>
          </div>
          <div className="code-view" role="region" aria-label="Selected file content" tabIndex={0}>
            {lines.map((line, index) => (
              <div className="code-line" key={`${index}-${line}`}>
                <span className="line-number">{index + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
          </div>
          <div className="file-meta">
            <span>{selectedFile?.encoding ?? "utf8"}</span>
            <span>{history.length} recorded change{history.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}
