import { URLSearchParams } from "url";
import { fetchResult, fetchScriptContent } from "./cfetch";
import { readConfig } from "./config";
import { logger } from "./logger";
import * as metrics from "./metrics";
import { requireAuth } from "./user";
import { getScriptName, printWranglerBanner } from ".";

import type { Config } from "./config";
import type { ServiceMetadataRes } from "./init";
import type { CommonYargsOptions } from "./yargs-types";
import type { ArgumentsCamelCase } from "yargs";

export type DeploymentListRes = {
	latest: {
		id: string;
		number: string;
		metadata: {
			author_id: string;
			author_email: string;
			source: "api" | "dash" | "wrangler" | "terraform" | "other";
			created_on: string;
			modified_on: string;
		};
		resources: {
			script: string;
			bindings: unknown[];
		};
	};
	items: {
		id: string;
		number: string;
		metadata: {
			author_id: string;
			author_email: string;
			source: "api" | "dash" | "wrangler" | "terraform" | "other";
			created_on: string;
			modified_on: string;
		};
	}[];
};

export async function deployments(
	accountId: string,
	scriptName: string | undefined,
	{ send_metrics: sendMetrics }: { send_metrics?: Config["send_metrics"] } = {}
) {
	if (!scriptName) {
		throw new Error(
			"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name`"
		);
	}

	await metrics.sendMetricsEvent(
		"view deployments",
		{ view: scriptName ? "single" : "all" },
		{
			sendMetrics,
		}
	);

	const scriptTag = (
		await fetchResult<ServiceMetadataRes>(
			`/accounts/${accountId}/workers/services/${scriptName}`
		)
	).default_environment.script.tag;

	const params = new URLSearchParams({ order: "asc" });
	const { items: deploys } = await fetchResult<DeploymentListRes>(
		`/accounts/${accountId}/workers/deployments/by-script/${scriptTag}`,
		undefined,
		params
	);

	const versionMessages = deploys.map(
		(versions) =>
			`\nDeployment ID: ${versions.id}
Created on: ${versions.metadata.created_on}
Author: ${versions.metadata.author_email}
Source: ${sourceStr(versions.metadata.source)}\n`
	);

	versionMessages[versionMessages.length - 1] += "🟩 Active";
	logger.log(...versionMessages);
}

function sourceStr(source: string): string {
	switch (source) {
		case "api":
			return "📡 API";
		case "dash":
			return "🖥️ Dashboard";
		case "wrangler":
			return "🤠 Wrangler";
		case "terraform":
			return "🏗️ Terraform";
		default:
			return "Other";
	}
}

export async function rollbackDeployment(
	accountId: string,
	scriptName: string | undefined,
	{ send_metrics: sendMetrics }: { send_metrics?: Config["send_metrics"] } = {},
	deploymentId: string
) {
	await metrics.sendMetricsEvent(
		"rollback deployments",
		{ view: scriptName ? "single" : "all" },
		{
			sendMetrics,
		}
	);

	const rollbackResponse = await fetchResult<DeploymentListRes["latest"]>(
		`/account/${accountId}/workers/scripts/${scriptName}?rollback_to=${deploymentId}`,
		{ method: "PUT" }
	);

	logger.log(`Successfully rolled back to deployment ID: ${deploymentId}`);
	logger.log(`Rollbacks details:
	${JSON.stringify(rollbackResponse, null, 2)}`);
}

export async function viewDeployment(
	accountId: string,
	scriptName: string | undefined,
	{ send_metrics: sendMetrics }: { send_metrics?: Config["send_metrics"] } = {},
	deploymentId: string
) {
	await metrics.sendMetricsEvent(
		"view deployments",
		{ view: scriptName ? "single" : "all" },
		{
			sendMetrics,
		}
	);

	const scriptTag = (
		await fetchResult<ServiceMetadataRes>(
			`/accounts/${accountId}/workers/services/${scriptName}`
		)
	).default_environment.script.tag;

	const scriptContent = await fetchScriptContent(
		`/accounts/${accountId}/workers/scripts/${scriptName}?deployment=${deploymentId}`
	);
	const deploymentDetails = await fetchResult<DeploymentListRes["latest"]>(
		`/accounts/${accountId}/workers/deployments/by-script/${scriptTag}/detail/${deploymentId}`
	);

	const flatObj: Record<string, unknown> = {};
	for (const deployDetailsKey in deploymentDetails) {
		if (
			Object.prototype.hasOwnProperty.call(deploymentDetails, deployDetailsKey)
		) {
			//@ts-expect-error flattening objects causes the index signature to error
			const value = deploymentDetails[deployDetailsKey];
			if (typeof value === "object" && value !== null) {
				for (const subKey in value) {
					if (Object.prototype.hasOwnProperty.call(value, subKey)) {
						flatObj[`${deployDetailsKey}.${subKey}`] = value[subKey];
					}
				}
			} else {
				flatObj[deployDetailsKey] = value;
			}
		}
	}

	logger.log(flatObj);
	logger.log(scriptContent);

	// early return to skip the deployments listings
	return;
}

export async function initializeDeployments(
	yargs: ArgumentsCamelCase<CommonYargsOptions>,
	deploymentsWarning: string
) {
	await printWranglerBanner();
	const config = readConfig(yargs.config, yargs);
	const accountId = await requireAuth(config);
	const scriptName = getScriptName(
		{ name: yargs.name as string, env: undefined },
		config
	);

	logger.log(`${deploymentsWarning}\n`);

	return { accountId, scriptName, config };
}
