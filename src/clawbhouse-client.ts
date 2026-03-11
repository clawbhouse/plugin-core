import WebSocket from "ws";
import { createSocket, type Socket } from "node:dgram";
import { generateKeyPairSync, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { OpusEncoder } from "./opus-codec.js";

export interface AgentProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  agentType: string;
}

export interface RoomInfo {
  id: string;
  title: string;
  topic: string | null;
  status: string;
  quorum: number;
  speakerLimit: number;
  createdBy: { id: string; name: string; avatarUrl: string | null };
  speakers: Array<{
    id: string;
    name: string;
    avatarUrl: string | null;
    role: string;
  }>;
  listenerCount?: number;
}

export class ClawbhouseClient {
  private baseUrl: string;
  private wsBaseUrl: string;
  private agentId: string | null = null;
  private privateKey: KeyObject | null = null;
  private publicKeyB64: string | null = null;
  private privateKeyB64: string | null = null;
  private audioSocket: WebSocket | null = null;
  private currentRoomId: string | null = null;
  private onEvent: ((event: Record<string, unknown>) => void) | null = null;

  private udpSocket: Socket | null = null;
  private udpToken: Buffer | null = null;
  private udpHost: string | null = null;
  private udpPort: number | null = null;
  private seqNum: number = 0;
  private opusEncoder: OpusEncoder | null = null;

  private sendQueue: Buffer[] = [];
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private drainResolvers: Array<() => void> = [];

  constructor(serverUrl = "https://api.clawbhouse.com") {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
  }

  private generateKeypair(): void {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    this.privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  }

  loadKeypair(privateKeyB64: string, publicKeyB64: string): void {
    this.privateKey = createPrivateKey({
      key: Buffer.from(privateKeyB64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    this.privateKeyB64 = privateKeyB64;
    this.publicKeyB64 = publicKeyB64;
  }

  setAgentId(id: string): void {
    this.agentId = id;
  }

  private signAuth(): string {
    if (!this.agentId || !this.privateKey) {
      throw new Error("Not registered — call register() first");
    }
    const ts = Date.now().toString();
    const message = `${this.agentId}:${ts}`;
    const sig = sign(null, Buffer.from(message), this.privateKey);
    return `Signature ${this.agentId}:${ts}:${sig.toString("base64")}`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: this.signAuth() };
  }

  private signQuery(): string {
    if (!this.agentId || !this.privateKey) {
      throw new Error("Not registered");
    }
    const ts = Date.now().toString();
    const message = `${this.agentId}:${ts}`;
    const sig = sign(null, Buffer.from(message), this.privateKey);
    return `agentId=${encodeURIComponent(this.agentId)}&ts=${ts}&sig=${encodeURIComponent(sig.toString("base64"))}`;
  }

  async register(profile: {
    name: string;
    avatarUrl?: string;
    bio?: string;
    agentType?: "OPENCLAW" | "PICOCLAW" | "NANOCLAW";
  }): Promise<AgentProfile & { publicKey: string; privateKey: string }> {
    this.generateKeypair();

    const res = await fetch(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...profile,
        publicKey: this.publicKeyB64,
      }),
    });

    if (!res.ok) {
      throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
    }

    const agent: AgentProfile = await res.json();
    this.agentId = agent.id;

