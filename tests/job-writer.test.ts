import test from "node:test";
import assert from "node:assert/strict";
import { JobWriter, isProgressOnly } from "../src/lib/job-writer";

type Patch = { status?: string | null; progress?: number | null; [key: string]: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("writes are applied strictly in enqueue order", async () => {
  const seen: string[] = [];
  const writer = new JobWriter<Patch>(async (patch) => {
    await sleep(Math.random() * 5);
    seen.push(String(patch.status));
  });
  for (let i = 0; i < 50; i += 1) void writer.enqueue({ status: "downloading", progress: i });
  await writer.enqueue({ status: "completed", progress: 100 });
  await writer.flush();
  assert.equal(seen[0], "downloading");
  assert.equal(seen[seen.length - 1], "completed");
  assert.equal(seen.filter((s) => s === "completed").length, 1);
});

test("REGRESSION: fire-and-forget writes can lose the terminal state (old engine)", async () => {
  const row: { status: string } = { status: "downloading" };
  const write = async (status: string, delay: number) => {
    await sleep(delay);
    row.status = status;
  };
  // The old engine did exactly this: `void this.update(...)` for progress while
  // awaiting the completion write. The progress write lands last.
  void write("downloading", 40);
  await write("completed", 5);
  await sleep(60);
  assert.equal(row.status, "downloading", "documents the race the JobWriter fixes");
});

test("the same scenario through JobWriter ends in the terminal state", async () => {
  const row: { status: string; progress?: number } = { status: "queued" };
  const writer = new JobWriter<Patch>(async (patch) => {
    await sleep(patch.status === "completed" ? 5 : 40);
    row.status = String(patch.status);
    row.progress = Number(patch.progress ?? 0);
  });
  void writer.enqueue({ status: "downloading", progress: 99.9 });
  await writer.enqueue({ status: "completed", progress: 100 });
  await writer.flush();
  assert.equal(row.status, "completed");
  assert.equal(row.progress, 100);
});

test("progress written after a terminal state is dropped, not stored", async () => {
  const seen: Patch[] = [];
  const writer = new JobWriter<Patch>((patch) => { seen.push(patch); });
  await writer.enqueue({ status: "completed", progress: 100 });
  await writer.enqueue({ status: "downloading", progress: 12 });
  await writer.enqueue({ progress: 55 });
  await writer.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "completed");
  assert.equal(writer.isSealed, true);
});

test("a job can be re-opened for a retry after a terminal state", async () => {
  const seen: string[] = [];
  const writer = new JobWriter<Patch>((patch) => { seen.push(String(patch.status)); });
  await writer.enqueue({ status: "failed" });
  writer.reset();
  await writer.enqueue({ status: "queued" });
  await writer.flush();
  assert.deepEqual(seen, ["failed", "queued"]);
});

test("sink failures are reported once and do not break the chain", async () => {
  let errors = 0;
  const seen: string[] = [];
  let fail = true;
  const writer = new JobWriter<Patch>(
    (patch) => {
      if (fail) {
        fail = false;
        throw new Error("database is locked");
      }
      seen.push(String(patch.status));
    },
    { onError: () => { errors += 1; } },
  );
  await writer.enqueue({ status: "downloading" });
  await writer.enqueue({ status: "downloading" });
  await writer.enqueue({ status: "completed" });
  await writer.flush();
  assert.equal(errors, 1, "reported once, not silently swallowed");
  assert.deepEqual(seen, ["downloading", "completed"]);
});

test("isProgressOnly covers the statuses that must never resurrect a job", () => {
  assert.equal(isProgressOnly({}), true);
  assert.equal(isProgressOnly({ status: "downloading" }), true);
  assert.equal(isProgressOnly({ status: "converting" }), true);
  assert.equal(isProgressOnly({ status: "paused" }), true);
  assert.equal(isProgressOnly({ status: "completed" }), false);
  assert.equal(isProgressOnly({ status: "failed" }), false);
});
