import fs from "node:fs";
import path from "node:path";
import { OpenAPI } from "@cloudflare/containers-shared";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { resolveConfig } from "vite";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as wrangler from "wrangler";
import {
	configureContainerPull,
	normalizeContainerImageUris,
} from "../containers";
import { getPreviewMiniflareOptions } from "../miniflare-options";
import type { PreviewPluginContext } from "../context";
import type { PreviewResolvedConfig } from "../plugin-config";
import type * as vite from "vite";
import type { Unstable_Config } from "wrangler";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

describe("configureContainerPull", () => {
	beforeEach(() => {
		vi.stubEnv("CLOUDFLARE_API_BASE_URL", undefined);
		vi.stubEnv("CF_API_BASE_URL", undefined);
		vi.stubEnv("CLOUDFLARE_COMPLIANCE_REGION", undefined);
		vi.stubEnv("WRANGLER_API_ENVIRONMENT", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		OpenAPI.BASE = "";
		OpenAPI.HEADERS = undefined;
		OpenAPI.CREDENTIALS = "include";
	});

	test("uses the FedRAMP High API for managed registry credentials", ({
		expect,
	}) => {
		configureContainerPull("abc123", "my-token", {
			compliance_region: "fedramp_high",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.fed.cloudflare.com/client/v4/accounts/abc123/containers"
		);
	});

	test("uses the staging FedRAMP High API for managed registry credentials", ({
		expect,
	}) => {
		vi.stubEnv("WRANGLER_API_ENVIRONMENT", "staging");

		configureContainerPull("abc123", "my-token", {
			compliance_region: "fedramp_high",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.fed.staging.cloudflare.com/client/v4/accounts/abc123/containers"
		);
	});

	test("preserves the explicit API base override", ({ expect }) => {
		vi.stubEnv("CLOUDFLARE_API_BASE_URL", "https://api.example.com/client/v4");

		configureContainerPull("abc123", "my-token", {
			compliance_region: "fedramp_high",
		});

		expect(OpenAPI.BASE).toBe(
			"https://api.example.com/client/v4/accounts/abc123/containers"
		);
	});
});

test("qualifies managed-registry images for the selected account", ({
	expect,
}) => {
	expect(
		normalizeContainerImageUris(
			[
				{
					image_uri: "registry.cloudflare.com/app:latest",
					image_tag: "cloudflare-dev/app:build-id",
					class_name: "ContainerDO",
				},
				{
					image_uri: "docker.io/example/app:latest",
					image_tag: "cloudflare-dev/external:build-id",
					class_name: "ContainerDO",
				},
			],
			"abc123"
		)
	).toEqual([
		expect.objectContaining({
			image_uri: "registry.cloudflare.com/abc123/app:latest",
		}),
		expect.objectContaining({
			image_uri: "docker.io/example/app:latest",
		}),
	]);
});

describe("Container image planning", () => {
	runInTempDir();

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("uses independent image tags for each preview Worker", async ({
		expect,
	}) => {
		vi.stubEnv("WRANGLER_DOCKER_HOST", "unix:///test/docker.sock");

		function createWorkerConfig(name: string): Unstable_Config {
			const directory = path.resolve(name);
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, "index.js"), "export default {};");
			fs.writeFileSync(path.join(directory, "Dockerfile"), `FROM ${name}`);
			const configPath = path.join(directory, "wrangler.jsonc");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					name,
					main: "./index.js",
					compatibility_date: "2026-09-05",
					containers: [
						{
							name: "managed-container",
							scheduling_policy: "durable_object",
							images: { app: { dockerfile: "./Dockerfile" } },
						},
					],
					exports: {
						ContainerDO: {
							type: "durable-object",
							storage: "sqlite",
							container: "managed-container",
						},
					},
					durable_objects: {
						bindings: [{ name: "CONTAINER", class_name: "ContainerDO" }],
					},
				})
			);
			return wrangler.unstable_readConfig({ config: configPath });
		}

		const resolvedViteConfig = await resolveConfig(
			{ logLevel: "silent", root: process.cwd() },
			"serve"
		);
		const resolvedPluginConfig: PreviewResolvedConfig = {
			type: "preview",
			workers: ["first", "second"].map((name) => ({
				source: "legacy",
				config: createWorkerConfig(name),
			})),
			persistState: false,
			inspectorPort: false,
			experimental: { headersAndRedirectsDevModeSupport: false },
			remoteBindings: false,
			tunnel: { autoStart: false },
		};
		const ctx = {
			resolvedPluginConfig,
			resolvedViteConfig,
		} as PreviewPluginContext;
		const vitePreviewServer = {
			config: resolvedViteConfig,
		} as vite.PreviewServer;

		const { miniflareOptions, containerTagToOptionsMap } =
			await getPreviewMiniflareOptions(ctx, vitePreviewServer);

		expect(containerTagToOptionsMap.size).toBe(2);
		expect(new Set(containerTagToOptionsMap.keys()).size).toBe(2);
		expect(
			new Set(
				[...containerTagToOptionsMap.values()].map((option) =>
					"dockerfile" in option ? option.dockerfile : undefined
				)
			)
		).toEqual(
			new Set([
				path.resolve("first/Dockerfile"),
				path.resolve("second/Dockerfile"),
			])
		);
		const runtimeImageTags = miniflareOptions.workers.flatMap((worker) =>
			Object.values(worker.config.exports ?? {}).flatMap((workerExport) => {
				const images = asRecord(asRecord(workerExport)?.container)?.images;
				return Array.isArray(images)
					? images.flatMap((image) => {
							const reference = asRecord(image)?.image;
							return typeof reference === "string" ? [reference] : [];
						})
					: [];
			})
		);
		expect(new Set(runtimeImageTags)).toEqual(
			new Set(containerTagToOptionsMap.keys())
		);
	});
});
