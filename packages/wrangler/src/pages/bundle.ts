import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createUploadWorkerBundleContents } from "../api/pages/create-worker-bundle-contents";
import { FatalError } from "../errors";
import { logger } from "../logger";
import * as metrics from "../metrics";
import { buildFunctions } from "./buildFunctions";
import { isInPagesCI } from "./constants";
import {
	EXIT_CODE_FUNCTIONS_NO_ROUTES_ERROR,
	FunctionsNoRoutesError,
	getFunctionsNoRoutesWarning,
} from "./errors";
import { buildRawWorker } from "./functions/buildWorker";
import { pagesBetaWarning } from "./utils";
import type { BundleResult } from "../bundle";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";

export type PagesBuildArgs = StrictYargsOptionsToInterface<typeof Options>;

export function Options(yargs: CommonYargsArgv) {
	return yargs
		.options({
			directory: {
				type: "string",
				description: "The directory of static files to upload",
			},
			"functions-directory": {
				type: "string",
				default: "functions",
				description: "The directory of Pages Functions",
			},
			outfile: {
				type: "string",
				default: "_worker.js",
				description: "The location of the output Worker bundle",
			},
			"output-config-path": {
				type: "string",
				description: "The location for the output config file",
			},
			"output-routes-path": {
				type: "string",
				description: "The location for the output _routes.json file",
			},
			minify: {
				type: "boolean",
				default: false,
				description: "Minify the output Worker script",
			},
			sourcemap: {
				type: "boolean",
				default: false,
				description: "Generate a sourcemap for the output Worker script",
			},
			"fallback-service": {
				type: "string",
				default: "ASSETS",
				description:
					"The service to fallback to at the end of the `next` chain. Setting to '' will fallback to the global `fetch`.",
			},
			watch: {
				type: "boolean",
				default: false,
				description:
					"Watch for changes to the functions and automatically rebuild the Worker script",
			},
			plugin: {
				type: "boolean",
				default: false,
				description: "Build a plugin rather than a Worker script",
			},
			"build-output-directory": {
				type: "string",
				description: "The directory to output static assets to",
			},
			"node-compat": {
				describe: "Enable node.js compatibility",
				default: false,
				type: "boolean",
				hidden: true,
			},
			bindings: {
				type: "string",
				describe:
					"Bindings used in Functions (used to register beta product shims)",
				deprecated: true,
				hidden: true,
			},
			"experimental-worker-bundle": {
				type: "boolean",
				default: false,
				hidden: true,
				description:
					"Whether to process non-JS module imports or not, such as wasm/text/binary, when we run bundling on `functions` or `_worker.js`",
			},
		})
		.epilogue(pagesBetaWarning);
}

export const Handler = async ({
	directory,
	functionsDirectory,
	outfile,
	outputConfigPath,
	outputRoutesPath: routesOutputPath,
	minify,
	sourcemap,
	fallbackService,
	watch,
	plugin,
	buildOutputDirectory,
	nodeCompat,
	bindings,
	experimentalWorkerBundle,
}: PagesBuildArgs) => {
	if (!isInPagesCI) {
		// Beta message for `wrangler pages <commands>` usage
		logger.log(pagesBetaWarning);
	}

	if (nodeCompat) {
		console.warn(
			"Enabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details."
		);
	}

	// TODO @Carmen do we want this or should we fallback to whatever errors
	// are thrown when dir/files are resolved?
	// `wrangler pages functions bundle`
	if (
		!directory &&
		functionsDirectory === "functions" &&
		!existsSync(functionsDirectory)
	) {
		throw new FatalError(`Could not find a static assets directory or the Functions directory.
No [--directory] of static files was provided so we looked for /${functionsDirectory} but couldn't find anything.
	➤ If you are trying to build _worker.js, please make sure you provide the directory containing your static files [--directory].
	➤ If you are trying to build Pages Functions, please make sure [--functions-directory] points to the location of your Functions files.`);
	}

	let d1Databases: string[] | undefined = undefined;
	if (bindings) {
		try {
			const decodedBindings = JSON.parse(bindings);
			d1Databases = Object.keys(decodedBindings?.d1_databases || {});
		} catch {
			throw new FatalError("Could not parse a valid set of 'bindings'.", 1);
		}
	}

	const workerScriptPath = directory && resolvePath(directory, "_worker.js");
	let bundle: BundleResult | undefined = undefined;
	outfile = experimentalWorkerBundle ? "_worker.bundle" : outfile;

	/**
	 * `_worker.js` always takes precedence over Pages Functions. If we run
	 * `pages functions build` for a project that contains both `_worker.js`
	 * and Pages Functions, we will build `_worker.js` and ignore Functions
	 */
	if (workerScriptPath) {
		/**
		 * `buildRawWorker` builds `_worker.js`, but doesn't give us the bundle
		 * we want to return, which includes the external dependencies (like wasm,
		 * binary, text). Let's output that build result to memory and only write
		 * to disk once we have the final bundle
		 */
		const workerOutfile = join(
			tmpdir(),
			`./bundledWorker-${Math.random()}.mjs`
		);

		bundle = await buildRawWorker({
			workerScriptPath,
			outfile: workerOutfile,
			directory: directory ?? ".",
			local: false,
			sourcemap: true,
			watch: false,
			onEnd: () => {},
			betaD1Shims: d1Databases,
			experimentalWorkerBundle,
		});
	} else if (functionsDirectory) {
		/**
		 * `buildFunctions` builds `/functions`, but doesn't give us the bundle
		 * we want to return, which includes the external dependencies (like wasm,
		 * binary, text). Let's output that build result to memory and only write
		 * to disk once we have the final bundle
		 */
		const functionsOutfile = experimentalWorkerBundle
			? join(tmpdir(), `./functionsWorker-${Math.random()}.js`)
			: outfile;
		buildOutputDirectory ??= dirname(outfile);

		try {
			bundle = await buildFunctions({
				outfile: functionsOutfile,
				outputConfigPath,
				functionsDirectory,
				minify,
				sourcemap,
				fallbackService,
				watch,
				plugin,
				buildOutputDirectory,
				nodeCompat,
				routesOutputPath,
				local: false,
				d1Databases,
				experimentalWorkerBundle,
			});
		} catch (e) {
			if (e instanceof FunctionsNoRoutesError) {
				throw new FatalError(
					getFunctionsNoRoutesWarning(functionsDirectory),
					EXIT_CODE_FUNCTIONS_NO_ROUTES_ERROR
				);
			} else {
				throw e;
			}
		}
	}

	if (experimentalWorkerBundle) {
		const workerBundleContents = await createUploadWorkerBundleContents(
			bundle as BundleResult
		);

		writeFileSync(
			outfile,
			Buffer.from(await workerBundleContents.arrayBuffer())
		);
	}

	await metrics.sendMetricsEvent("build pages functions");
};
