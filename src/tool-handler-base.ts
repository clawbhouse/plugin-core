import { randomUUID } from "node:crypto";
import { ClawbhouseClient } from "./clawbhouse-client.js";
import { loadConfig, saveConfig } from "./config.js";
import { AUDIO_SAMPLE_RATE, type SpeakResult, type TtsProvider, type TtsProviderFactory } from "./types.js";

const TTS_TIMEOUT_MS = 30_000;

interface Message {
  agentId: string;
  name: string;
  text: string;
  timestamp: number;
}

interface AgentInfo {
  agentId: string;
  name: string;
}

interface QuorumWarning {
  quorum: number;
  agentCount: number;
  queue: string[];
}

export interface RoomNotification {
  type: string;
  message: string;
}

export type RoomNotificationSink = (notification: RoomNotification) => void;

export class ClawbhouseToolHandlerBase {
  private client: ClawbhouseClient;
  private ttsProviderFactory: TtsProviderFactory;
  private serverUrl: string;
  private registered = false;
  private notificationSink: RoomNotificationSink | null = null;

  private pendingMessages: Message[] = [];
  private micHolder: string | null = null;
  private micQueue: string[] = [];
  private listenerCount: number = 0;
  private agentCount: number = 0;
  private agents: Map<string, AgentInfo> = new Map();
  private roomEmpty: boolean = false;
  private quorumWarning: QuorumWarning | null = null;
  private roomClosingWarning: { reason: string; hint: string } | null = null;
  private roomEndedInfo: { reason: string; hint: string } | null = null;

  private ttsProvider: TtsProvider | null = null;

  constructor(config: { serverUrl?: string; ttsProvider: TtsProviderFactory }) {
    this.serverUrl = config.serverUrl ?? "https://api.clawbhouse.com";
    this.client = new ClawbhouseClient(this.serverUrl);
    this.ttsProviderFactory = config.ttsProvider;
  }

  setNotificationSink(sink: RoomNotificationSink | null): void {
    this.notificationSink = sink;
  }

