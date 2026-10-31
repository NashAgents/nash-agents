import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ProductStore, productHome } from "./store.js";
import type { ResolvedModel } from "./types.js";

export interface ProductModelContext { main: ResolvedModel; security: ResolvedModel; version: number; effectivePolicy?: import("./types.js").ProductInitInput["security"] }
export class ProductModelContextStorage {
  private readonly context = new AsyncLocalStorage<ProductModelContext>();
  get(): ProductModelContext | undefined { return this.context.getStore(); }
  run<T>(context: ProductModelContext, run: () => T): T {
    const snapshot = structuredClone(context);
    for (const model of [snapshot.main, snapshot.security]) { if (model.headers) Object.freeze(model.headers); Object.freeze(model); }
    if (snapshot.effectivePolicy) Object.freeze(snapshot.effectivePolicy);
    return this.context.run(Object.freeze(snapshot), run);
  }
}
// Only async request context is shared, like TraceContext; configuration and services are injected per instance.
const requestContext = new ProductModelContextStorage();
export const currentModelContext = (storage: ProductModelContextStorage = requestContext): ProductModelContext | undefined => storage.get();
export function withProductModels<T>(context: ProductModelContext, run: () => T, storage: ProductModelContextStorage = requestContext): T { return storage.run(context, run); }
export function readProductModels(homeDir = productHome(), nodeId?: string): ProductModelContext | undefined {
  if (!fs.existsSync(path.join(homeDir, "product.db"))) return undefined;
  const store = new ProductStore({ homeDir });
  try {
    if (!store.isInitialized()) return undefined;
    const main = store.resolveModel({ purpose: "main", nodeId }), security = store.resolveModel({ purpose: "security", nodeId, version: main.configurationVersion });
    return { main, security, version: main.configurationVersion };
  } finally { store.close(); }
}
