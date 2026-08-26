import type { ComputerTreeEntry } from "../../shared/types";

interface FileTreeProps {
  treeByPath: Record<string, ComputerTreeEntry[]>;
  expandedPaths: Set<string>;
  selectedPath: string;
  onToggle(path: string): void;
  onSelect(path: string): void;
}

export function FileTree(props: FileTreeProps) {
  return (
    <div className="file-tree" aria-label="Shared workspace files">
      <button className="tree-root" type="button" onClick={() => props.onToggle("/workspace")}>
        <span aria-hidden="true">⌄</span> /workspace
      </button>
      {props.expandedPaths.has("/workspace") ? (
        <TreeBranch path="/workspace" depth={0} {...props} />
      ) : null}
    </div>
  );
}

function TreeBranch({
  path,
  depth,
  treeByPath,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect
}: FileTreeProps & { path: string; depth: number }) {
  const entries = treeByPath[path] ?? [];
  return (
    <>
      {entries.map((entry) => {
        const directory = entry.type === "directory";
        const expanded = directory && expandedPaths.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              className={`tree-entry${selectedPath === entry.path ? " is-selected" : ""}`}
              style={{ paddingLeft: `${14 + depth * 16}px` }}
              type="button"
              onClick={() => (directory ? onToggle(entry.path) : onSelect(entry.path))}
              title={entry.path}
            >
              <span className="tree-caret" aria-hidden="true">{directory ? (expanded ? "⌄" : "›") : ""}</span>
              <span className="tree-icon" aria-hidden="true">{directory ? "▰" : "▤"}</span>
              <span>{entry.name}</span>
            </button>
            {expanded ? (
              <TreeBranch
                path={entry.path}
                depth={depth + 1}
                treeByPath={treeByPath}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
