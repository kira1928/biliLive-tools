// Run only against an isolated copy: checkout dependencies must not hide missing files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bgo-cli-check-"));
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: temp,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, NODE_PATH: "" },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Packaged CLI check failed: ${args[0]}`);
  return result.stdout;
}
async function checkServer() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const configPath = path.join(temp, "appConfig.json");
  const config = JSON.parse(fs.readFileSync(configPath));
  Object.assign(config, {
    host: "127.0.0.1",
    port,
    configFolder: temp,
    logPath: path.join(temp, "logs"),
    autoUpdate: false,
  });
  fs.writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, ["./index.cjs", "server", "-c", "./appConfig.json"], {
    cwd: temp,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const request = (url, authenticated = false) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      signal: AbortSignal.timeout(5000),
      headers: authenticated ? { Authorization: config.passKey } : {},
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Server exited before ready: ${logs}`);
      try {
        const response = await request("/");
        assert.equal(response.status, 200, "health endpoint");
        await response.text();
        ready = true;
        break;
      } catch {}
      await delay(1000);
    }
    assert.ok(ready, `Server did not start: ${logs}`);
    const unauthenticated = await request("/bgo/live-info?platform=invalid");
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /Basic/i);
    await unauthenticated.text();
    for (const route of ["live-info", "stream-info"]) {
      const response = await request(`/bgo/${route}?platform=invalid`, true);
      assert.equal(response.status, 400, route);
      assert.deepEqual(await response.json(), { error: "Platform not supported" });
    }
    // The provider rejects this non-Douyin URL before making a network request.
    const response = await request("/bgo/channel-info?url=https%3A%2F%2Fexample.com", true);
    assert.equal(response.status, 204, "channel-info");
    await response.text();
    console.log("Isolated server startup and bgo authentication/endpoint checks passed.");
  } catch (error) {
    process.stderr.write(logs);
    throw error;
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}
try {
  fs.cpSync(path.join(root, "packages/CLI/lib"), temp, { recursive: true });
  run([
    "-e",
    `
    const assert = require('node:assert/strict');
    const Database = require('./node_modules/better-sqlite3');
    const db = new Database(':memory:');
    assert.equal(db.prepare('select 1 AS value').get().value, 1);
    db.close();
    const canvas = require('./node_modules/@napi-rs/canvas');
    assert.ok(canvas.createCanvas(2, 2).toBuffer('image/png').length > 0);
    const fonts = require('./node_modules/font-ls');
    assert.ok(Array.isArray(fonts.getAvailableFontsSync()));
    console.log('Packaged SQLite, canvas, and font-ls passed on ' + process.platform + '/' + process.arch);
  `,
  ]);
  const expected = JSON.parse(
    fs.readFileSync(path.join(root, "packages/CLI/package.json")),
  ).version;
  const actual = run(["index.cjs", "--version"]).trim();
  assert.ok(actual.includes(expected), `Expected version ${expected}, got ${actual}`);
  console.log("Isolated packaged CLI version check passed.");
  await checkServer();
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
