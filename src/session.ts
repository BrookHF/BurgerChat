import { DurableObject } from "cloudflare:workers";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  defineDocFamily,
  type EntryId,
  Harness,
  InboxDoc,
  type TaskGraph,
  type TaskId,
  type Wake,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { normalizeUsername } from "./identity.ts";
import { authenticatedEmail } from "./auth.ts";
import { SessionRegistry } from "./registry.ts";
import { createChatHarnessOptions } from "./chat.ts";
import {
  InvalidClientCommand,
  MAX_CLIENT_FRAME_CHARACTERS,
  parseClientCommand,
  type ClientCommand,
  type ConversationSummary,
  queuedInputs,
  userInputText,
  type ServerEvent,
  type SessionSummary,
} from "./protocol.ts";
import { KeyedSerialQueue } from "./serial.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

/** While work can run, the alarm stays this far ahead, so an evicted instance is woken to resume it. */
const HEARTBEAT_MS = 60_000;
const CONVERSATION_PAGE_SIZE = 100;
/** The URL route the Worker forwards a session WebSocket open to. */
const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;
/** How much of the first prompt a session list shows. */
const MAX_TITLE_CHARACTERS = 80;

type ConversationCommandReceipt =
  | {
      command: "conversation.create";
      conversationId: ConversationId;
    }
  | {
      command: "conversation.fork";
      conversationId: ConversationId;
      parentConversationId: ConversationId;
      entryId: EntryId;
    };

const ConversationCommandReceipts = defineDocFamily<
  {
    receipt?: ConversationCommandReceipt;
  },
  null
>({
  family: true,
  kind: "app.conversation-command-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Written once per request ID, so there is no delta history to bound.
  checkpointWhen: () => false,
});

type SessionConnectionState = {
  readonly username: string;
  readonly conversationId?: number;
  readonly typing?: true;
};

type LegacyPartyServerAttachment = {
  readonly __user?: unknown;
};

type WSMessage = string | ArrayBuffer;

