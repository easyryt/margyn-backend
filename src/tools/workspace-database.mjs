import mongoose from "mongoose";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { AppError } from "../services/errors.mjs";

// Tool models share the configured Margyn database, while each account gets its
// own collections and model registry. Original schemas and processing stay intact.
export function createWorkspaceDatabase({ namespace, label, normalizeUpdate }) {
  const scope = new AsyncLocalStorage();
  const registry = new Map();
  const definitions = new Map();
  const workspaces = new Map();
  const base = new mongoose.Mongoose();
  base.set("strictQuery", true);
  let opening;
  let connection;

  function active() {
    const context = scope.getStore();
    if (!context) throw new AppError(`A signed-in ${label} workspace is required.`, 401);
    return context;
  }
  function collectionName(name, prefix) {
    if (typeof name !== "string") throw new AppError("Invalid tool collection.");
    if (name.startsWith(prefix)) return name;
    if (![...definitions.values()].some(definition => definition.collection === name)) {
      throw new AppError("This collection is outside your tool workspace.", 403);
    }
    return prefix + name;
  }
  function scopePipeline(pipeline, prefix) {
    for (const stage of pipeline) {
      if (stage.$lookup) {
        if (stage.$lookup.from) stage.$lookup.from = collectionName(stage.$lookup.from, prefix);
        if (stage.$lookup.pipeline) scopePipeline(stage.$lookup.pipeline, prefix);
      }
      if (stage.$graphLookup) stage.$graphLookup.from = collectionName(stage.$graphLookup.from, prefix);
      if (stage.$facet) for (const nested of Object.values(stage.$facet)) scopePipeline(nested, prefix);
      if (stage.$unionWith) {
        if (typeof stage.$unionWith === "string") stage.$unionWith = collectionName(stage.$unionWith, prefix);
        else {
          stage.$unionWith.coll = collectionName(stage.$unionWith.coll, prefix);
          if (stage.$unionWith.pipeline) scopePipeline(stage.$unionWith.pipeline, prefix);
        }
      }
      // Tool reports only read data. Do not permit aggregate writes to another collection.
      if (stage.$out || stage.$merge) throw new AppError("Aggregate writes are unavailable in this workspace.", 403);
    }
  }
  function tenantModel(name) {
    const { connection: conn, prefix } = active();
    if (conn.models[name]) return conn.models[name];
    const { schema, collection } = definitions.get(name);
    const scopedSchema = schema.clone();
    scopedSchema.pre("aggregate", function () { scopePipeline(this.pipeline(), prefix); });
    return conn.model(name, scopedSchema, prefix + collection);
  }
  function model(name, schema, collection) {
    if (registry.has(name)) return registry.get(name);
    const original = base.model(name, schema, collection);
    definitions.set(name, { schema, collection: original.collection.name });
    const proxy = new Proxy(original, {
      get(target, key) {
        if (["schema", "modelName", "base", "prototype"].includes(key)) return Reflect.get(target, key);
        if (key === "then") return undefined;
        if (typeof key === "symbol") return Reflect.get(target, key);
        const scoped = tenantModel(name);
        const value = Reflect.get(scoped, key);
        if (normalizeUpdate && key === "findOneAndUpdate") {
          return (filter, update, options) => value.call(scoped, filter, normalizeUpdate(name, update), options);
        }
        return typeof value === "function" ? value.bind(scoped) : value;
      },
      construct(_target, args) { return Reflect.construct(tenantModel(name), args); },
    });
    registry.set(name, proxy);
    return proxy;
  }
  const contextual = new Proxy(base, {
    get(target, key) {
      if (key === "models") return Object.fromEntries(registry);
      if (key === "model") return model;
      if (key === "connection") return scope.getStore()?.connection || target.connection;
      if (key === "startSession") return (...args) => active().connection.startSession(...args);
      const value = Reflect.get(target, key);
      return typeof value === "function" && !["Schema", "Types", "Mongoose"].includes(key) ? value.bind(target) : value;
    },
  });
  async function open() {
    if (!opening) {
      if (!process.env.MONGODB_URI) throw new AppError("MongoDB is not configured.", 503);
      const pending = base.createConnection(process.env.MONGODB_URI, {
        dbName: process.env.MONGODB_DB || "margyn_marketplace",
        maxPoolSize: 10, minPoolSize: 0, serverSelectionTimeoutMS: 10000, family: 4,
      });
      connection = pending;
      opening = pending.asPromise().catch(async () => {
        opening = null;
        await pending.close().catch(() => {});
        throw new AppError(`The ${label} database is unavailable. Check the backend MongoDB configuration.`, 503);
      });
    }
    return opening;
  }
  async function run(userId, operation, initialize) {
    if (typeof userId !== "string" || !userId) throw new AppError(`Sign in to use the ${label} workspace.`, 401);
    const root = await open();
    const key = createHash("sha256").update(userId).digest("hex").slice(0, 24);
    let workspace = workspaces.get(key);
    if (!workspace) {
      // Separate model registries use the same physical database and connection pool.
      workspace = { connection: root.useDb(root.name, { useCache: false }), prefix: `${namespace}_${key}_`, userId, ready: null };
      workspaces.set(key, workspace);
    }
    return scope.run(workspace, async () => {
      if (!workspace.ready) {
        workspace.ready = Promise.all([...definitions.keys()].map(name => tenantModel(name).init())).then(() => initialize?.());
        workspace.ready.catch(() => { workspace.ready = null; });
      }
      await workspace.ready;
      return operation();
    });
  }
  async function close() {
    workspaces.clear();
    if (opening) await opening.catch(() => {});
    await connection?.close();
    opening = null;
    connection = null;
  }
  return { mongoose: contextual, run, close, userId: () => active().userId };
}
