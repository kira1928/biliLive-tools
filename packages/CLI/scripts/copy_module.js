import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(cliRoot, "lib");
const modulesRoot = path.join(outputRoot, "node_modules");
const readManifest = (directory) =>
  JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));

// 按导入者的实际安装树查找，不能从整个 pnpm 仓库猜测版本，也不依赖包的 exports。
function resolvePackage(name, importer, optional) {
  const require = createRequire(path.join(importer, "package.json"));
  // 使用非内置名称获取搜索路径，避免 string_decoder 等同名 npm 包被误判。
  for (const directory of require.resolve.paths("__bgo_package_lookup__") ?? []) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
  }
  if (optional) {
    console.log(`跳过未安装的可选依赖：${name} (${importer})`);
    return null;
  }
  throw new Error(`缺少生产依赖 ${name}，导入者：${importer}`);
}

function dependencies(directory) {
  const manifest = readManifest(directory);
  const optional = manifest.optionalDependencies ?? {};
  return Object.keys({ ...manifest.dependencies, ...optional })
    .map((name) => ({
      name,
      source: resolvePackage(name, directory, Object.hasOwn(optional, name)),
    }))
    .filter(({ source }) => source !== null);
}

let copied = 0;
function copyPackage(source, target, visible) {
  // 只复制包自身的真实字节；node_modules 由依赖图重建，避免携带 pnpm 链接或开发依赖。
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (entry) =>
      entry === source || !path.relative(source, entry).split(path.sep).includes("node_modules"),
  });
  copied++;
  const children = dependencies(source);
  const nested = new Map(visible);
  // 先登记同层的所有包，再递归，使循环依赖能够使用祖先的同一版本。
  for (const child of children) {
    if (visible.get(child.name) !== child.source) nested.set(child.name, child.source);
  }
  for (const child of children) {
    if (visible.get(child.name) === child.source) continue;
    copyPackage(child.source, path.join(target, "node_modules", child.name), nested);
  }
}

// 重跑时清除旧依赖，保留 Rollup 生成的根入口和动态加载的代码块。
const roots = dependencies(cliRoot);
fs.mkdirSync(outputRoot, { recursive: true });
fs.rmSync(modulesRoot, { recursive: true, force: true });
fs.mkdirSync(modulesRoot, { recursive: true });
const visible = new Map(roots.map(({ name, source }) => [name, source]));
for (const { name, source } of roots) copyPackage(source, path.join(modulesRoot, name), visible);
fs.copyFileSync(
  path.resolve(cliRoot, "../../appConfig.json"),
  path.join(outputRoot, "appConfig.json"),
);
console.log(`已复制 ${copied} 个生产依赖包及 appConfig.json。`);
