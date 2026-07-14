import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { MultimodalRagStack } from '../lib/multimodal-rag-stack';
import { createTestStacks } from './helpers/stack-setup';

/**
 * The IR persistence bucket sets an EXPLICIT bucketName, which must be globally
 * unique across all AWS accounts. dev and prod share the same StackPrefix and
 * deploy to different accounts, so the name must be environment-namespaced —
 * otherwise the prod deploy collides with dev's existing bucket
 * (CloudFormation: "already exists").
 *
 * Contract locked here:
 *   - dev  -> historical un-suffixed name (its bucket already holds RETAINed IR
 *             data; renaming would orphan it)
 *   - prod -> environment-suffixed name (its own bucket, no collision)
 */
function ragTemplateFor(environment: string): Template {
  const app = new cdk.App({ context: { StackPrefix: 'Test', environment } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpc = new VpcStack(app, 'Test-VpcStack', { env, environment });
  const db = new DatabaseStack(app, 'Test-DatabaseStack', vpc, { env, environment });
  const rag = new MultimodalRagStack(app, 'Test-MultimodalRagStack', db, vpc, { env, environment });
  return Template.fromStack(rag);
}

describe('IR bucket name is environment-namespaced (global S3 uniqueness)', () => {
  test('dev keeps the historical un-suffixed name', () => {
    // createTestStacks() builds the dev (StackPrefix "Test", environment "dev") template.
    createTestStacks().ragTemplate.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-multimodalragstack-ir-bucket',
    });
  });

  test('prod uses an environment-suffixed name so it cannot collide with dev', () => {
    ragTemplateFor('prod').hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-multimodalragstack-ir-bucket-prod',
    });
  });

  test('prod does NOT create the un-suffixed (dev) bucket name', () => {
    const prod = ragTemplateFor('prod');
    const collisions = prod.findResources('AWS::S3::Bucket', {
      Properties: { BucketName: 'test-multimodalragstack-ir-bucket' },
    });
    expect(Object.keys(collisions)).toHaveLength(0);
  });
});