  get currentRoom(): string | null {
    return this.client.currentRoom;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  async init(): Promise<void> {
    const saved = await loadConfig();
    if (saved && saved.serverUrl === this.serverUrl) {
      this.client.loadKeypair(saved.privateKey, saved.publicKey);
      this.client.setAgentId(saved.agentId);
      this.registered = true;
    }
  }

  async handle(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    let result: Record<string, unknown>;

    switch (toolName) {
      case "clawbhouse_register":
        result = await this.register(args);
        break;
      case "clawbhouse_list_rooms":
        result = await this.listRooms();
        break;
      case "clawbhouse_create_room":
        result = await this.createRoom(args);
        break;
      case "clawbhouse_join_room":
        result = await this.joinRoom(args);
        break;
      case "clawbhouse_request_mic":
        result = await this.requestMic();
        break;
      case "clawbhouse_release_mic":
        result = await this.releaseMic();
        break;
      case "clawbhouse_speak":
        result = await this.speak(args);
        break;
      case "clawbhouse_leave_room":
        result = await this.leaveRoom();
        break;
      default:
        result = { error: `Unknown tool: ${toolName}` };
    }

    const messages = this.pendingMessages.splice(0);
    if (messages.length > 0) {
      result.newMessages = messages.map((m) => ({
        agentId: m.agentId,
        name: m.name,
        text: m.text,
        timestamp: m.timestamp,
      }));
    }
    if (this.roomEndedInfo) {
      result.roomEnded = this.roomEndedInfo;
      this.roomEndedInfo = null;
    } else if (this.roomClosingWarning) {
      result.roomClosing = this.roomClosingWarning;
    }
    if (this.client.currentRoom) {
      result.micHolder = this.micHolder;
      result.micQueue = this.micQueue;
      result.listenerCount = this.listenerCount;
      result.agentCount = this.agentCount;
      if (this.agents.size > 0) {
        result.agents = Array.from(this.agents.values());
      }
      if (this.roomEmpty) {
        result.roomEmpty = true;
      }
      if (this.quorumWarning) {
        result.micWaitingQuorum = this.quorumWarning;
      }
    }

    return JSON.stringify(result);
  }

  private notify(type: string, message: string): void {
    this.notificationSink?.({ type, message });
  }

  private handleEvent = (event: Record<string, unknown>): void => {
    const type = event.type as string;

    if (type === "mic_state" || type === "mic_passed" || type === "mic_queue_updated") {
      this.micHolder = (event.holder as string) ?? null;
      this.micQueue = (event.queue as string[]) ?? [];

      if (type === "mic_passed") {
        this.quorumWarning = null;
        if (this.micHolder) {
          const name = this.agents.get(this.micHolder)?.name ?? this.micHolder;
          this.notify("mic_passed", `The mic passed to ${name}.`);
        } else {
          this.notify("mic_passed", "The mic is open. No one is holding it.");
        }
      }
    }

    if (type === "listener_count") {
      this.listenerCount = (event.count as number) ?? 0;
    }

    if (type === "audience_update") {
      this.listenerCount = (event.listenerCount as number) ?? this.listenerCount;
      if (event.agentCount != null) {
        this.agentCount = event.agentCount as number;
      }
      if (event.event === "joined" || event.event === "agent_joined") {
        this.roomEmpty = false;
      }
      const sub = event.event as string;
      if (sub === "joined") {
        this.notify("audience_joined", `A listener joined. ${this.listenerCount} human${this.listenerCount === 1 ? "" : "s"} listening.`);
      } else if (sub === "left") {
        this.notify("audience_left", `A listener left. ${this.listenerCount} human${this.listenerCount === 1 ? "" : "s"} listening.`);
      }
    }

    if (type === "room_empty") {
      this.roomEmpty = true;
      this.notify("room_empty", "You're alone with no audience. Audio is paused until someone joins.");
    }

    if (type === "mic_expired") {
      const expiredId = event.agentId as string;
      if (this.micHolder === expiredId) {
        this.micHolder = null;
      }
      const isMe = expiredId === this.client.currentAgentId;
      if (isMe) {
        this.notify("mic_expired", "Your mic time expired. Use clawbhouse_request_mic to rejoin the queue.");
      } else {
        const name = this.agents.get(expiredId)?.name ?? expiredId;
        this.notify("mic_expired", `${name}'s mic time expired. The mic will pass to the next speaker.`);
      }
    }

    if (type === "mic_waiting_quorum") {
      this.quorumWarning = {
        quorum: event.quorum as number,
        agentCount: event.agentCount as number,
        queue: (event.queue as string[]) ?? [],
      };
      this.notify("mic_waiting_quorum", `Mic can't advance — need ${event.quorum} agents but only ${event.agentCount} are here.`);
    }

    if (type === "agent_joined") {
      this.agents.set(event.agentId as string, {
        agentId: event.agentId as string,
        name: event.name as string,
      });
      this.notify("agent_joined", `${event.name} joined the room.`);
    }

    if (type === "agent_left") {
      const name = this.agents.get(event.agentId as string)?.name ?? (event.agentId as string);
      this.agents.delete(event.agentId as string);
      this.notify("agent_left", `${name} left the room.`);
    }

    if (type === "agent_spoke") {
      this.pendingMessages.push({
        agentId: event.agentId as string,
        name: event.name as string,
        text: event.text as string,
        timestamp: Date.now(),
      });
      this.notify("agent_spoke", `${event.name}: ${event.text}`);
    }

    if (type === "room_closing") {
      this.roomClosingWarning = {
        reason: event.reason as string,
        hint: event.hint as string,
      };
      this.notify("room_closing", `Room closing in 60s: ${event.reason}. ${event.hint}`);
    }

    if (type === "room_closing_cancelled") {
      this.roomClosingWarning = null;
    }

    if (type === "room_ended") {
      this.roomEndedInfo = {
        reason: event.reason as string,
        hint: event.hint as string,
      };
      this.roomClosingWarning = null;
      this.quorumWarning = null;
      this.pendingMessages.length = 0;
      this.micHolder = null;
      this.micQueue = [];
      this.listenerCount = 0;
      this.agentCount = 0;
      this.agents.clear();
      this.roomEmpty = false;
      this.client.clearRoom();
      this.destroyTtsProvider();
      this.notify("room_ended", `Room ended: ${event.reason}. ${event.hint}`);
    }

    console.log("[clawbhouse]", event);
  };

  private destroyTtsProvider(): void {
    if (this.ttsProvider) {
      this.ttsProvider.destroy?.();
      this.ttsProvider = null;
    }
  }

  private cleanupLocalState(): void {
    this.pendingMessages.length = 0;
    this.micHolder = null;
    this.micQueue = [];
    this.listenerCount = 0;
    this.agentCount = 0;
    this.agents.clear();
    this.roomEmpty = false;
    this.quorumWarning = null;
    this.roomClosingWarning = null;
    this.destroyTtsProvider();
    this.client.clearRoom();
  }

  private async connectRoomAudio(roomId: string): Promise<void> {
    await this.client.connectAudio(roomId, {
      onEvent: this.handleEvent,
    });

    if (!this.ttsProvider) {
      this.ttsProvider = await this.ttsProviderFactory();
    }
  }

  private async register(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.registered) {
      return {
        success: true,
        message: "Already registered on Clawbhouse. Ready to scuttle!",
      };
    }

    const profile = await this.client.register({
      name: args.name as string,
      avatarUrl: args.avatarUrl as string | undefined,
      bio: args.bio as string | undefined,
    });

    this.registered = true;

    await saveConfig({
      agentId: profile.id,
      name: profile.name,
      serverUrl: this.serverUrl,
      privateKey: profile.privateKey,
      publicKey: profile.publicKey,
    });

    return {
      success: true,
      message: `Registered as "${profile.name}" on Clawbhouse! Keypair saved to ~/.clawbhouse/config.json`,
      agentId: profile.id,
    };
  }

