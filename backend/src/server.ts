import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SqliteStore } from "./store/sqlite.ts";
import { MockCloud } from "./infra/mockCloud.ts";
import { EventBus } from "./events/bus.ts";
import { Engine } from "./domain/engine.ts";
import { ensureSeeded } from "./infra/seed.ts";
import { registerRoutes } from "./api/routes.ts";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

// Durable state lives next to the backend, not in the user's project root.
const dataDir = fileURLToPath(new URL("../data", import.meta.url));
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH ?? `${dataDir}/drift.db`;

const store = new SqliteStore(dbPath);
const cloud = new MockCloud(store);
const bus = new EventBus();
const engine = new Engine(store, cloud, bus);

ensureSeeded(store);
const recovered = engine.recoverOrphans();

const app = Fastify({ logger: { transport: undefined, level: "info" } });
await app.register(cors, { origin: true });
registerRoutes(app, { store, engine, cloud, bus });

try {
  await app.listen({ port: PORT, host: HOST });
  if (recovered > 0) app.log.warn(`recovered ${recovered} interrupted run(s) on boot`);
  app.log.info(`drift-detector API ready — db at ${dbPath}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
