import type { Resource, SimulateKind } from "@orchestrator/shared";
import type { Store } from "../store/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resources the provider refuses to mutate automatically (e.g. they require a
 * manual change-ticket). Reconciling one of these fails on purpose, which is how
 * we demonstrate graceful partial-failure handling.
 */
export const PROTECTED_ADDRESSES = new Set<string>(["iam_role.deployer"]);

export class ProtectedResourceError extends Error {
  constructor(address: string) {
    super(`Resource "${address}" is protected and must be changed via a manual change ticket`);
    this.name = "ProtectedResourceError";
  }
}

/** Describes what a simulated out-of-band change did, for the activity feed. */
export interface SimulationResult {
  kind: SimulateKind;
  address: string;
  message: string;
}

/**
 * The live "cloud". It owns the actual-state side of the store and exposes
 * provider-like operations with artificial latency, so a scan/reconcile shows
 * visible per-resource progress. `simulate()` perturbs live state out-of-band —
 * the realistic way drift actually appears.
 */
export class MockCloud {
  constructor(
    private store: Store,
    private latencyMs = 350,
  ) {}

  /** Snapshot of everything currently present in the cloud. */
  list(): Resource[] {
    return this.store.listActual();
  }

  /** Simulate an API call to read one resource's live state. */
  async refresh(address: string): Promise<Resource | null> {
    await sleep(this.latencyMs);
    return this.store.getActual(address);
  }

  /** Create or update a resource (the `patch` / `recreate` remediation). */
  async apply(resource: Resource): Promise<void> {
    if (PROTECTED_ADDRESSES.has(resource.address)) {
      await sleep(this.latencyMs);
      throw new ProtectedResourceError(resource.address);
    }
    await sleep(this.latencyMs);
    this.store.upsertActual(resource);
  }

  /** Delete a resource from the cloud (the `delete` remediation for unmanaged). */
  async remove(address: string): Promise<void> {
    if (PROTECTED_ADDRESSES.has(address)) {
      await sleep(this.latencyMs);
      throw new ProtectedResourceError(address);
    }
    await sleep(this.latencyMs);
    this.store.deleteActual(address);
  }

  /**
   * Introduce out-of-band drift, the way a human or a broken automation would.
   * Returns a description of what changed so the UI can narrate it.
   */
  simulate(kind: SimulateKind): SimulationResult {
    const present = this.store.listActual();

    if (kind === "create") {
      const address = `security_group.adhoc_${Math.floor(Math.random() * 9000 + 1000)}`;
      this.store.upsertActual({
        address,
        type: "security_group",
        properties: { ingress_22: true, note: "created out-of-band" },
      });
      return { kind, address, message: `Untracked resource ${address} appeared in the cloud` };
    }

    if (kind === "delete") {
      const target = present.find((r) => !PROTECTED_ADDRESSES.has(r.address));
      if (!target) return { kind, address: "-", message: "Nothing available to delete" };
      this.store.deleteActual(target.address);
      return { kind, address: target.address, message: `${target.address} was deleted out-of-band` };
    }

    // mutate: flip or bump a property on an existing resource
    const target = present.find((r) => !PROTECTED_ADDRESSES.has(r.address));
    if (!target) return { kind, address: "-", message: "Nothing available to mutate" };
    const keys = Object.keys(target.properties);
    const key = keys[Math.floor(Math.random() * keys.length)] ?? "tampered";
    const current = target.properties[key];
    const next: Resource = {
      ...target,
      properties: {
        ...target.properties,
        [key]: typeof current === "boolean" ? !current : `${current}-tampered`,
      },
    };
    this.store.upsertActual(next);
    return {
      kind,
      address: target.address,
      message: `${target.address}.${key} was changed out-of-band`,
    };
  }
}
