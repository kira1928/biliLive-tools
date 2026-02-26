import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// TODO:显然其他类型打包还有问题
const cli_node_modules = path.resolve(__dirname, "../lib/node_modules");
const pnpm_node_modules = path.resolve(__dirname, "../../../node_modules");

// console.log("__dirname", __dirname, pnpm_node_modules);

function main() {
  // 找到@napi-rs相关包，复制到cli_node_modules,这个路径可能不存在，不存在则创建
  if (!fs.existsSync(cli_node_modules)) {
    fs.mkdirSync(cli_node_modules);
  }
  // 抽象一个安全复制方法：仅当源存在时才复制，避免跨平台缺包导致出错
  const copyIfExists = (from, to) => {
    if (fs.existsSync(from)) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      // 某些包是平台相关的（例如 ntsuspend 仅 Windows），在非目标平台缺失属于正常情况
      console.warn(`[copy_module] skip (not found): ${from}`);
    }
  };

  // 复制相关依赖（按需存在即复制）
  copyIfExists(
    path.join(pnpm_node_modules, "@napi-rs"),
    path.join(cli_node_modules, "@napi-rs"),
  );
  copyIfExists(
    path.join(pnpm_node_modules, "ntsuspend"),
    path.join(cli_node_modules, "ntsuspend"),
  );
  copyIfExists(
    path.join(pnpm_node_modules, "font-ls"),
    path.join(cli_node_modules, "font-ls"),
  );
  copyIfExists(
    path.join(pnpm_node_modules, "better-sqlite3"),
    path.join(cli_node_modules, "better-sqlite3"),
  );
  copyIfExists(
    path.join(pnpm_node_modules, "file-uri-to-path"),
    path.join(cli_node_modules, "file-uri-to-path"),
  );
  copyIfExists(
    path.join(pnpm_node_modules, "bindings"),
    path.join(cli_node_modules, "bindings"),
  );
}

main();