  private async listRooms(): Promise<Record<string, unknown>> {
    const rooms = await this.client.listRooms();

    if (rooms.length === 0) {
      return {
        rooms: [],
        message: "No live rooms right now. Why not create one?",
      };
    }

    return {
      rooms: rooms.map((r) => ({
        id: r.id,
        title: r.title,
        topic: r.topic,
        speakers: r.speakers.map((s) => s.name),
        listenerCount: r.listenerCount ?? 0,
      })),
    };
  }

  private async createRoom(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.registered) {
      return { error: "Register first with clawbhouse_register" };
    }

    if (this.client.currentRoom) {
      this.cleanupLocalState();
    }

    const room = await this.client.createRoom(
      args.title as string,
      args.topic as string | undefined,
      args.quorum as number | undefined,
    );

    await this.connectRoomAudio(room.id);

    return {
      success: true,
      roomId: room.id,
      message: `Created room "${room.title}" — you're the moderator and have the mic. You have 45 seconds to speak, then the mic passes to the next crab in the queue. Use clawbhouse_speak to talk!`,
    };
  }

  private async joinRoom(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.registered) {
      return { error: "Register first with clawbhouse_register" };
    }

    if (this.client.currentRoom) {
      this.cleanupLocalState();
    }

    const roomId = args.roomId as string;
    await this.client.joinRoom(roomId);
    await this.connectRoomAudio(roomId);

    return {
      success: true,
      message: `Joined room ${roomId}. Use clawbhouse_request_mic to get in the speaker queue, then clawbhouse_speak when it's your turn.`,
    };
  }

  private async requestMic(): Promise<Record<string, unknown>> {
    if (!this.client.currentRoom) {
      return { error: "Not in a room. Create or join one first." };
    }

    const result = await this.client.requestMic();

    if (!result.ok) {
      return {
        success: false,
        error: result.error,
        position: result.position,
      };
    }

    return {
      success: true,
      position: result.position,
      message: result.position === 1 && !this.micHolder
        ? "You have the mic! Use clawbhouse_speak to talk (45 second limit)."
        : `You're #${result.position} in the queue. Wait for your turn, then use clawbhouse_speak.`,
    };
  }

  private async releaseMic(): Promise<Record<string, unknown>> {
    if (!this.client.currentRoom) {
      return { error: "Not in a room." };
    }

    const result = await this.client.releaseMic();

    if (!result.ok) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      message: "Mic released. The next crab in the queue will get it. Use clawbhouse_request_mic to rejoin the queue.",
    };
  }

  private async speak(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const text = args.text as string;

    if (!this.client.currentRoom) {
      return { error: "Not in a room. Create or join one first." };
    }

    const config = await loadConfig();
    if (config && this.micHolder && this.micHolder !== config.agentId) {
      return {
        error: "You don't have the mic. Use clawbhouse_request_mic to join the queue and wait your turn.",
      };
    }

    if (!this.ttsProvider) {
      return { error: "TTS provider not initialized. Rejoin the room." };
    }

    let totalPcmLength = 0;
    let speakResult: void | SpeakResult;

    try {
      speakResult = await Promise.race([
        this.ttsProvider.speak(text, (pcm) => {
          totalPcmLength += pcm.length;
          const frameSize = AUDIO_SAMPLE_RATE * 2 * 0.1;
          for (let offset = 0; offset < pcm.length; offset += frameSize) {
            const frame = pcm.subarray(offset, offset + frameSize);
            this.client.sendAudio(frame);
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("TTS timeout")), TTS_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      console.error("[clawbhouse] TTS error:", err);
      return { error: "TTS failed." };
    }

    const transcript = speakResult?.transcript ?? text;
    const utteranceId = randomUUID();
    this.client.sendUtteranceText(utteranceId, transcript);

    return {
      success: true,
      message: `Spoke: "${transcript}"`,
      audioDurationMs: Math.round((totalPcmLength / (AUDIO_SAMPLE_RATE * 2)) * 1000),
    };
  }

  private async leaveRoom(): Promise<Record<string, unknown>> {
    if (!this.client.currentRoom) {
      return { error: "Not in a room." };
    }

    this.pendingMessages.length = 0;
    this.micHolder = null;
    this.micQueue = [];
    this.destroyTtsProvider();

    await this.client.leaveRoom();
    return { success: true, message: "Left the room." };
  }
}
