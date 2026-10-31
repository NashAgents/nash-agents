import type { WebConversationRecord } from "./cluster-store-types.js";

/** Merge only changes since the caller's read, preserving concurrent messages and titles. */
export class ConversationSnapshots {
  private readonly originals = new WeakMap<WebConversationRecord, WebConversationRecord>();

  read(record: WebConversationRecord): WebConversationRecord {
    const copy = structuredClone(record);
    this.remember(copy);
    return copy;
  }

  remember(record: WebConversationRecord): void {
    this.originals.set(record, structuredClone(record));
  }

  merge(input: WebConversationRecord, current: WebConversationRecord | null): WebConversationRecord {
    if (!current) return structuredClone(input);
    const original = this.originals.get(input);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const mergeItems = <T>(before: T[], after: T[], latest: T[], key: (item: T) => string): T[] => {
      const baseline = new Map(before.map(item => [key(item), item]));
      const incoming = new Map(after.map(item => [key(item), item]));
      const result = new Map(latest.map(item => [key(item), item]));
      for (const [id, item] of baseline) {
        if (!incoming.has(id) && same(result.get(id), item)) result.delete(id);
      }
      for (const [id, item] of incoming) {
        if (!same(baseline.get(id), item)) result.set(id, item);
      }
      // Keep explicit insertion points (including legacy repairs), without sorting
      // old timestamps across user-turn boundaries or losing concurrent appends.
      const order = latest.map(key).filter(id => result.has(id));
      const orderedIds = new Set(order);
      const incomingOrder = after.map(key);
      for (let index = 0; index < incomingOrder.length; index++) {
        const id = incomingOrder[index]!;
        if (orderedIds.has(id)) continue;
        const next = incomingOrder.slice(index + 1).find(candidate => orderedIds.has(candidate));
        if (next === undefined) order.push(id);
        else order.splice(order.indexOf(next), 0, id);
        orderedIds.add(id);
      }
      return order.map(id => result.get(id)!);
    };
    const titleChanged = !original || input.title !== original.title || input.titleSource !== original.titleSource;
    const acceptTitle = titleChanged && (input.titleRevision ?? 0) >= (current.titleRevision ?? 0)
      && (current.titleSource !== "user_defined" || input.titleSource === "user_defined");
    return structuredClone({ ...current,
      ...(acceptTitle ? { title: input.title, titleSource: input.titleSource, titleRevision: input.titleRevision } : {}),
      messages: mergeItems(original?.messages ?? [], input.messages, current.messages, message => message.id),
      linkedTaskIds: mergeItems(original?.linkedTaskIds ?? [], input.linkedTaskIds ?? [], current.linkedTaskIds ?? [], id => id),
      linkedGraphIds: mergeItems(original?.linkedGraphIds ?? [], input.linkedGraphIds ?? [], current.linkedGraphIds ?? [], id => id),
      updatedAt: Math.max(current.updatedAt, input.updatedAt),
    });
  }
}
