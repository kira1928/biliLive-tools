import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const script = new URL("../scripts/copy_module.js", import.meta.url);
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function packageAt(
  directory,
  manifest,
  body = `module.exports = ${JSON.stringify(manifest.version ?? "1")};`,
) {
  write(path.join(directory, "package.json"), JSON.stringify({ main: "index.cjs", ...manifest }));
  write(path.join(directory, "index.cjs"), body);
  return directory;
}
function fixture(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "btools-packaging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "packages", "CLI");
  packageAt(cli, { name: "fixture-cli", type: "module", ...manifest });
  write(path.join(root, "appConfig.json"), '{"fixture":true}');
  write(path.join(cli, "scripts", "copy_module.js"), fs.readFileSync(script));
  const output = path.join(cli, "lib");
  return {
    root,
    cli,
    output,
    add(name, config = {}, body, importer = cli) {
      return packageAt(path.join(importer, "node_modules", name), { name, ...config }, body);
    },
    run() {
      return spawnSync(process.execPath, [path.join(cli, "scripts", "copy_module.js")], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      });
    },
    require() {
      return createRequire(path.join(output, "index.cjs"));
    },
  };
}
function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("copies required transitive packages without exports access or dev dependencies", (t) => {
  const f = fixture(t, { dependencies: { parent: "1" }, devDependencies: { unused: "1" } });
  const parent = f.add(
    "parent",
    { dependencies: { child: "1" }, devDependencies: { ignored: "1" } },
    'module.exports = require("child");',
  );
  f.add("child", { exports: { ".": "./index.cjs" } }, 'module.exports = "transitive";', parent);
  f.add("ignored", {}, undefined, parent);
  f.add("unused");
  succeeded(f.run());
  assert.equal(f.require()("parent"), "transitive");
  assert.equal(fs.existsSync(path.join(f.output, "node_modules", "unused")), false);
  assert.equal(
    fs.existsSync(path.join(f.output, "node_modules", "parent", "node_modules", "ignored")),
    false,
  );
});

test("copies installed npm packages whose names match Node builtins", (t) => {
  const f = fixture(t, { dependencies: { string_decoder: "1" } });
  f.add("string_decoder", { version: "1.3.0" });
  succeeded(f.run());
  assert.equal(f.require()("./node_modules/string_decoder/index.cjs"), "1.3.0");
});

test("fails for missing required roots and transitive dependencies", async (t) => {
  for (const transitive of [false, true]) {
    await t.test(transitive ? "transitive" : "root", (t) => {
      const missing = "btools-fixture-missing-required-94695";
      const f = fixture(t, { dependencies: transitive ? { parent: "1" } : { [missing]: "1" } });
      if (transitive) f.add("parent", { dependencies: { [missing]: "1" } });
      const result = f.run();
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(missing));
    });
  }
});

test("skips missing optional dependencies including required entries overridden as optional", (t) => {
  const missing = "btools-fixture-missing-optional-94695";
  const f = fixture(t, {
    dependencies: { parent: "1", [missing]: "1" },
    optionalDependencies: { [missing]: "1" },
  });
  f.add("parent", { optionalDependencies: { [missing]: "1" } });
  succeeded(f.run());
  assert.equal(f.require()("parent"), "1");
  assert.equal(fs.existsSync(path.join(f.output, "node_modules", missing)), false);
});

test("includes installed scoped optional native assets without loading the binary", (t) => {
  const f = fixture(t, { dependencies: { canvas: "1" } });
  const parent = f.add("canvas", {
    optionalDependencies: { "@fixture/canvas-native": "1", "@fixture/missing-platform": "1" },
  });
  const native = f.add("@fixture/canvas-native", {}, undefined, parent);
  const bytes = Buffer.from([0, 255, 1, 123]);
  write(path.join(native, "binding.node"), bytes);
  succeeded(f.run());
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        f.output,
        "node_modules",
        "canvas",
        "node_modules",
        "@fixture",
        "canvas-native",
        "binding.node",
      ),
    ),
    bytes,
  );
});

test("retains nested version collisions and sibling visibility", (t) => {
  const f = fixture(t, { dependencies: { parent: "1", shared: "1" } });
  f.add("shared", { version: "1.0.0" });
  const parent = f.add(
    "parent",
    { dependencies: { shared: "2", sibling: "1" } },
    'module.exports = [require("shared"), require("sibling")];',
  );
  f.add("shared", { version: "2.0.0" }, undefined, parent);
  f.add(
    "sibling",
    { dependencies: { shared: "2" } },
    'module.exports = require("shared");',
    parent,
  );
  succeeded(f.run());
  assert.deepEqual(f.require()("parent"), ["2.0.0", "2.0.0"]);
  assert.equal(f.require()("shared"), "1.0.0");
});

test("dereferences pnpm-style directory links and terminates dependency cycles", (t) => {
  const f = fixture(t, { dependencies: { alpha: "1" } });
  const store = path.join(f.root, "store");
  const alpha = packageAt(
    path.join(store, "alpha"),
    { name: "alpha", dependencies: { beta: "1" } },
    'exports.name = "alpha"; exports.beta = require("beta");',
  );
  const beta = packageAt(
    path.join(store, "beta"),
    { name: "beta", dependencies: { alpha: "1" } },
    'exports.name = "beta"; exports.alpha = require("alpha").name;',
  );
  function link(target, location) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.symlinkSync(target, location, process.platform === "win32" ? "junction" : "dir");
  }
  link(alpha, path.join(f.cli, "node_modules", "alpha"));
  link(beta, path.join(alpha, "node_modules", "beta"));
  link(alpha, path.join(beta, "node_modules", "alpha"));
  write(path.join(store, "assets", "fixture.txt"), "asset bytes");
  link(path.join(store, "assets"), path.join(alpha, "assets"));
  succeeded(f.run());
  // The copied output must work after the entire installed source tree is gone.
  fs.rmSync(path.join(f.cli, "node_modules"), { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
  assert.equal(f.require()("alpha").beta.alpha, "alpha");
  assert.equal(
    fs.readFileSync(path.join(f.output, "node_modules", "alpha", "assets", "fixture.txt"), "utf8"),
    "asset bytes",
  );
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory)) {
      const location = path.join(directory, entry);
      const stat = fs.lstatSync(location);
      assert.equal(stat.isSymbolicLink(), false, location);
      if (stat.isDirectory()) inspect(location);
    }
  }
  inspect(f.output);
});

test("reruns replace stale dependencies while preserving Rollup chunks and updating appConfig", (t) => {
  const f = fixture(t, { dependencies: { old: "1" } });
  f.add("old");
  write(path.join(f.output, "index.cjs"), "entry bytes");
  write(path.join(f.output, "chunks", "lazy.cjs"), "chunk bytes");
  succeeded(f.run());
  packageAt(f.cli, { type: "module", dependencies: { current: "1" } });
  f.add("current");
  write(path.join(f.root, "appConfig.json"), '{"fixture":"updated"}');
  succeeded(f.run());
  assert.equal(fs.existsSync(path.join(f.output, "node_modules", "old")), false);
  assert.equal(f.require()("current"), "1");
  assert.equal(fs.readFileSync(path.join(f.output, "index.cjs"), "utf8"), "entry bytes");
  assert.equal(fs.readFileSync(path.join(f.output, "chunks", "lazy.cjs"), "utf8"), "chunk bytes");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, "appConfig.json"))), {
    fixture: "updated",
  });
});
