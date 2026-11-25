// Type-check against the installed pi's own packages without copying them into node_modules.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const piBin = realpathSync(execSync("command -v pi", { shell: "/bin/sh" }).toString().trim());
let root = dirname(piBin);
while (!existsSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent")) && root !== "/") root = dirname(root);
const version = execSync("cat ~/.pi/agent/install/current-version 2>/dev/null || true", { shell: "/bin/sh" }).toString().trim();
const candidates = [
	join(root, "node_modules"),
	join(process.env.HOME ?? "", ".pi/agent/install/releases", version, "node_modules"),
];
const modules = candidates.find((c) => existsSync(join(c, "@earendil-works", "pi-coding-agent")));
if (!modules) throw new Error("Could not locate pi's node_modules");

const link = "node_modules/@earendil-works";
if (existsSync(link)) throw new Error(`${link} already exists; remove it first`);
symlinkSync(join(modules, "@earendil-works"), link);
try {
	execFileSync("npx", ["-y", "-p", "typescript@5", "tsc", "-p", ".", "--typeRoots", join(modules, "@types")], { stdio: "inherit" });
} finally {
	rmSync(link);
}
