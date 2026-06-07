# Implementation Plan: Infrastructure Hardening

## Overview

This plan implements infrastructure hardening across four domains: S3 storage policies, IAM least-privilege enforcement, RDS SSL enforcement, and CDK assertion tests. The 9-step sequence is ordered to minimize deployment risk — zero-risk changes first, then SSL (which touches Lambda code across all functions), then IAM role splitting, and finally tests to lock in the new configuration.

## Tasks

- [x] 1. Harden S3 bucket configurations in api-gateway-stack.ts
  - [x] 1.1 Remove archiveAccessTierTime from embeddingStorageBucket
    - Remove the `archiveAccessTierTime: cdk.Duration.days(90)` property from the Intelligent Tiering configuration
    - Add `encryption: s3.BucketEncryption.S3_MANAGED` to the bucket
    - Add lifecycle rule with `abortIncompleteMultipartUploadAfter: Duration.days(1)`
    - Add lifecycle rule with object expiration after 7 days (cleans orphaned temp files)
    - _Requirements: 1.3, 2.1, 2.2, 4.2_
  - [x] 1.2 Remove archiveAccessTierTime from dataIngestionBucket
    - Remove the `archiveAccessTierTime` property from the Intelligent Tiering configuration
    - Add `encryption: s3.BucketEncryption.S3_MANAGED` to the bucket
    - Add lifecycle rule with `abortIncompleteMultipartUploadAfter: Duration.days(1)`
    - _Requirements: 1.1, 3.1, 4.1_
  - [x] 1.3 Remove archiveAccessTierTime from chatlogsBucket
    - Remove the `archiveAccessTierTime` property from the Intelligent Tiering configuration
    - Add `encryption: s3.BucketEncryption.S3_MANAGED` to the bucket
    - Add lifecycle rule with `abortIncompleteMultipartUploadAfter: Duration.days(1)`
    - _Requirements: 1.2, 3.2, 4.3_

- [x] 2. Remove unused IAM permissions
  - [x] 2.1 Remove managed policies from dbFlow-stack.ts
    - Remove `iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess")` from the lambdaRole
    - Remove `iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")` from the lambdaRole
    - _Requirements: 5.1, 5.2_
  - [x] 2.2 Remove unused permissions from api-gateway-stack.ts
    - Remove the `iam:AddUserToGroup` policy statement from `coglambdaRole`
    - Remove the SES permission (`ses:SendEmail`, `ses:SendRawEmail`) added to `notificationFunction` via `addToRolePolicy`
    - Remove the redundant Secrets Manager policy on `coglambdaRole` that grants `secretsmanager:PutSecretValue`
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 3. Scope single-function IAM policies in api-gateway-stack.ts
  - [x] 3.1 Scope SSM parameter wildcard on coglambdaRole
    - Change `arn:aws:ssm:${region}:${account}:parameter/*` to `arn:aws:ssm:${region}:${account}:parameter/AILA/AllowedEmailDomains`
    - _Requirements: 7.1_
  - [x] 3.2 Scope DynamoDB access for deleteLastMessage
    - Change `arn:aws:dynamodb:${region}:${account}:table/*` to the specific conversation table ARN
    - Use the SSM-derived table name parameter to construct the ARN
    - Restrict to `dynamodb:GetItem` and `dynamodb:UpdateItem` only on the specific table
    - _Requirements: 8.1, 8.2_

