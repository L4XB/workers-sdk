import {
	configureOpenAPIForContainerPull,
	isCloudflareRegistryImage,
	resolveImageName,
} from "@cloudflare/containers-shared";
import {
	COMPLIANCE_REGION_CONFIG_UNKNOWN,
	getCloudflareApiBaseUrl,
} from "@cloudflare/workers-utils";
import type { ContainerDevOptions } from "@cloudflare/containers-shared";
import type { ComplianceConfig } from "@cloudflare/workers-utils";

/**
 * Configures the Containers API client used to retrieve image pull credentials.
 *
 * @param accountId - Cloudflare account ID that owns the managed registry.
 * @param apiToken - API token used to request registry credentials.
 * @param complianceConfig - Compliance configuration used to select the API endpoint.
 * @returns No value.
 */
export function configureContainerPull(
	accountId: string,
	apiToken: string,
	complianceConfig?: ComplianceConfig
): void {
	configureOpenAPIForContainerPull(
		accountId,
		apiToken,
		getCloudflareApiBaseUrl(
			complianceConfig ?? COMPLIANCE_REGION_CONFIG_UNKNOWN
		)
	);
}

/**
 * Qualifies managed-registry image references with the selected Cloudflare
 * account before Docker pulls them.
 *
 * @param containerOptions - Planned Container images.
 * @param accountId - Cloudflare account ID that owns managed-registry images.
 * @param complianceConfig - Compliance configuration used to select the managed registry.
 * @returns Container options with managed-registry image references qualified.
 */
export function normalizeContainerImageUris(
	containerOptions: readonly ContainerDevOptions[],
	accountId: string,
	complianceConfig?: ComplianceConfig
): ContainerDevOptions[] {
	return containerOptions.map((option) =>
		"image_uri" in option &&
		isCloudflareRegistryImage(option.image_uri, complianceConfig)
			? {
					...option,
					image_uri: resolveImageName(
						accountId,
						option.image_uri,
						complianceConfig
					),
				}
			: option
	);
}

/**
 * Returns the path to the Docker executable as defined by the
 * `WRANGLER_DOCKER_BIN` environment variable, or the default value
 * `"docker"`
 */
export function getDockerPath(): string {
	const defaultDockerPath = "docker";
	const dockerPathEnvVar = "WRANGLER_DOCKER_BIN";

	return process.env[dockerPathEnvVar] || defaultDockerPath;
}

export type ContainerTagToOptionsMap = Map<string, ContainerDevOptions>;