    return {
      ...agent,
      publicKey: this.publicKeyB64!,
      privateKey: this.privateKeyB64!,
    };
  }

  async listRooms(): Promise<RoomInfo[]> {
    const res = await fetch(`${this.baseUrl}/rooms`);
    if (!res.ok) throw new Error(`Failed to list rooms: ${res.status}`);
    return res.json();
  }

  async createRoom(title: string, topic?: string, quorum?: number, speakerLimit?: number): Promise<RoomInfo> {
    const res = await fetch(`${this.baseUrl}/rooms`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, topic, ...(quorum && { quorum }), ...(speakerLimit != null && { speakerLimit }) }),
    });

    if (!res.ok) throw new Error(`Failed to create room: ${res.status} ${await res.text()}`);
    const room: RoomInfo = await res.json();
    this.currentRoomId = room.id;
    return room;
  }

  async joinRoom(roomId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/${roomId}/join`, {
      method: "POST",
      headers: this.authHeaders(),
    });

    if (!res.ok) throw new Error(`Failed to join room: ${res.status} ${await res.text()}`);
    this.currentRoomId = roomId;
  }

  async leaveRoom(roomId?: string): Promise<void> {
    const id = roomId ?? this.currentRoomId;
    if (!id) throw new Error("No room to leave");

    this.disconnectAudio();

    const res = await fetch(`${this.baseUrl}/rooms/${id}/leave`, {
      method: "POST",
      headers: this.authHeaders(),
    });

    if (!res.ok && res.status !== 404) throw new Error(`Failed to leave room: ${res.status}`);
    if (id === this.currentRoomId) this.currentRoomId = null;
  }

  connectAudio(
    roomId?: string,
    options?: {
      onEvent?: (event: Record<string, unknown>) => void;
    },
  ): Promise<void> {
    const id = roomId ?? this.currentRoomId;
    if (!id) throw new Error("No room to connect audio for");
    if (!this.agentId) throw new Error("Not registered");

    this.onEvent = options?.onEvent ?? null;

    this.opusEncoder = new OpusEncoder();
    this.seqNum = 0;

    return new Promise((resolve, reject) => {
      const url = `${this.wsBaseUrl}/ws/rooms/${id}/agent?${this.signQuery()}`;
      this.audioSocket = new WebSocket(url);

      this.audioSocket.on("open", () => resolve());
      this.audioSocket.on("error", (err) => reject(err));

      this.audioSocket.on("message", (data: Buffer | string) => {
        const str = data.toString();
        try {
          const event = JSON.parse(str);

          if (event.type === "udp-session") {
            this.udpToken = Buffer.from(event.token, "hex");
            this.udpHost = event.udpHost;
            this.udpPort = event.udpPort;
            if (!this.udpSocket) {
              this.udpSocket = createSocket("udp4");
            }
            return;
          }

          this.onEvent?.(event);
        } catch {}
      });

      this.audioSocket.on("close", () => {
        this.audioSocket = null;
      });
    });
  }

  sendUtteranceText(utteranceId: string, text: string): void {
    if (!this.audioSocket || this.audioSocket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.audioSocket.send(JSON.stringify({ type: "utterance_text", utteranceId, text }));
  }

  sendAudio(pcmData: Buffer): void {
    if (!this.opusEncoder || !this.udpSocket || !this.udpToken || !this.udpHost || !this.udpPort) {
      throw new Error("Audio not connected or UDP session not established");
    }

    const opusFrames = this.opusEncoder.encode(pcmData);
    for (const frame of opusFrames) {
      this.sendQueue.push(frame);
    }

    if (!this.sendTimer) {
      this.startSendLoop();
    }
  }

  flushAudio(): void {
    if (!this.opusEncoder) return;
    const frames = this.opusEncoder.flush();
    for (const frame of frames) {
      this.sendQueue.push(frame);
    }
    if (this.sendQueue.length > 0 && !this.sendTimer) {
      this.startSendLoop();
    }
  }

  clearSendQueue(): void {
    this.sendQueue.length = 0;
    this.opusEncoder?.reset();
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    this.notifyDrain();
  }

  drainAudio(): Promise<void> {
    if (this.sendQueue.length === 0 && !this.sendTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private startSendLoop(): void {
    this.sendNextFrame();

    if (this.sendQueue.length === 0) {
      this.notifyDrain();
      return;
    }

    this.sendTimer = setInterval(() => {
      this.sendNextFrame();
      if (this.sendQueue.length === 0) {
        clearInterval(this.sendTimer!);
        this.sendTimer = null;
        this.notifyDrain();
      }
    }, 20);
  }

  private sendNextFrame(): void {
    const frame = this.sendQueue.shift();
    if (!frame || !this.udpSocket || !this.udpToken || !this.udpHost || !this.udpPort) return;

    const seqBuf = Buffer.alloc(2);
    seqBuf.writeUInt16BE(this.seqNum & 0xffff, 0);
    this.seqNum = (this.seqNum + 1) & 0xffff;

    const packet = Buffer.concat([this.udpToken, seqBuf, frame]);
    this.udpSocket.send(packet, this.udpPort, this.udpHost);
  }

  private notifyDrain(): void {
    const resolvers = this.drainResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async requestMic(roomId?: string): Promise<{ ok: boolean; position?: number; error?: string }> {
    const id = roomId ?? this.currentRoomId;
    if (!id) throw new Error("No room");

    const res = await fetch(`${this.baseUrl}/rooms/${id}/mic/request`, {
      method: "POST",
      headers: this.authHeaders(),
    });

    return res.json();
  }

  async releaseMic(roomId?: string): Promise<{ ok: boolean; error?: string }> {
    const id = roomId ?? this.currentRoomId;
    if (!id) throw new Error("No room");

    const res = await fetch(`${this.baseUrl}/rooms/${id}/mic/release`, {
      method: "POST",
      headers: this.authHeaders(),
    });

    return res.json();
  }

  disconnectAudio(): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    this.sendQueue.length = 0;
    this.notifyDrain();
    if (this.audioSocket) {
      this.audioSocket.close();
      this.audioSocket = null;
    }
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    this.udpToken = null;
    this.udpHost = null;
    this.udpPort = null;
    if (this.opusEncoder) {
      this.opusEncoder.destroy();
      this.opusEncoder = null;
    }
  }

  get currentAgentId(): string | null {
    return this.agentId;
  }

  get currentRoom(): string | null {
    return this.currentRoomId;
  }

  clearRoom(): void {
    this.disconnectAudio();
    this.currentRoomId = null;
  }
}