const isSessionConnectionState = (value: unknown): value is SessionConnectionState => {
  if (typeof value !== "object" || value === null || !("username" in value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.username === "string" &&
    (state.conversationId === undefined ||
      (typeof state.conversationId === "number" &&
        Number.isSafeInteger(state.conversationId) &&
        state.conversationId > 0)) &&
    (state.typing === undefined || state.typing === true)
  );
};

const connectionState = (socket: WebSocket): SessionConnectionState | null => {
  const attachment: unknown = socket.deserializeAttachment();
  // Hibernated sockets can survive a deployment from the former PartyServer implementation.
  if (isSessionConnectionState(attachment)) return attachment;
  if (typeof attachment !== "object" || attachment === null || !("__user" in attachment)) {
    return null;
  }
  const legacy = attachment as LegacyPartyServerAttachment;
  return isSessionConnectionState(legacy.__user) ? legacy.__user : null;
};

const setConnectionState = (socket: WebSocket, state: SessionConnectionState): void => {
  socket.serializeAttachment(state);
};

const usernameForConnection = (connectionId: string, request: Request): string => {
  const requested = new URL(request.url).searchParams.get("username") ?? "";
  const username = normalizeUsername(requested);
  if (username.length > 0) return username;
  const suffix = connectionId.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "guest";
  return `Guest-${suffix}`;
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const attributedPrompt = (username: string, content: string): string => `[${username}]\n${content}`;

const conversationSummary = (conversation: ConversationRecord): ConversationSummary => ({
  id: conversation.id,
  ...(conversation.parent === undefined
    ? {}
    : {
        parent: {
          conversationId: conversation.parent.conversationId,
          at: conversation.parent.at,
        },
      }),
  ...(conversation.owner === undefined
    ? {}
    : { owner: { conversationId: conversation.owner.conversationId } }),
});

export class Session extends DurableObject<Env> {
  #harness!: Harness;
  #activity!: AttachedReplicatedState<TaskGraph>;
  readonly #eventStreams = new Map<WebSocket, AgentEventStream>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #connectionOperations = new KeyedSerialQueue<WebSocket>();
  #alarmWrites: Promise<void> = Promise.resolve();
  /** Whether this instance's name is already in the shared registry. One record per instance is enough. */
  #registryRecorded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    // A fallback before anything can throw: an object whose open or recovery fails is started again.
    const fallback = Date.now() + HEARTBEAT_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback);

    // Record the session id outside the harness, so a list request can find this object later.
    // The key names the registry; `id` lets a reader verify the row belongs to this object.
    await this.ctx.storage.put("session-registry", { id: this.ctx.id.toString() });

    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      {
        ...createChatHarnessOptions(this.env),
        // `info.type` says what happened, e.g. `task_faulted` or `task_parked`, with the task and extension.
        onReport: (error, info) => reportError("Harness reported a failure", error, { ...info }),
        // Called after open and whenever the next wake changes. With `onWake`, the Harness keeps no timer for
        // sleeps: the alarm calls `resume()`. A failed alarm write resets the object; it arms again on restart.
        onWake: (wake) => void this.#arm(wake).catch(() => this.ctx.abort("Alarm write failed")),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("Harness failed");
    });

    let activity: AttachedReplicatedState<TaskGraph> | undefined;
    try {
      this.#harness = harness;
      activity = await harness.taskGraph(BACKGROUND_CONTEXT);
      this.#activity = activity;
      activity.subscribe((value, _context, delivery) => {
        if (delivery.kind === "update")
          this.#broadcast({ type: "session.activity", activity: value });
      });
      // Subagents are created by background tool tasks, not client commands.
      // Notify connected clients when their conversation records are committed.
      harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type !== "conversation" || change.value.owner === undefined) continue;
          this.#broadcast({
            type: "conversation.created",
            conversation: conversationSummary(change.value),
          });
        }
      });
      await this.#restoreEventStreams();
      // Armed before `resume()` runs anything, as for any call that can start work.
      await this.#arm(harness.wake());
      // Continue work a lost instance left, and make due sleeps runnable.
      harness.resume();
    } catch (error) {
      activity?.dispose();
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    // A plain HTTP read of this object answers with its session summary, so the landing page can list sessions.
    if (new URL(request.url).pathname === "/api/session") {
      return json(await this.#sessionSummary(), 200);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }

    // A session opened by URL (or created before the registry existed) is added here, so visiting it
    // makes it appear in the list. The registry stores the name this object was opened with, because
    // the list reads sessions back with `getByName`, which maps a name, not an instance id.
    const openMatch = sessionSocketRoute.exec(new URL(request.url).pathname);
    if (openMatch !== null && !this.#registryRecorded) {
      await this.#registerSession(openMatch[1], authenticatedEmail(request));
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    setConnectionState(server, { username: usernameForConnection(connectionId, request) });
    try {
      await this.#connect(server);
    } catch (error) {
      reportError("Session WebSocket connection failed", error);
      try {
        server.close(1011, "Session setup failed");
      } catch {
        // The accepted socket may already have closed while setup was running.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    // Armed before `resume()` can start work, as on open.
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    // Alarms are at-least-once, and `onWake` repeats no unchanged wake: an early or spurious alarm would otherwise
    // leave the heartbeat armed with nothing to do. `wake()` already counts the work `resume()` made runnable.
    await this.#arm(this.#harness.wake());
  }

  override async webSocketMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, () => this.#processMessage(socket, message));
    } catch (error) {
      reportError("Session WebSocket message failed", error);
    }
  }

  async #processMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_message", message: "Binary messages are not supported" },
      });
      socket.close(1002, "Binary protocol frame");
      return;
    }

    if (message.length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.#send(socket, {
        type: "error",
        error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
      });
      socket.close(1009, "Command frame too large");
      return;
    }

    let command: ClientCommand;
    try {
      command = parseClientCommand(message);
    } catch (error) {
      if (!(error instanceof InvalidClientCommand)) throw error;
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_command", message: error.message },
      });
      socket.close(1002, "Invalid command frame");
      return;
    }

    try {
      await this.#handleCommand(socket, command);
    } catch (error) {
      reportError("Session command failed", error, { command: command.type });
      if (command.type === "presence.typing") return;
      this.#send(socket, {
        type: "command.result",
        command: command.type,
        requestId: command.requestId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : "Command failed",
        },
      });
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        this.#setTyping(socket, false);
        await this.#stopEventStream(socket);
      });
    } catch (error) {
      reportError("Session WebSocket close failed", error);
    } finally {
      reciprocateClose(socket, code, reason);
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        reportError("Session WebSocket failed", error);
        this.#setTyping(socket, false);
        await this.#stopEventStream(socket);
      });
    } catch (handlerError) {
      reportError("Session WebSocket error cleanup failed", handlerError);
    }
  }

  /** Tell the registry this session's name and owner. A failed record is retried on the next open. */
  async #registerSession(name: string, owner: string | undefined): Promise<void> {
    try {
      const registry = this.env.SESSION_REGISTRY.get(
        this.env.SESSION_REGISTRY.idFromName(SessionRegistry.NAME),
      );
      const response = await registry.fetch(
        new Request("https://internal/api/session-registry", {
          method: "POST",
          body: JSON.stringify({ sessionId: name, ...(owner === undefined ? {} : { owner }) }),
        }),
      );
      if (response.ok) this.#registryRecorded = true;
      else reportError("Session registry record failed", `registry answered ${response.status}`);
    } catch (error) {
      reportError("Session registry record failed", error, { name });
    }
  }

  async #connect(server: WebSocket): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
  }

  async #handleCommand(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "presence.typing":
        if (connectionState(socket)?.conversationId === command.conversationId) {
          this.#setTyping(socket, command.typing);
        }
        return;
      case "conversation.open":
        await this.#requireConversation(command.conversationId as ConversationId);
        await this.#watchConversation(socket, command.conversationId as ConversationId);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      case "conversation.create": {
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type) {
              throw new Error(
                `Request ${command.requestId} was already used for ${existing.command}`,
              );
            }
            return existing.conversationId;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          doc.receipt = {
            command: command.type,
            conversationId: conversation.id,
          };
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "conversation.fork": {
        const parentConversationId = command.conversationId as ConversationId;
        const entryId = command.entryId as EntryId;
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (
              existing.command !== command.type ||
              existing.parentConversationId !== parentConversationId ||
              existing.entryId !== entryId
            ) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            return existing.conversationId;
          }
          const fork = await tx.forkConversation(parentConversationId, entryId, {
            ownership: { kind: "ownerless" },
          });
          doc.receipt = {
            command: command.type,
            conversationId: fork.id,
            parentConversationId,
            entryId,
          };
          return fork.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "prompt.submit": {
        this.#setTyping(socket, false);
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        // Arm before admitting work: `onWake` runs after the commit, so an instance that dies in between is
        // still woken. An early alarm is harmless; a missing one strands the turn.
        await this.#arm({ ...this.#harness.wake(), active: true });
        const submission = await conversation.submit(
          {
            type: "input",
            content: attributedPrompt(
              connectionState(socket)?.username ?? "Guest",
              command.content,
            ),
            requestId: command.requestId,
            // Queue behind a running turn instead of rejecting; the inbox places it after the current answer.
            whenBusy: "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        return;
      }
      case "task.retry":
        // Retrying a parked task starts work, so arm first. A task that is not parked is left alone, which makes a
        // replayed command harmless; an unknown task rejects.
        await this.#arm({ ...this.#harness.wake(), active: true });
        await this.#harness.retryTask(command.taskId as TaskId, BACKGROUND_CONTEXT);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
    }
  }

  async #requireConversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #sendSessionSnapshot(socket: WebSocket): Promise<void> {
    this.#send(socket, {
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
    });
  }

  async #broadcastSessionSnapshot(): Promise<void> {
    this.#broadcast({
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
    });
  }

  /** The first prompt text and the last activity time, for a session list. */
  async #sessionSummary(): Promise<SessionSummary> {
    const registry = await this.ctx.storage.get<{ id?: string }>("session-registry");
    if (registry?.id !== this.ctx.id.toString()) {
      throw new Error("Session registry does not match this object");
    }
    const conversations = await this.#sessionSnapshot();
    let title: string | undefined;
    let updatedAt = 0;
    for (const conversation of conversations) {
      // Newest entries first, so the last entry seen is the newest across the session.
      let cursor: Cursor | undefined;
      do {
        const page = await this.#harness.commit(
          async (tx) =>
            tx.scanEntries(
              { conversationId: conversation.id as ConversationId },
              CONVERSATION_PAGE_SIZE,
              cursor,
            ),
          BACKGROUND_CONTEXT,
        );
        for (const entry of page.items) {
          updatedAt = Math.max(updatedAt, entry.id);
          if (title !== undefined) continue;
          const first = entry.model?.[0];
          const text = first?.role === "user" ? userInputText(first.content) : undefined;
          if (text !== undefined && text.length > 0) title = text.slice(0, MAX_TITLE_CHARACTERS);
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    return {
      sessionId: this.ctx.id.toString(),
      conversations: conversations.length,
      updatedAt,
      title,
    };
  }

  #sessionSnapshot(): Promise<readonly ConversationSummary[]> {
    return this.#harness.commit(async (tx) => {
      const conversations: ConversationSummary[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, CONVERSATION_PAGE_SIZE, cursor);
        conversations.push(...page.items.map(conversationSummary));
        cursor = page.next;
      } while (cursor !== undefined);
      return conversations;
    }, BACKGROUND_CONTEXT);
  }

  async #watchConversation(
    socket: WebSocket,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopEventStream(socket);
    const username = connectionState(socket)?.username ?? "Guest";
    setConnectionState(socket, { username });
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    this.#eventStreams.set(socket, stream);
    setConnectionState(socket, {
      username,
      conversationId,
      ...(restoreTyping ? { typing: true } : {}),
    });
    if (restoreTyping) this.#typingConnections.add(socket);
    this.#send(socket, {
      type: "conversation.events",
      conversationId,
      events: [stream.snapshot],
    });
    await this.#sendInbox(socket, conversationId);
    stream.start(async (events) => {
      if (this.#eventStreams.get(socket) !== stream) return;
      this.#send(socket, { type: "conversation.events", conversationId, events });
      if (events.some(({ type }) => type === "inbox_update" || type === "snapshot")) {
        await this.#sendInbox(socket, conversationId);
      }
    });
    void stream.closed.finally(() => {
      if (this.#eventStreams.get(socket) === stream) this.#eventStreams.delete(socket);
    });
    this.#broadcastTyping(conversationId);
  }

  /** Inbox events carry only submission IDs; the queued text lives in the conversation's `pi.inbox` document. */
  async #sendInbox(socket: WebSocket, conversationId: ConversationId): Promise<void> {
    const inbox = await this.#harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT);
    this.#send(socket, { type: "conversation.inbox", conversationId, items: queuedInputs(inbox) });
  }

  async #stopEventStream(socket: WebSocket): Promise<void> {
    const stream = this.#eventStreams.get(socket);
    if (stream === undefined) return;
    this.#eventStreams.delete(socket);
    await stream.stop();
  }

  async #restoreEventStreams(): Promise<void> {
    for (const socket of this.#connections()) {
      const attachment = connectionState(socket);
      if (attachment?.conversationId !== undefined) {
        const conversationId = attachment.conversationId as ConversationId;
        await this.#watchConversation(socket, conversationId, attachment.typing === true);
      }
    }
  }

  #connections(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
  }

  #broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.#connections()) this.#sendMessage(socket, message);
  }

  #send(socket: WebSocket, event: ServerEvent): void {
    this.#sendMessage(socket, JSON.stringify(event));
  }

  #sendMessage(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(message);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  #setTyping(socket: WebSocket, typing: boolean): void {
    const state = connectionState(socket);
    if (state === null || state.conversationId === undefined) return;
    const conversationId = state.conversationId;
    const changed = typing
      ? !this.#typingConnections.has(socket)
      : this.#typingConnections.delete(socket);
    if (typing) this.#typingConnections.add(socket);
    if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      setConnectionState(socket, {
        username: state.username,
        conversationId,
        ...(typing ? { typing: true } : {}),
      });
    }
    if (changed) this.#broadcastTyping(conversationId as ConversationId);
  }

  #broadcastTyping(conversationId: ConversationId): void {
    const connections = this.#connections().filter(
      (connection) => connectionState(connection)?.conversationId === conversationId,
    );
    const typers = connections.filter((connection) => this.#typingConnections.has(connection));
    for (const receiver of connections) {
      const usernames = [
        ...new Set(
          typers
            .filter((connection) => connection !== receiver)
            .map((connection) => connectionState(connection)?.username)
            .filter((username): username is string => username !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.#send(receiver, { type: "presence.typing", conversationId, usernames });
    }
  }

  /** The one alarm: the earliest sleep, or a recovery heartbeat while work can run, whichever comes first. */
  #arm(wake: Wake): Promise<void> {
    // Serialized, so an older wake cannot overwrite a newer, earlier deadline.
    const write = this.#alarmWrites.then(async () => {
      const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
      // `wake.at` is on the Harness clock, which is the default `Date.now`.
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    });
    this.#alarmWrites = write.catch(() => undefined);
    return write;
  }
}
