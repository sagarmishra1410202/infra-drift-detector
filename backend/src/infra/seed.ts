import type { Resource } from "@orchestrator/shared";
import type { Store } from "../store/types.ts";

/**
 * The declared "source of truth" — what the operator wants to exist.
 */
const DESIRED: Resource[] = [
  { address: "s3_bucket.assets", type: "s3_bucket", properties: { public: false, versioning: "enabled", region: "us-east-1" } },
  { address: "s3_bucket.logs", type: "s3_bucket", properties: { public: false, versioning: "disabled", region: "us-east-1" } },
  { address: "security_group.web", type: "security_group", properties: { ingress_443: true, ingress_80: true, ingress_22: false } },
  { address: "compute_instance.api", type: "compute_instance", properties: { instance_type: "t3.medium", count: 3, region: "us-east-1" } },
  { address: "dns_record.www", type: "dns_record", properties: { kind: "A", value: "203.0.113.10", ttl: 300 } },
  { address: "iam_role.deployer", type: "iam_role", properties: { policy: "deploy-readonly", mfa_required: true } },
];

/**
 * The live cloud — deliberately divergent from desired so the very first scan
 * surfaces every drift class:
 *   - s3_bucket.assets    drifted   (went public — a real security drift)
 *   - s3_bucket.logs      in_sync
 *   - security_group.web  drifted   (SSH opened out-of-band)
 *   - compute_instance.api drifted  (resized to t3.large)
 *   - dns_record.www      missing   (deleted out-of-band)
 *   - iam_role.deployer   drifted   (MFA disabled — and PROTECTED, so reconcile fails)
 *   - security_group.legacy unmanaged (created out-of-band, never declared)
 */
const ACTUAL: Resource[] = [
  { address: "s3_bucket.assets", type: "s3_bucket", properties: { public: true, versioning: "enabled", region: "us-east-1" } },
  { address: "s3_bucket.logs", type: "s3_bucket", properties: { public: false, versioning: "disabled", region: "us-east-1" } },
  { address: "security_group.web", type: "security_group", properties: { ingress_443: true, ingress_80: true, ingress_22: true } },
  { address: "compute_instance.api", type: "compute_instance", properties: { instance_type: "t3.large", count: 3, region: "us-east-1" } },
  { address: "iam_role.deployer", type: "iam_role", properties: { policy: "deploy-readonly", mfa_required: false } },
  { address: "security_group.legacy", type: "security_group", properties: { ingress_22: true, note: "temp-debug" } },
];

/** Write the baseline desired + actual state into a (presumed empty) store. */
export function seedBaseline(store: Store): void {
  for (const r of DESIRED) store.upsertDesired(r);
  for (const r of ACTUAL) store.upsertActual(r);
}

/** Seed only if the store has no desired state yet (first boot). */
export function ensureSeeded(store: Store): void {
  if (store.listDesired().length === 0) seedBaseline(store);
}