- [x] 4. Add SSL parameters to all Lambda database connections
  - [x] 4.1 Update Node.js connection libraries
    - In `cdk/lambda/lib/lib.js`: change `ssl: false` to `ssl: 'require'` in the connection config
    - In `cdk/lambda/adminFunction/libadmin.js`: change `ssl: false` to `ssl: 'require'` in the connection config
    - _Requirements: 9.1, 9.2_
  - [x] 4.2 Update Python psycopg2 connection-string Lambda functions
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/lambda/deleteFile/deleteFile.py`
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/lambda/deleteLastMessage/deleteLastMessage.py`
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/lambda/getFilesFunction/getFilesFunction.py`
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/sqsTrigger/src/main.py`
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/text_generation/src/main.py`
    - Add `'sslmode': 'require'` to `connection_params` dict in `cdk/data_ingestion/src/main.py`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x] 4.3 Update Python SQLAlchemy URI connections
    - Append `?sslmode=require` to the connection URI in `cdk/data_ingestion/src/helpers/helper.py`
    - Append `?sslmode=require` to the connection URI in `cdk/text_generation/src/helpers/helper.py`
    - _Requirements: 11.1, 11.2_
  - [x] 4.4 Update Python raw psycopg2 connection string
    - Add `sslmode=require` to the connection string in `cdk/text_generation/src/helpers/vectorstore.py`
    - _Requirements: 11.3_
  - [x] 4.5 Uncomment SSL in initializer Lambda
    - Uncomment `sslmode="require"` in `cdk/lambda/initializer/initializer.py` createConnection function
    - _Requirements: 12.1_

- [x] 5. Checkpoint — Deploy and verify SSL in dev
  - Deploy Lambda code changes to dev environment and verify all functions connect successfully with SSL
  - Check CloudWatch Logs for connection errors across all 13 connection paths
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Enable RDS SSL enforcement in database-stack.ts
  - [x] 6.1 Set requireTLS to true on all three RDS proxies
    - Change `requireTLS: false` to `requireTLS: true` on `rdsProxy`
    - Change `requireTLS: false` to `requireTLS: true` on `rdsProxyTableCreator`
    - Change `requireTLS: false` to `requireTLS: true` on `rdsProxyAdmin`
    - _Requirements: 13.1, 13.2, 13.3_
  - [x] 6.2 Set rds.force_ssl to '1' in the parameter group
    - Change `'rds.force_ssl': '0'` to `'rds.force_ssl': '1'` in the parameterGroup parameters
    - _Requirements: 14.1_

- [x] 7. Split shared IAM roles into per-function-group roles in api-gateway-stack.ts
  - [x] 7.1 Create dbLambdaRole for studentFunction and instructorFunction
    - Create new `iam.Role` with SecretsManager (scoped to `db.secretPathUser.secretArn`), EC2 VPC networking, and CloudWatch Logs (scoped to function log groups)
    - Assign to `studentFunction` and `instructorFunction`
    - _Requirements: 15.1, 16.1_
  - [x] 7.2 Create adminLambdaRole for adminFunction
    - Create new `iam.Role` with SecretsManager (scoped to `db.secretPathTableCreator.secretArn`), EC2 VPC networking, CloudWatch Logs, and Cognito admin permissions
    - Assign to `adminFunction`
    - _Requirements: 15.2, 16.1_
  - [x] 7.3 Create notificationLambdaRole for notificationFunction
    - Create new `iam.Role` with SecretsManager (scoped to `db.secretPathUser.secretArn`), EC2 VPC networking, CloudWatch Logs, and AppSync permissions
    - Assign to `notificationFunction`
    - _Requirements: 15.3, 16.1_
  - [x] 7.4 Create authorizerRole for the three authorizer functions
    - Create new `iam.Role` with SecretsManager (scoped to `this.secret.secretArn`) and CloudWatch Logs only — no EC2 VPC networking
    - Assign to `adminLambdaAuthorizer`, `studentLambdaAuthorizer`, `instructorLambdaAuthorizer`
    - _Requirements: 15.4, 16.1_
  - [x] 7.5 Create cognitoTriggerRole for addStudentOnSignUp and adjustUserRoles
    - Create new `iam.Role` with SecretsManager (scoped to `db.secretPathTableCreator.secretArn`), EC2 VPC networking, CloudWatch Logs, and Cognito admin permissions
    - Assign to `addStudentOnSignUp` and `adjustUserRoles`
    - _Requirements: 15.5, 16.1_
  - [x] 7.6 Create preSignupRole for preSignupLambda
    - Create new `iam.Role` with SSM (scoped to `/AILA/AllowedEmailDomains`) and CloudWatch Logs only — no EC2 VPC networking, no Secrets Manager
    - Assign to `preSignupLambda`
    - _Requirements: 15.6, 16.1_
  - [x] 7.7 Create sqsLambdaRole for sqsFunction
    - Create new `iam.Role` with SecretsManager (scoped to `db.secretPathUser.secretArn`), EC2 VPC networking, CloudWatch Logs, and SQS permissions (scoped to `messagesQueue.queueArn`)
    - Assign to `sqsFunction`
    - _Requirements: 15.7, 16.1_
  - [x] 7.8 Remove the old shared lambdaRole and coglambdaRole
    - Delete the `lambdaRole` (`postgresLambdaRole`) construct and all its policy statements
    - Delete the `coglambdaRole` (`cognitoLambdaRole`) construct and all its policy statements
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

- [x] 8. Scope remaining IAM policies
  - [x] 8.1 Scope Secrets Manager policies to specific secret ARNs
    - Ensure all new per-function-group roles use specific secret ARNs (`.secretArn`) instead of wildcard
    - For `secretPathAdminName` (string), construct ARN as `arn:aws:secretsmanager:${region}:${account}:secret:${secretPathAdminName}-*`
    - Verify no policy statement grants `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:*:*:secret:*`
    - _Requirements: 16.1, 16.2_
  - [x] 8.2 Scope DynamoDB access for textGenLambdaDockerFunc
    - Split DynamoDB policy into two statements: management actions (`ListTables`, `CreateTable`, `DescribeTable`) on `table/*`, and data actions (`PutItem`, `GetItem`, `UpdateItem`) on the specific table ARN
    - _Requirements: 17.1, 17.2_
  - [x] 8.3 Scope CloudWatch Logs policies to specific log groups
    - Replace `arn:aws:logs:*:*:*` with specific log group ARNs (`arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${functionName}:*`) on all roles
    - Also scope the dbFlow-stack lambdaRole logs to `/aws/lambda/${id}-initializerFunction:*`
    - _Requirements: 18.1, 18.2_
  - [x] 8.4 Scope RDS Proxy connect permission in database-stack.ts
    - Change `resources: ['*']` to `arn:aws:rds-db:${region}:${account}:dbuser:${dbInstance.instanceResourceId}/*` on the `rdsProxyRole`
    - _Requirements: 19.1_
  - [x] 8.5 Verify and remove AWS Marketplace permission
    - Check if the AWS account uses Bedrock native access for Claude (not Marketplace subscription)
    - If native access: remove the `aws-marketplace:ViewSubscriptions`, `Subscribe`, `Unsubscribe` policy statement from `textGenLambdaDockerFunc` and `dataIngestLambdaDockerFunc`
    - If Marketplace: keep the permission (document the decision)
    - _Requirements: 20.1_

- [x] 9. Add CDK assertion tests and wire pre-deploy gate
  - [x] 9.1 Create shared test helper at cdk/test/helpers/stack-setup.ts
    - Instantiate all stacks with test context (`StackPrefix: 'Test'`, `environment: 'dev'`)
    - Export `Template.fromStack()` results for apiStack, dbStack, and dbFlowStack
    - _Requirements: 21.1, 22.1, 23.1, 24.1_
  - [x] 9.2 Create cdk/test/iam-policies.test.ts
    - Verify no policy grants `secretsmanager:GetSecretValue` on wildcard secret resource
    - Verify no role has `AmazonS3FullAccess` managed policy
    - Verify no role has `AmazonSSMReadOnlyAccess` managed policy
    - Verify no policy grants `iam:AddUserToGroup`
    - Verify no policy grants CloudWatch Logs actions on `arn:aws:logs:*:*:*`
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5_
  - [x] 9.3 Create cdk/test/s3-buckets.test.ts
    - Verify all S3 buckets have `BlockPublicAccess` set to BLOCK_ALL
    - Verify all S3 buckets enforce SSL (require `aws:SecureTransport`)
    - Verify no S3 bucket has `archiveAccessTierTime` in Intelligent Tiering
    - Verify all S3 buckets have `AbortIncompleteMultipartUpload` lifecycle rule
    - _Requirements: 22.1, 22.2, 22.3, 22.4_
  - [x] 9.4 Create cdk/test/database.test.ts
    - Verify RDS parameter group sets `rds.force_ssl` to `'1'`
    - Verify all 3 RDS proxies have `RequireTLS: true`
    - Verify RDS instance has `PubliclyAccessible: false`
    - Verify RDS instance has `StorageEncrypted: true`
    - _Requirements: 23.1, 23.2, 23.3, 23.4_
  - [x] 9.5 Create cdk/test/lambda-config.test.ts
    - Verify all Node.js Lambda functions use `NODEJS_22_X` runtime
    - Verify all Python Lambda functions use `PYTHON_3_11` runtime
    - _Requirements: 24.1, 24.2_
  - [x] 9.6 Create cdk/test/cognito.test.ts
    - Verify Cognito password policy requires min length 10, lowercase, uppercase, digits, symbols
    - _Requirements: 24.3_
  - [x] 9.7 Create cdk/test/network-security.test.ts
    - Verify WAF WebACL is associated with API Gateway
    - Verify WAF includes `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesSQLiRuleSet`
    - _Requirements: 24.4, 24.5_
  - [x] 9.8 Wire pre-deploy test gate in package.json
    - Add `"predeploy": "npm test"` script to `cdk/package.json`
    - Add `"deploy": "cdk deploy --all"` and `"deploy:prod": "cdk deploy --all -c environment=prod"` scripts
    - Remove or replace the placeholder `cdk/test/cdk.test.ts` file
    - _Requirements: 25.1, 25.2_

- [x] 10. Final checkpoint — Ensure all tests pass
  - Run `npm test` in the `cdk/` directory and verify all CDK assertion tests pass
  - Verify `cdk synth` completes without errors
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks follow the 9-step deployment order from the design document to minimize risk
- S3 changes (Step 1) are zero-risk and fix a latent download-failure bug
- SSL Lambda code changes (Step 4) are deployed before enabling proxy/RDS TLS (Step 6) for zero-downtime migration
- IAM role splitting (Step 7) is done after SSL to avoid coordinating both changes simultaneously
- CDK tests (Step 9) are written last to lock in the final hardened configuration
- Step 5 is a manual deployment checkpoint — verify SSL works in dev before enforcing it
- Docker is required for CDK synthesis tests (two DockerImageCode Lambda functions)
- Each task references specific requirements for traceability
