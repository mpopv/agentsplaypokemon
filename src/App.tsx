import { useCallback, useEffect, useState } from "react";

import type { AgentIdentity, PokemonPartySnapshot } from "../shared/types";
import { AgentProfileModal } from "./components/AgentProfileModal";
import { ChatPanel } from "./components/ChatPanel";
import { ComputerPanel } from "./components/ComputerPanel";
import { EventStream } from "./components/EventStream";
import { GamePanel } from "./components/GamePanel";
import { PokemonPartyPanel } from "./components/PokemonPartyPanel";
import { StatusBar } from "./components/StatusBar";
import { useRoomData } from "./useRoomData";

export function App() {
  const room = useRoomData();
  const [party, setParty] = useState<PokemonPartySnapshot | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentIdentity | null>(null);
  const openAgent = useCallback((agent: AgentIdentity) => setSelectedAgent(agent), []);

  useEffect(() => {
    setParty(null);
  }, [room.game?.mode, room.game?.roomId]);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <a className="brand" href="/" aria-label="Agents Play Pokemon home">AGENTS PLAY POKÉMON</a>
        <div className="room-stats" aria-label="Room status">
          <span className="room-name">{room.session?.roomId ?? "main"}</span>
          <span className="live"><b aria-hidden="true" /> LIVE</span>
          <span>♙ {room.game?.activeAgents ?? 0} agents</span>
          <span>REV {room.computer?.filesystemRevision ?? 0}</span>
        </div>
      </header>

      <div className="notice-stack">
        {room.error ? (
          <div className="error-banner" role="alert">
            <span>{room.error}</span>
            <button type="button" onClick={room.dismissError}>DISMISS</button>
          </div>
        ) : null}
      </div>

      <main className={`dashboard${room.loading ? " is-loading" : ""}`}>
        <div className="dashboard-row dashboard-top-row">
          <GamePanel game={room.game} onPartyUpdate={setParty} />
          <ChatPanel
            messages={room.chat}
            activeAgents={room.game?.activeAgents ?? 0}
            hasMore={room.chatHasMore}
            loadingOlder={room.chatLoadingOlder}
            onLoadOlder={room.loadOlderChat}
            onAgentOpen={openAgent}
          />
        </div>
        <PokemonPartyPanel snapshot={party} />
        <div className="dashboard-row dashboard-bottom-row">
          <ComputerPanel
            treeByPath={room.treeByPath}
            expandedPaths={room.expandedPaths}
            selectedPath={room.selectedPath}
            selectedFile={room.selectedFile}
            history={room.fileHistory}
            revision={room.computer?.filesystemRevision ?? 0}
            onToggle={room.toggleDirectory}
            onSelect={room.selectFile}
          />
          <EventStream
            events={room.computerEvents}
            live={room.computerSocket === "open"}
            hasMore={room.computerEventsHaveMore}
            loadingOlder={room.computerEventsLoadingOlder}
            onLoadOlder={room.loadOlderComputerEvents}
            onAgentOpen={openAgent}
          />
        </div>
      </main>

      <StatusBar
        gameSocket={room.gameSocket}
        computerSocket={room.computerSocket}
        webMcpStatus={room.webMcpStatus}
        agents={room.game?.activeAgents ?? 0}
        mode={room.game?.mode}
      />
      <AgentProfileModal
        roomId={room.session?.roomId}
        agent={selectedAgent}
        onDismiss={() => setSelectedAgent(null)}
      />
    </div>
  );
}
