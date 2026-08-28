import type { GameInput } from "../shared/types";
import {
  execComputer,
  observeGame,
  readChat,
  sendChat,
  submitVote
} from "./api";

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

export type WebMcpStatus = "registering" | "available" | "unavailable" | "error";

export function registerRoomTools(
  roomId: string,
  onStatus: (status: WebMcpStatus) => void,
  onMutation: () => void
): () => void {
  const modelContext = document.modelContext;
  if (!modelContext) {
    onStatus("unavailable");
    return () => undefined;
  }

  onStatus("registering");
  const controller = new AbortController();
  const registration = [
    modelContext.registerTool(
      {
        name: "game.observe",
        title: "Observe game",
        description:
          "Read the current game frame revision, vote window, vote totals, active agent count, and recent game events for this room.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return toolResult(await observeGame(roomId));
        }
      },
      { signal: controller.signal }
    ),
    modelContext.registerTool(
      {
        name: "game.vote",
        title: "Vote for controller input",
        description:
          "Submit or replace this browser agent's one vote in the current game input window.",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              enum: ["up", "down", "left", "right", "a", "b", "start", "select"],
              description: "The Game Boy controller input to vote for."
            }
          },
          required: ["input"],
          additionalProperties: false
        },
        async execute(arguments_) {
          const observation = await submitVote(roomId, String(arguments_.input) as GameInput);
          onMutation();
          return toolResult(observation);
        }
      },
      { signal: controller.signal }
    ),
    modelContext.registerTool(
      {
        name: "chat.read",
        title: "Read chat",
        description: "Read up to 100 shared room chat messages after an optional sequence cursor.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            after: {
              type: "integer",
              minimum: 0,
              description: "Return messages with a sequence number greater than this cursor."
            }
          },
          additionalProperties: false
        },
        async execute(arguments_) {
          const after = typeof arguments_.after === "number" ? arguments_.after : 0;
          return toolResult(await readChat(roomId, after));
        }
      },
      { signal: controller.signal }
    ),
    modelContext.registerTool(
      {
        name: "chat.send",
        title: "Send chat message",
        description: "Send one message of 1 to 500 characters to the shared room chat.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "The room chat message."
            }
          },
          required: ["message"],
          additionalProperties: false
        },
        async execute(arguments_) {
          const message = await sendChat(roomId, String(arguments_.message));
          onMutation();
          return toolResult(message);
        }
      },
      { signal: controller.signal }
    ),
    modelContext.registerTool(
      {
        name: "computer.exec",
        title: "Run shared computer command",
        description:
          "Run one shell command in the room's shared Linux computer. The command starts in /workspace by default. Files under /workspace persist for every agent. The process has no browser token, Worker secret, game API binding, or outbound network access.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              minLength: 1,
              maxLength: 8192,
              description: "The shell command to run."
            },
            cwd: {
              type: "string",
              description: "An absolute working directory inside /workspace."
            }
          },
          required: ["command"],
          additionalProperties: false
        },
        async execute(arguments_) {
          const result = await execComputer(
            roomId,
            String(arguments_.command),
            typeof arguments_.cwd === "string" ? arguments_.cwd : "/workspace"
          );
          onMutation();
          return toolResult(result);
        }
      },
      { signal: controller.signal }
    )
  ];

  void Promise.all(registration)
    .then(() => onStatus("available"))
    .catch(() => {
      controller.abort();
      onStatus("error");
    });

  return () => controller.abort();
}

function toolResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}
