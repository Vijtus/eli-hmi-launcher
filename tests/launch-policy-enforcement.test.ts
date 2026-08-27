import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EntryLaunchGate,
  LaunchPolicyError,
  describeUnperformedLaunch,
  runWithLaunchPolicy,
} from "../src/main/launch/access.ts";
import type { LaunchAccessPolicy } from "../src/shared/types.ts";

const SINGLETON: LaunchAccessPolicy = {
  maxInstances: 1,
  writeModeExclusive: false,
  launchMode: "unknown",
  onAlreadyRunning: "block",
  onUnknownState: "block",
};

const RUNNING = [{ state: "running" as const, launchMode: "read" as const }];

test("blocked policy never invokes the launch callback", async () => {
  let launches = 0;
  await assert.rejects(
    runWithLaunchPolicy(
      { entryId: "gui", policy: SINGLETON, instances: RUNNING },
      async () => {
        launches += 1;
        return "launched";
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LaunchPolicyError);
      assert.match(error.message, /maxInstances is 1/);
      return true;
    },
  );
  assert.equal(launches, 0);
});

test("prompt policy launches only after an explicit main-process confirmation", async () => {
  const promptPolicy = { ...SINGLETON, onAlreadyRunning: "prompt" as const };
  let launches = 0;
  let prompts = 0;

  await assert.rejects(
    runWithLaunchPolicy(
      { entryId: "gui", policy: promptPolicy, instances: RUNNING },
      async () => {
        launches += 1;
      },
      {
        confirmOverride: async (reason) => {
          prompts += 1;
          assert.match(reason, /already has 1 running instance/);
          return false;
        },
      },
    ),
    /Operator override was not granted/,
  );
  assert.equal(launches, 0);

  const result = await runWithLaunchPolicy(
    { entryId: "gui", policy: promptPolicy, instances: RUNNING },
    async () => {
      launches += 1;
      return 42;
    },
    { confirmOverride: async () => true },
  );
  assert.equal(result.value, 42);
  assert.equal(result.launched, true);
  assert.equal(launches, 1);
  assert.equal(prompts, 1);
});

test("focus policy refuses to pretend it focused a process without a native window identity", async () => {
  const focusPolicy = { ...SINGLETON, onAlreadyRunning: "focus" as const };
  await assert.rejects(
    runWithLaunchPolicy(
      { entryId: "gui", policy: focusPolicy, instances: RUNNING },
      async () => "not reached",
    ),
    /no focusable native window identity is available/,
  );
});

test("same-entry launch gate serializes policy evaluation and launch", async () => {
  const gate = new EntryLaunchGate();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = gate.run("gui", async () => {
    order.push("first-start");
    await firstMayFinish;
    order.push("first-end");
    return 1;
  });
  const second = gate.run("gui", async () => {
    order.push("second-start");
    return 2;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  assert.ok(releaseFirst);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("different entry ids are not serialized behind each other", async () => {
  const gate = new EntryLaunchGate();
  const started: string[] = [];
  let release: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const one = gate.run("one", async () => {
    started.push("one");
    await hold;
  });
  const two = gate.run("two", async () => {
    started.push("two");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["one", "two"]);
  release?.();
  await Promise.all([one, two]);
});

test("policy enforcement is in the main-process launch boundary and absent from renderer", async () => {
  const launcher = await readFile(new URL("../src/main/launch/index.ts", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  const policyCall = launcher.indexOf("runWithLaunchPolicy(");
  const launchCall = launcher.indexOf("launchTarget(", policyCall);

  assert.ok(policyCall >= 0, "launch orchestration must enforce access policy");
  assert.ok(launchCall > policyCall, "policy must run before target launch");
  assert.doesNotMatch(renderer, /runWithLaunchPolicy|LaunchAccessPolicy|maxInstances/);
});

// Policy outcomes that do not spawn a process must not be reported as launches.
test("a focused outcome is described as an unperformed launch", () => {
  const reason = describeUnperformedLaunch("camera-manager-alena", {
    launched: false,
    focused: true,
  });
  assert.ok(reason, "a non-launching outcome must produce a reason");
  assert.match(reason, /camera-manager-alena/);
  assert.match(reason, /No process was launched/);
  assert.match(reason, /native window identity/);
});

test("a non-launching, non-focusing outcome still reports no launch", () => {
  const reason = describeUnperformedLaunch("l4-cis-vcs", {
    launched: false,
    focused: false,
  });
  assert.ok(reason);
  assert.match(reason, /did not perform a launch/);
});

test("an actual launch is not described as unperformed", () => {
  assert.equal(
    describeUnperformedLaunch("l4-cis-vcs", { launched: true, focused: false }),
    undefined,
  );
});

test("launch orchestration reports a non-launching policy outcome before logging a launch", async () => {
  const source = await readFile(new URL("../src/main/launch/index.ts", import.meta.url), "utf8");
  const guardIndex = source.indexOf("describeUnperformedLaunch(itemId, policyResult)");
  const logIndex = source.indexOf("logLaunch({", guardIndex);
  assert.ok(guardIndex > 0, "main must consult describeUnperformedLaunch");
  assert.ok(logIndex > 0, "launch orchestration must still log successful launches");
  assert.ok(guardIndex < logIndex, "the guard must precede the success log");
});
