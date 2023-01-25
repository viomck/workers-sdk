import { readFileSync } from "node:fs";
import path from "node:path";
import { Response } from "undici";
import { createWorkerUploadForm } from "../../create-worker-upload-form";
import type { BundleResult } from "../../bundle";
import type { CfWorkerInit } from "../../worker";
import type { Blob } from "node:buffer";
import type { FormData } from "undici";

/**
 * Takes a Worker bundle - `BundleResult` - and generates the contents
 * of the upload worker bundle file
 */
export async function createUploadWorkerBundleContents(
	workerBundle: BundleResult
): Promise<Blob> {
	const workerBundleFormData = createWorkerBundleFormData(
		workerBundle as BundleResult
	);
	return await new Response(workerBundleFormData).blob();
}

/**
 * Creates a `FormData` upload from a `BundleResult`
 */
function createWorkerBundleFormData(workerBundle: BundleResult): FormData {
	const mainModule = {
		name: path.basename(workerBundle.resolvedEntryPointPath),
		content: readFileSync(workerBundle.resolvedEntryPointPath, {
			encoding: "utf-8",
		}),
		type: workerBundle.bundleType || "esm",
	};

	const worker: CfWorkerInit = {
		name: mainModule.name,
		main: mainModule,
		modules: workerBundle.modules,
		bindings: {
			vars: undefined,
			kv_namespaces: undefined,
			wasm_modules: undefined,
			text_blobs: undefined,
			data_blobs: undefined,
			durable_objects: undefined,
			queues: undefined,
			r2_buckets: undefined,
			d1_databases: undefined,
			services: undefined,
			analytics_engine_datasets: undefined,
			dispatch_namespaces: undefined,
			logfwdr: undefined,
			unsafe: undefined,
		},
		migrations: undefined,
		compatibility_date: undefined,
		compatibility_flags: undefined,
		usage_model: undefined,
		keepVars: undefined,
		logpush: undefined,
	};

	return createWorkerUploadForm(worker);
}
