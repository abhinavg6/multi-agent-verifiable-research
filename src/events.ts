// Per-run event bus. The orchestrator emits events; the SSE handler streams
// them to the connected browser. One bus per /api/run request. Late
// subscribers get the buffered backlog so the UI never misses an event.

import type { AgentEvent } from "./types.ts";

export class EventBus {
  private listeners = new Set<(e: AgentEvent) => void>();
  private buffer: AgentEvent[] = [];
  private closed = false;

  emit(event: AgentEvent) {
    if (this.closed) return;
    this.buffer.push(event);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    for (const event of this.buffer) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(): AgentEvent[] {
    return this.buffer.slice();
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}
