import { createTestStacks } from './helpers/stack-setup';
import { Template } from 'aws-cdk-lib/assertions';

/**
 * S3 Bucket Security Tests
 *
 * These tests verify that all S3 buckets in the ApiGateway stack follow
 * security best practices: public access blocked, SSL enforced, no archive
 * tiering, and multipart upload cleanup enabled.
 *
 * Validates: Requirements 22.1, 22.2, 22.3, 22.4
 */

let apiTemplate: Template;

beforeAll(() => {
  const stacks = createTestStacks();
  apiTemplate = stacks.apiTemplate;
});

/**
 * Helper: collect all S3 bucket resources from the template.
 */
function collectS3Buckets(): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = apiTemplate.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::S3::Bucket') continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    results.push({ logicalId, properties: props });
  }

  return results;
}

/**
 * Helper: collect all S3 bucket policy resources from the template.
 */
function collectBucketPolicies(): Array<{ logicalId: string; properties: Record<string, unknown> }> {
  const json = apiTemplate.toJSON();
  const resources = json.Resources ?? {};
  const results: Array<{ logicalId: string; properties: Record<string, unknown> }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const res = resource as Record<string, unknown>;
    if (res.Type !== 'AWS::S3::BucketPolicy') continue;
    const props = (res.Properties as Record<string, unknown>) ?? {};
    results.push({ logicalId, properties: props });
  }

  return results;
}

describe('S3 Bucket Security', () => {
  /**
   * Validates: Requirement 22.1
   * All S3 buckets must have BlockPublicAccess set to BLOCK_ALL.
   */
  test('all S3 buckets have BlockPublicAccess set to BLOCK_ALL', () => {
    const buckets = collectS3Buckets();
    expect(buckets.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of buckets) {
      const publicAccessConfig = properties.PublicAccessBlockConfiguration as Record<string, unknown> | undefined;

      expect({
        bucket: logicalId,
        hasPublicAccessBlock: publicAccessConfig !== undefined,
        blockPublicAcls: publicAccessConfig?.BlockPublicAcls,
        blockPublicPolicy: publicAccessConfig?.BlockPublicPolicy,
        ignorePublicAcls: publicAccessConfig?.IgnorePublicAcls,
        restrictPublicBuckets: publicAccessConfig?.RestrictPublicBuckets,
      }).toEqual(
        expect.objectContaining({
          hasPublicAccessBlock: true,
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        })
      );
    }
  });

  /**
   * Validates: Requirement 22.2
   * All S3 buckets must enforce SSL via a bucket policy denying requests
   * where aws:SecureTransport is false.
   */
  test('all S3 buckets enforce SSL (require aws:SecureTransport)', () => {
    const buckets = collectS3Buckets();
    const policies = collectBucketPolicies();
    expect(buckets.length).toBeGreaterThan(0);

    // Each bucket should have a corresponding bucket policy with an SSL enforcement statement
    for (const { logicalId: bucketLogicalId } of buckets) {
      // Find the bucket policy that references this bucket
      const matchingPolicy = policies.find(({ properties }) => {
        const bucketRef = properties.Bucket;
        if (typeof bucketRef === 'object' && bucketRef !== null) {
          const ref = (bucketRef as Record<string, unknown>).Ref;
          if (ref === bucketLogicalId) return true;
        }
        return false;
      });

      expect({
        bucket: bucketLogicalId,
        hasBucketPolicy: matchingPolicy !== undefined,
      }).toEqual(
        expect.objectContaining({ hasBucketPolicy: true })
      );

      if (!matchingPolicy) continue;

      // Check for a Deny statement with aws:SecureTransport condition
      const policyDoc = matchingPolicy.properties.PolicyDocument as Record<string, unknown>;
      const statements = policyDoc.Statement as Array<Record<string, unknown>>;

      const hasSSLEnforcement = statements.some((stmt) => {
        if (stmt.Effect !== 'Deny') return false;
        const condition = stmt.Condition as Record<string, unknown> | undefined;
        if (!condition) return false;
        const boolCondition = condition.Bool as Record<string, unknown> | undefined;
        if (!boolCondition) return false;
        return boolCondition['aws:SecureTransport'] === 'false';
      });

      expect({
        bucket: bucketLogicalId,
        hasSSLEnforcement,
      }).toEqual(
        expect.objectContaining({ hasSSLEnforcement: true })
      );
    }
  });

  /**
   * Validates: Requirement 22.3
   * No S3 bucket should have archiveAccessTierTime in its Intelligent Tiering configuration.
   */
  test('no S3 bucket has archiveAccessTierTime in Intelligent Tiering', () => {
    const buckets = collectS3Buckets();
    expect(buckets.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of buckets) {
      const tieringConfigs = properties.IntelligentTieringConfigurations as Array<Record<string, unknown>> | undefined;

      if (!tieringConfigs) continue;

      for (const config of tieringConfigs) {
        const tierings = config.Tierings as Array<Record<string, unknown>> | undefined;
        if (!tierings) continue;

        const hasArchiveAccess = tierings.some(
          (tier) => tier.AccessTier === 'ARCHIVE_ACCESS'
        );

        expect({
          bucket: logicalId,
          hasArchiveAccessTier: hasArchiveAccess,
        }).toEqual(
          expect.objectContaining({ hasArchiveAccessTier: false })
        );
      }
    }
  });

  /**
   * Validates: Requirement 22.4
   * All S3 buckets must have an AbortIncompleteMultipartUpload lifecycle rule.
   */
  test('all S3 buckets have AbortIncompleteMultipartUpload lifecycle rule', () => {
    const buckets = collectS3Buckets();
    expect(buckets.length).toBeGreaterThan(0);

    for (const { logicalId, properties } of buckets) {
      const lifecycleConfig = properties.LifecycleConfiguration as Record<string, unknown> | undefined;
      const rules = (lifecycleConfig?.Rules as Array<Record<string, unknown>>) ?? [];

      const hasAbortRule = rules.some(
        (rule) => rule.AbortIncompleteMultipartUpload !== undefined
      );

      expect({
        bucket: logicalId,
        hasAbortIncompleteMultipartUpload: hasAbortRule,
      }).toEqual(
        expect.objectContaining({ hasAbortIncompleteMultipartUpload: true })
      );
    }
  });
});
