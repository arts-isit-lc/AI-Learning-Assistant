import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../../lib/vpc-stack';
import { DatabaseStack } from '../../lib/database-stack';
import { ApiGatewayStack } from '../../lib/api-gateway-stack';
import { MultimodalRagStack } from '../../lib/multimodal-rag-stack';
import { DBFlowStack } from '../../lib/dbFlow-stack';
import { ObservabilityStack } from '../../lib/observability-stack';

export function createTestStacks() {
  const app = new cdk.App({
    context: { StackPrefix: 'Test', environment: 'dev' },
  });
  const env = { account: '123456789012', region: 'ca-central-1' };
  const vpcStack = new VpcStack(app, 'Test-VpcStack', { env, environment: 'dev' });
  const dbStack = new DatabaseStack(app, 'Test-DatabaseStack', vpcStack, { env, environment: 'dev' });
  const ragStack = new MultimodalRagStack(app, 'Test-MultimodalRagStack', dbStack, vpcStack, { env, environment: 'dev' });
  const apiStack = new ApiGatewayStack(app, 'Test-ApiGatewayStack', dbStack, vpcStack, ragStack, { env, environment: 'dev' });
  const dbFlowStack = new DBFlowStack(app, 'Test-DBFlowStack', vpcStack, dbStack, apiStack, { env });
  return {
    apiTemplate: Template.fromStack(apiStack),
    dbTemplate: Template.fromStack(dbStack),
    dbFlowTemplate: Template.fromStack(dbFlowStack),
    ragTemplate: Template.fromStack(ragStack),
  };
}

/**
 * Creates a standalone ObservabilityStack template for testing.
 * Uses a separate CDK app to avoid cross-stack reference resolution
 * issues during synthesis with the other stacks.
 */
export function createObservabilityTemplate(): Template {
  const app = new cdk.App({
    context: { StackPrefix: 'Test', environment: 'dev' },
  });
  const env = { account: '123456789012', region: 'ca-central-1' };

  const observabilityStack = new ObservabilityStack(app, 'Test-ObservabilityStack', {
    env,
    environment: 'dev',
    apiGatewayRestApiId: 'Test-ApiGatewayStack-API',
    apiGatewayStageName: 'prod',
    lambdaFunctions: [
      { functionName: 'Test-ApiGatewayStack-studentFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-instructorFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adminFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-preSignupLambda', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-addStudentOnSignUp', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adjustUserRoles-v9', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-adminLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-studentLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-instructorLambdaAuthorizer', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-GeneratePreSignedURLFunc', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-GetFilesFunction', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteFileFunc', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteModuleFunc', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-DeleteLastMessage', timeoutSeconds: 30, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-AuthHandler', timeoutSeconds: 3, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-NotificationFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-sqsFunction', timeoutSeconds: 60, isContainer: false },
      { functionName: 'Test-ApiGatewayStack-SQSTriggerDockerFunc', timeoutSeconds: 300, isContainer: true },
      { functionName: 'Test-ApiGatewayStack-GetChatLogsFunction', timeoutSeconds: 60, isContainer: false },
    ],
    rdsInstanceId: 'test-rds-instance',
    rdsAllocatedStorage: 100,
    rdsInstanceClass: 'db.t3.micro',
    messagesQueueName: 'test-messages-queue.fifo',
    messagesQueueArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-queue.fifo',
    dlqName: 'test-messages-dlq.fifo',
    dlqArn: 'arn:aws:sqs:ca-central-1:123456789012:test-messages-dlq.fifo',
    appSyncApiId: 'test-appsync-api-id',
    containerLambdaNames: [
      'Test-ApiGatewayStack-SQSTriggerDockerFunc',
    ],
  });

  return Template.fromStack(observabilityStack);
}
