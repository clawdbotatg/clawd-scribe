// Tests for the capture preflight + alarm (node test/test_preflight.js).
// Uses stub audiocap binaries via AUDIOCAP_BIN and an injected exec, so it
// never touches ScreenCaptureKit and never pops real dialogs.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-preflight-"));
function stubBin(name, script) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, "#!/bin/bash\n" + script);
  fs.chmodSync(p, 0o755);
  return p;
}

const HEALTHY = stubBin("healthy", "head -c 100000 /dev/zero; sleep 30");
const SILENT = stubBin("silent", 'echo \'{"event":"error","detail":"declined TCC"}\' >&2; sleep 30');
const MISSING = path.join(tmp, "does-not-exist");

async function main() {
  process.env.AUDIOCAP_BIN = HEALTHY;
  const preflight = require("../server/preflight");
  try { fs.unlinkSync(preflight.ALARM_MARKER); } catch {}

  // healthy helper → probe passes fast
  let t0 = Date.now();
  let r = await preflight.probeCapture();
  assert.strictEqual(r.ok, true, `healthy probe should pass: ${JSON.stringify(r)}`);
  assert.ok(r.bytes >= 32000, "healthy probe should count bytes");
  assert.ok(Date.now() - t0 < 3000, "healthy probe should resolve quickly");
  console.log("ok: healthy probe passes fast");

  // silent helper (wedged grant) → probe fails, carries the stderr detail
  process.env.AUDIOCAP_BIN = SILENT;
  t0 = Date.now();
  r = await preflight.probeCapture({ timeoutMs: 1500 });
  assert.strictEqual(r.ok, false, "silent probe should fail");
  assert.ok(/declined TCC/.test(r.error || ""), `should surface helper error, got: ${r.error}`);
  assert.ok(Date.now() - t0 < 3000, "silent probe should respect its timeout");
  console.log("ok: silent probe fails with the helper's error");

  // missing binary → clean failure, no throw
  process.env.AUDIOCAP_BIN = MISSING;
  r = await preflight.probeCapture({ timeoutMs: 1500 });
  assert.strictEqual(r.ok, false, "missing binary should fail cleanly");
  console.log("ok: missing binary fails cleanly");

  // alarm fires all three surfaces + honors the file-backed cooldown
  const calls = [];
  const exec = (cmd, args) => calls.push([cmd, ...args].join(" "));
  const config = { alerts: { cooldownMin: 10 } };
  assert.strictEqual(preflight.raiseAlarm(config, "test reason", exec), true, "first alarm should fire");
  assert.ok(calls.some((c) => c.includes("Privacy_ScreenCapture")), "should open the Settings pane");
  assert.ok(calls.some((c) => c.includes("display notification")), "should send a notification");
  assert.ok(calls.some((c) => c.includes("display dialog")), "should show the dialog");
  const n = calls.length;
  assert.strictEqual(preflight.raiseAlarm(config, "again", exec), false, "cooldown should suppress a repeat");
  assert.strictEqual(calls.length, n, "suppressed alarm must not exec anything");
  console.log("ok: alarm fires notification + dialog + Settings pane, then cools down");

  // cooldown survives a "daemon restart" (fresh module state, same marker file)
  delete require.cache[require.resolve("../server/preflight")];
  const preflight2 = require("../server/preflight");
  assert.strictEqual(preflight2.raiseAlarm(config, "post-restart", exec), false,
    "cooldown must survive the self-restart loop (file-backed)");
  console.log("ok: cooldown survives a daemon restart");

  // clearAlarm resets it
  preflight2.clearAlarm();
  assert.strictEqual(preflight2.raiseAlarm(config, "after heal", exec), true, "alarm re-arms after heal");
  preflight2.clearAlarm();
  console.log("ok: heal re-arms the alarm");

  // alerts.enabled=false and dialog=false are honored
  calls.length = 0;
  assert.strictEqual(preflight2.raiseAlarm({ alerts: { enabled: false } }, "off", exec), false);
  assert.strictEqual(calls.length, 0, "disabled alerts must not exec");
  preflight2.raiseAlarm({ alerts: { dialog: false, cooldownMin: 0 } }, "no dialog", exec);
  assert.ok(!calls.some((c) => c.includes("display dialog")), "dialog=false must skip the dialog");
  preflight2.clearAlarm();
  console.log("ok: alerts.enabled / alerts.dialog knobs honored");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("ALL PREFLIGHT TESTS PASSED");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
