const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Emits markers and errors that the `watch` task's background problem matcher
 * (see .vscode/tasks.json) understands, so VS Code knows when a rebuild starts
 * and finishes during F5 / preLaunchTask runs.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",
	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log("[watch] build finished");
		});
	},
};

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
	bundle: true,
	format: "cjs",
	platform: "node",
	// VS Code's extension host ships Node 20; keep output compatible with it.
	target: "node20",
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	// 'vscode' is provided by the extension host and must never be bundled.
	// (Node built-ins like fs/path/url are externalized automatically by platform: node.)
	external: ["vscode"],
	logLevel: "warning",
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	const contexts = await Promise.all([
		esbuild.context({
			...baseOptions,
			entryPoints: ["client/src/client.ts"],
			outfile: "client/out/client.js",
		}),
		esbuild.context({
			...baseOptions,
			entryPoints: ["server/src/server.ts"],
			outfile: "server/out/server.js",
		}),
	]);

	if (watch) {
		await Promise.all(contexts.map((ctx) => ctx.watch()));
	} else {
		await Promise.all(contexts.map((ctx) => ctx.rebuild()));
		await Promise.all(contexts.map((ctx) => ctx.dispose()));
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
