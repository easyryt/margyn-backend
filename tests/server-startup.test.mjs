import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startTestBackend } from "./support/runtime.mjs";
import { serverAddress } from "../src/services/server-address.mjs";
const directory = fileURLToPath(new URL("../", import.meta.url));
function launch(port, environment = {}) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: directory,
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", RENDER: "", PORT: String(port), HOST: "127.0.0.1", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  return { child, exited, get output() { return output; } };
}
async function exitWithin(run) {
  let timeout;
  try {
    return await Promise.race([
      run.exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Server did not exit: " + run.output)), 20000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
async function freePort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
test("listen address supports Render, production containers and local development", () => {
  assert.deepEqual(serverAddress({}), { host: "127.0.0.1", port: 4000 });
  assert.deepEqual(serverAddress({ NODE_ENV: "production" }), { host: "0.0.0.0", port: 4000 });
  assert.deepEqual(serverAddress({ NODE_ENV: "production", HOST: "127.0.0.1", PORT: "4321" }), { host: "127.0.0.1", port: 4321 });
  assert.deepEqual(serverAddress({ RENDER: "true" }), { host: "0.0.0.0", port: 10000 });
  assert.deepEqual(serverAddress({ RENDER: "true", HOST: "127.0.0.1", PORT: "10001" }), { host: "0.0.0.0", port: 10001 });
  assert.deepEqual(serverAddress({ RENDER: "false", HOST: "localhost" }), { host: "localhost", port: 4000 });
  for (const port of ["0", "65536", "not-a-port", "1.5"])
    assert.throws(() => serverAddress({ PORT: port }), /PORT must be between 1 and 65535/);
});
test("backend startup reports readiness only after binding and explains occupied ports", { timeout: 120000 }, async t => {
  const backend = await startTestBackend();
  t.after(() => backend.close());
  await t.test("an occupied port exits with an actionable message and no ready message", async () => {
    const run = launch(Number(new URL(backend.url).port));
    try {
      assert.equal(await exitWithin(run), 1);
      assert.match(run.output, /already in use \(EADDRINUSE\)/);
      assert.match(run.output, /Stop the other backend instance/);
      assert.doesNotMatch(run.output, /Margyn Express API ready/);
    } finally { if (run.child.exitCode === null) run.child.kill(); }
  });
  await t.test("an available port starts a working API and then reports ready", async () => {
    const port = await freePort();
    const run = launch(port);
    try {
      const deadline = Date.now() + 20000;
      while (!run.output.includes("Margyn Express API ready") && Date.now() < deadline) {
        assert.equal(run.child.exitCode, null, run.output);
        await delay(100);
      }
      assert.match(run.output, new RegExp("Margyn Express API ready at http://127.0.0.1:" + port));
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).service, "margyn-api");
      assert.doesNotMatch(run.output, /Cannot start Margyn API/);
    } finally {
      if (run.child.exitCode === null) run.child.kill();
      await exitWithin(run);
    }
  });
  await t.test("Render binds all interfaces and uses its assigned port despite a local HOST setting", async () => {
    const port = await freePort();
    const run = launch(port, { RENDER: "true", HOST: "127.0.0.1" });
    try {
      const deadline = Date.now() + 20000;
      while (!run.output.includes("Margyn Express API ready") && Date.now() < deadline) {
        assert.equal(run.child.exitCode, null, run.output);
        await delay(100);
      }
      assert.match(run.output, new RegExp("Margyn Express API ready at http://0\\.0\\.0\\.0:" + port));
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { service: "margyn-api", status: "ok" });
    } finally {
      if (run.child.exitCode === null) run.child.kill();
      await exitWithin(run);
    }
  });
});
