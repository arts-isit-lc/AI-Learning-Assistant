/**
 * Bedrock model IDs and cross-Region inference (CRIS) wiring.
 *
 * The stack deploys to ca-central-1, which has NO in-Region access to the
 * Claude 4.5 family. We reach them through Geo-US cross-Region inference
 * profiles (the `us.` prefixed IDs). When invoked from ca-central-1 the Geo-US
 * profile routes to: ca-central-1, us-east-1, us-east-2, us-west-2
 * (source region + `GEO_US_US_DESTINATIONS`). See the Claude Sonnet 4.5 /
 * Haiku 4.5 model cards ("Regional availability" -> "Geo: US").
 *
 * Data-residency note: routing is US+Canada only (Geo-US, not Global), and the
 * account is configured for zero data retention (data_retention mode `none`),
 * so no prompt/response data is persisted in any destination Region.
 *
 * IAM: invoking a model through an inference profile requires InvokeModel* on
 * BOTH the inference-profile ARN (source region + account) AND the underlying
 * foundation-model ARN in EVERY destination Region. `crisInvokeResources()`
 * builds that exact list so the five IAM sites stay consistent.
 */

export interface CrisModel {
  /** Inference-profile ID passed as `modelId` in InvokeModel/Converse calls. */
  readonly profileId: string;
  /** Underlying foundation-model ID (used to build destination-region ARNs). */
  readonly foundationModelId: string;
}

export interface InRegionModel {
  readonly foundationModelId: string;
}

/** Anthropic Claude models invoked via Geo-US cross-Region inference profiles. */
export const SONNET_45: CrisModel = {
  profileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  foundationModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
};

export const HAIKU_45: CrisModel = {
  profileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  foundationModelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
};

/** Amazon/Meta models invoked in-Region (no inference profile, no CRIS). */
export const TITAN_EMBED_V2: InRegionModel = {
  foundationModelId: "amazon.titan-embed-text-v2:0",
};

export const LLAMA3_70B: InRegionModel = {
  foundationModelId: "meta.llama3-70b-instruct-v1:0",
};

/**
 * Geo-US destination Regions when the source (deploy) Region is ca-central-1.
 * The source Region itself is also a destination and is added separately in
 * `crisInvokeResources()` so this list stays deploy-region agnostic.
 */
export const GEO_US_US_DESTINATIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
];

/**
 * IAM resource ARNs required to invoke `model` via its Geo-US inference
 * profile: the inference-profile ARN plus the foundation-model ARN in the
 * source Region and every US destination Region.
 */
export function crisInvokeResources(
  model: CrisModel,
  region: string,
  account: string
): string[] {
  const destinationRegions = [region, ...GEO_US_US_DESTINATIONS];
  return [
    `arn:aws:bedrock:${region}:${account}:inference-profile/${model.profileId}`,
    ...destinationRegions.map(
      (r) => `arn:aws:bedrock:${r}::foundation-model/${model.foundationModelId}`
    ),
  ];
}

/** In-Region foundation-model ARN (Amazon/Meta models, no inference profile). */
export function inRegionModelResource(
  model: InRegionModel,
  region: string
): string {
  return `arn:aws:bedrock:${region}::foundation-model/${model.foundationModelId}`;
}
