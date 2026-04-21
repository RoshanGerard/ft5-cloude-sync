import { describe, expectTypeOf, it } from "vitest";

import { jobs, retryPolicies, serviceMeta, syncSnapshot } from "./schema.js";

describe("sync.db Drizzle schema — table+column exposure", () => {
  it("exports all four core tables", () => {
    expectTypeOf(serviceMeta).not.toBeNullable();
    expectTypeOf(jobs).not.toBeNullable();
    expectTypeOf(syncSnapshot).not.toBeNullable();
    expectTypeOf(retryPolicies).not.toBeNullable();
  });

  it("jobs.status is the six-value enum required by the spec", () => {
    type StatusType = typeof jobs.$inferSelect.status;
    expectTypeOf<StatusType>().toEqualTypeOf<
      | "queued"
      | "running"
      | "waiting-network"
      | "completed"
      | "failed"
      | "cancelled"
    >();
  });

  it("jobs.kind is 'upload' | 'sync'", () => {
    type KindType = typeof jobs.$inferSelect.kind;
    expectTypeOf<KindType>().toEqualTypeOf<"upload" | "sync">();
  });

  it("jobs.conflictPolicy is the three-value enum", () => {
    type CP = typeof jobs.$inferSelect.conflictPolicy;
    expectTypeOf<CP>().toEqualTypeOf<"overwrite" | "duplicate" | "skip">();
  });

  it("retryPolicies.scope is 'global' | 'datasource'", () => {
    type ScopeType = typeof retryPolicies.$inferSelect.scope;
    expectTypeOf<ScopeType>().toEqualTypeOf<"global" | "datasource">();
  });

  it("serviceMeta has schemaVersion:number and serviceUuid:string", () => {
    type Row = typeof serviceMeta.$inferSelect;
    expectTypeOf<Row["schemaVersion"]>().toEqualTypeOf<number>();
    expectTypeOf<Row["serviceUuid"]>().toEqualTypeOf<string>();
  });
});
