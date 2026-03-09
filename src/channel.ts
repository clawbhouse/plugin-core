import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import type { ClawbhouseToolHandlerBase, RoomNotification } from "./tool-handler-base.js";

const DEBOUNCE_MS = 2_000;
const CHANNEL_ID = "clawbhouse";

interface ChannelRuntime {
  reply: {
    finalizeInboundContext(ctx: Record<string, unknown>): Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher(opts: {
      ctx: Record<string, unknown>;
      cfg: Record<string, unknown>;
      dispatcherOptions: {
        deliver: (payload: { text?: string }, info: { kind: string }) => Promise<void>;
        onError?: (err: unknown, info: { kind: string }) => void;
      };
    }): Promise<unknown>;
  };
  routing: {
    resolveAgentRoute(input: Record<string, unknown>): { sessionKey: string; agentId: string; accountId: string };
  };
  session: {
    recordInboundSession(opts: Record<string, unknown>): Promise<void>;
  };
}

interface MonitorOptions {
  handler: ClawbhouseToolHandlerBase;
  channelRuntime: ChannelRuntime;
  cfg: Record<string, unknown>;
  abortSignal: AbortSignal;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export async function monitorClawbhouseRoom(opts: MonitorOptions): Promise<void> {
  const { handler, channelRuntime, cfg, abortSignal, log } = opts;

  let pending: RoomNotification[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    debounceTimer = null;
    if (pending.length === 0) return;

    const batch = pending.splice(0);
    const body = batch.map((n) => n.message).join("\n");

    try {
      const config = await loadConfig();
      const agentId = config?.agentId ?? "unknown";

      const route = channelRuntime.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId: "default",
        peer: { recipient: `${CHANNEL_ID}:room` },
      });

      const ctx = channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: body,
        RawBody: body,
        CommandBody: body,
        From: `${CHANNEL_ID}:room`,
        To: `${CHANNEL_ID}:${agentId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "group",
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        SenderId: "room",
        CommandAuthorized: false,
        MessageSid: randomUUID(),
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: `${CHANNEL_ID}:${agentId}`,
      });

      await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          deliver: async () => {},
          onError: (err, info) => {
            log?.error(`[clawbhouse] dispatch ${info.kind} error: ${String(err)}`);
          },
        },
      });
    } catch (err) {
      log?.error(`[clawbhouse] failed to dispatch room event: ${String(err)}`);
    }
  };

  const onNotification = (notification: RoomNotification) => {
    pending.push(notification);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  handler.setNotificationSink(onNotification);
  log?.info("[clawbhouse] channel monitor started — listening for room events");

  await new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  handler.setNotificationSink(null);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pending.length > 0) {
    await flush();
  }

  log?.info("[clawbhouse] channel monitor stopped");
}

type RegisterChannelFn = (registration: { plugin: unknown }) => void;

export function registerClawbhouseChannel(
  registerChannel: RegisterChannelFn,
  handler: ClawbhouseToolHandlerBase,
): void {
  const channel = createClawbhouseChannel(handler);
  registerChannel({ plugin: channel });
}

export function createClawbhouseChannel(handler: ClawbhouseToolHandlerBase) {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Clawbhouse",
      selectionLabel: "Clawbhouse (Voice Rooms)",
      blurb: "Real-time voice chatroom events for AI agents.",
      aliases: ["clawbhouse"],
    },
    capabilities: { chatTypes: ["group" as const] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", enabled: true }),
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async () => ({ ok: true as const }),
    },
    gateway: {
      startAccount: async (ctx: {
        cfg: Record<string, unknown>;
        accountId: string;
        abortSignal: AbortSignal;
        log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
        channelRuntime?: ChannelRuntime;
        setStatus: (status: Record<string, unknown>) => void;
      }) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn("[clawbhouse] channelRuntime not available — channel monitor disabled");
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        ctx.setStatus({ accountId: ctx.accountId, running: true });

        return monitorClawbhouseRoom({
          handler,
          channelRuntime: ctx.channelRuntime,
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      },
    },
  };
}
