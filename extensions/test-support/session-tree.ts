/**
 * A minimal in-memory Pi session tree: entries linked by id/parentId, a
 * movable leaf, and `getBranch()` walking from the leaf to the root. Enough
 * to exercise branch-local state the way Pi's SessionManager exposes it.
 */
import { CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import type { RoutingContextEvent } from '../routing/context/types.js';

export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  message?: { role: string; content: unknown; timestamp?: number };
  provider?: string;
  modelId?: string;
}

export class SessionTree {
  private readonly entries = new Map<string, TreeEntry>();
  private leaf: string | null = null;
  private counter = 0;

  private add(entry: Omit<TreeEntry, 'id' | 'parentId' | 'timestamp'>): string {
    this.counter += 1;
    const id = `e${this.counter}`;
    this.entries.set(id, { ...entry, id, parentId: this.leaf, timestamp: new Date(this.counter * 1000).toISOString() });
    this.leaf = id;
    return id;
  }

  user(text: string, timestamp = this.counter + 1): string {
    return this.add({ type: 'message', message: { role: 'user', content: text, timestamp } });
  }

  assistant(text: string): string {
    return this.add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }

  /** A message entry of any shape; `user()` and `assistant()` cover the common ones. */
  message(message: { role: string; content: unknown; timestamp?: number }): string {
    return this.add({ type: 'message', message });
  }

  /** Pi's record of a model selection: later requests go to this model. */
  modelChange(provider: string, modelId: string): string {
    return this.add({ type: 'model_change', provider, modelId });
  }

  custom(customType: string, data: unknown): string {
    return this.add({ type: 'custom', customType, data });
  }

  event(event: RoutingContextEvent): string {
    return this.custom(CONTEXT_ENTRY_TYPE, event);
  }

  /** Move the leaf, as `/tree` does. */
  navigate(id: string | null): void {
    this.leaf = id;
  }

  getLeafId(): string | null {
    return this.leaf;
  }

  getEntry(id: string): TreeEntry | undefined {
    return this.entries.get(id);
  }

  getBranch(fromId?: string): TreeEntry[] {
    const path: TreeEntry[] = [];
    let id = fromId ?? this.leaf;
    while (id) {
      const entry = this.entries.get(id);
      if (!entry) break;
      path.unshift(entry);
      id = entry.parentId;
    }
    return path;
  }

  /** `pi.appendEntry` bound to this tree. */
  readonly appendEntry = (customType: string, data?: unknown): void => {
    this.custom(customType, data);
  };

  /** Everything a ReadonlySessionManager consumer here reads. */
  manager() {
    return {
      getBranch: (fromId?: string) => this.getBranch(fromId),
      getLeafId: () => this.getLeafId(),
      getEntry: (id: string) => this.getEntry(id),
      getSessionFile: () => undefined,
    };
  }
}
