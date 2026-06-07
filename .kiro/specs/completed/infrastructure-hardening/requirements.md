# Requirements Document

## Introduction

This document specifies the infrastructure hardening requirements for the AI Learning Assistant (AILA) AWS CDK application. The hardening covers four areas: tightening IAM permissions to enforce least-privilege access, fixing S3 storage policies to eliminate a latent download-failure bug and add cleanup rules, enforcing SSL on all database connections, and adding CDK assertion tests to prevent configuration drift. The implementation follows a 9-step ordered sequence designed to minimize deployment risk.

## Glossary

- **AILA**: AI Learning Assistant — the application being hardened
- **CDK_Stack**: An AWS CDK stack that defines a set of cloud infrastructure resources as code
- **ApiGateway_Stack**: The CDK stack (`api-gateway-stack.ts`) containing Lambda functions, Cognito, S3 buckets, IAM roles, and API Gateway resources
- **DbFlow_Stack**: The CDK stack (`dbFlow-stack.ts`) containing the database initializer Lambda and its IAM role
- **Database_Stack**: The CDK stack (`database-stack.ts`) containing the RDS instance, RDS proxies, and database credentials
- **Lambda_Role**: The shared IAM role (`postgresLambdaRole`) in ApiGateway_Stack used by studentFunction, instructorFunction, adminFunction, notificationFunction, and three authorizer functions
- **CogLambda_Role**: The shared IAM role (`cognitoLambdaRole`) in ApiGateway_Stack used by preSignupLambda, addStudentOnSignUp, adjustUserRoles, and sqsFunction
- **DbFlow_Lambda_Role**: The IAM role in DbFlow_Stack used by the initializer Lambda
- **RDS_Proxy**: An AWS RDS Proxy that sits between Lambda functions and the RDS database instance, managing connection pooling
- **Initializer_Lambda**: A CDK TriggerFunction that runs during deployment to initialize the database schema and credentials
- **Embedding_Storage_Bucket**: The S3 bucket used for temporary per-page text file storage during data ingestion
- **Data_Ingestion_Bucket**: The S3 bucket storing course documents uploaded by instructors
- **Chatlogs_Bucket**: The S3 bucket storing exported chat log CSV files
- **Archive_Access_Tier**: An S3 Intelligent Tiering tier that moves objects to archival storage after a configured period, requiring 3–5 hours to restore before download
- **SSL_Connection**: A database connection using TLS encryption between the client (Lambda) and the server (RDS or RDS Proxy)
- **CDK_Assertion_Test**: A test that synthesizes CDK stacks into CloudFormation templates and verifies resource properties without deploying, using the `aws-cdk-lib/assertions` library

## Requirements

### Requirement 1: Remove Archive Access Tier from S3 Buckets

**User Story:** As a platform operator, I want S3 buckets to not use archive access tiering, so that presigned URL downloads never fail with a 403 InvalidObjectState error when objects have been archived.

#### Acceptance Criteria

1. WHEN the Data_Ingestion_Bucket is synthesized, THE CDK_Stack SHALL configure Intelligent Tiering without an archiveAccessTierTime property
2. WHEN the Chatlogs_Bucket is synthesized, THE CDK_Stack SHALL configure Intelligent Tiering without an archiveAccessTierTime property
3. WHEN the Embedding_Storage_Bucket is synthesized, THE CDK_Stack SHALL configure Intelligent Tiering without an archiveAccessTierTime property

### Requirement 2: Add Orphan Cleanup Lifecycle Rules to Embedding Storage Bucket

**User Story:** As a platform operator, I want orphaned temporary files in the embedding storage bucket to be automatically cleaned up, so that failed Lambda runs do not cause silent storage cost accumulation.

#### Acceptance Criteria

1. THE Embedding_Storage_Bucket SHALL have a lifecycle rule that expires objects after 7 days
2. THE Embedding_Storage_Bucket SHALL have a lifecycle rule that aborts incomplete multipart uploads after 1 day

### Requirement 3: Add Abort Incomplete Multipart Upload to All Buckets

**User Story:** As a platform operator, I want incomplete multipart uploads to be automatically cleaned up on all S3 buckets, so that failed large file uploads do not accumulate invisible storage charges.

#### Acceptance Criteria

1. THE Data_Ingestion_Bucket SHALL have a lifecycle rule that aborts incomplete multipart uploads after 1 day
2. THE Chatlogs_Bucket SHALL have a lifecycle rule that aborts incomplete multipart uploads after 1 day

### Requirement 4: Add Explicit Server-Side Encryption to All Buckets

**User Story:** As a platform operator, I want all S3 buckets to explicitly declare server-side encryption, so that compliance audits can verify encryption at rest from the CDK code.

#### Acceptance Criteria

1. THE Data_Ingestion_Bucket SHALL have encryption set to S3_MANAGED (SSE-S3)
2. THE Embedding_Storage_Bucket SHALL have encryption set to S3_MANAGED (SSE-S3)
3. THE Chatlogs_Bucket SHALL have encryption set to S3_MANAGED (SSE-S3)

### Requirement 5: Remove Unused IAM Permissions from DbFlow Stack

**User Story:** As a security engineer, I want unused managed policies removed from the initializer Lambda role, so that the role follows the principle of least privilege.

#### Acceptance Criteria

1. THE DbFlow_Lambda_Role SHALL NOT have the AmazonS3FullAccess managed policy attached
2. THE DbFlow_Lambda_Role SHALL NOT have the AmazonSSMReadOnlyAccess managed policy attached

### Requirement 6: Remove Unused IAM Permissions from ApiGateway Stack

**User Story:** As a security engineer, I want unused IAM and SES permissions removed from shared Lambda roles, so that no Lambda function has permissions it does not use.

#### Acceptance Criteria

1. THE CogLambda_Role SHALL NOT have a policy statement granting iam:AddUserToGroup
2. THE Lambda_Role SHALL NOT have a policy statement granting ses:SendEmail or ses:SendRawEmail on the notificationFunction
3. THE CogLambda_Role SHALL NOT have a redundant Secrets Manager policy granting secretsmanager:PutSecretValue

### Requirement 7: Scope SSM Parameter Wildcard on CogLambda Role

**User Story:** As a security engineer, I want the SSM parameter access on the Cognito Lambda role scoped to the specific parameter it reads, so that the role cannot read arbitrary SSM parameters.

#### Acceptance Criteria

1. WHEN the CogLambda_Role SSM policy is synthesized, THE CDK_Stack SHALL restrict the ssm:GetParameter resource to the ARN of the /AILA/AllowedEmailDomains parameter only

### Requirement 8: Scope DynamoDB Access for deleteLastMessage

**User Story:** As a security engineer, I want the deleteLastMessage Lambda's DynamoDB access scoped to the specific conversation table, so that it cannot access arbitrary DynamoDB tables.

#### Acceptance Criteria

1. WHEN the deleteLastMessage DynamoDB policy is synthesized, THE CDK_Stack SHALL restrict dynamodb:GetItem and dynamodb:UpdateItem resources to the specific DynamoDB conversation table ARN
2. WHEN the deleteLastMessage DynamoDB policy is synthesized, THE CDK_Stack SHALL include the SSM-derived table name parameter in the resource ARN construction

### Requirement 9: Add SSL Parameters to Node.js Lambda Database Connections

**User Story:** As a security engineer, I want all Node.js Lambda functions to connect to the database using SSL, so that data in transit between Lambda and RDS Proxy is encrypted.

#### Acceptance Criteria

1. WHEN the lib.js connection is initialized, THE Lambda_Function SHALL set the ssl property to 'require' in the postgres connection configuration
2. WHEN the libadmin.js connection is initialized, THE Lambda_Function SHALL set the ssl property to 'require' in the postgres connection configuration

### Requirement 10: Add SSL Parameters to Python Lambda Database Connections Using psycopg2

**User Story:** As a security engineer, I want all Python Lambda functions using psycopg2 to connect to the database using SSL, so that data in transit is encrypted.

#### Acceptance Criteria

1. WHEN deleteFile.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters
2. WHEN deleteLastMessage.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters
3. WHEN getFilesFunction.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters
4. WHEN sqsTrigger main.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters
5. WHEN text_generation main.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters
6. WHEN data_ingestion main.py connects to the database, THE Lambda_Function SHALL include sslmode=require in the connection parameters

### Requirement 11: Add SSL Parameters to Python SQLAlchemy and Raw psycopg2 Connections

**User Story:** As a security engineer, I want all SQLAlchemy URI-based and raw psycopg2 connection strings to include SSL mode, so that every database connection path in the application is encrypted.

#### Acceptance Criteria

1. WHEN data_ingestion helper.py constructs a SQLAlchemy connection URI, THE Lambda_Function SHALL append sslmode=require as a query parameter
2. WHEN text_generation helper.py constructs a SQLAlchemy connection URI, THE Lambda_Function SHALL append sslmode=require as a query parameter
3. WHEN text_generation vectorstore.py constructs a raw psycopg2 connection string, THE Lambda_Function SHALL include sslmode=require in the connection string

### Requirement 12: Uncomment SSL in Initializer Lambda

**User Story:** As a security engineer, I want the initializer Lambda to use SSL when connecting directly to the RDS instance, so that the database initialization connection is encrypted.

#### Acceptance Criteria

1. WHEN initializer.py connects to the RDS instance, THE Initializer_Lambda SHALL use sslmode=require in the psycopg2 connection call (uncomment the existing commented-out parameter)

### Requirement 13: Enable TLS on RDS Proxies

**User Story:** As a security engineer, I want all three RDS proxies to require TLS from Lambda clients, so that unencrypted connections to the proxy are rejected.

#### Acceptance Criteria

1. WHEN the rdsProxy is synthesized, THE Database_Stack SHALL set requireTLS to true
2. WHEN the rdsProxyTableCreator is synthesized, THE Database_Stack SHALL set requireTLS to true
3. WHEN the rdsProxyAdmin is synthesized, THE Database_Stack SHALL set requireTLS to true

### Requirement 14: Enable RDS Force SSL

**User Story:** As a security engineer, I want the RDS instance to reject all non-SSL connections, so that no unencrypted database connection is possible.

#### Acceptance Criteria

1. WHEN the RDS parameter group is synthesized, THE Database_Stack SHALL set the rds.force_ssl parameter to '1'

### Requirement 15: Split Shared Lambda Role into Per-Function-Group Roles

**User Story:** As a security engineer, I want each Lambda function group to have its own IAM role with only the permissions it needs, so that a compromised function cannot access resources belonging to other functions.

#### Acceptance Criteria

1. THE CDK_Stack SHALL create a dbLambdaRole for studentFunction and instructorFunction with only Secrets Manager (secretPathUser), EC2 VPC networking, and CloudWatch Logs permissions
2. THE CDK_Stack SHALL create an adminLambdaRole for adminFunction with Secrets Manager (secretPathTableCreator), EC2 VPC networking, CloudWatch Logs, and Cognito admin permissions
3. THE CDK_Stack SHALL create a notificationLambdaRole for notificationFunction with Secrets Manager (secretPathUser), EC2 VPC networking, CloudWatch Logs, and AppSync permissions
4. THE CDK_Stack SHALL create an authorizerRole for the three authorizer functions with only Secrets Manager (Cognito secret) and CloudWatch Logs permissions, without EC2 VPC networking
5. THE CDK_Stack SHALL create a cognitoTriggerRole for addStudentOnSignUp and adjustUserRoles with Secrets Manager (secretPathTableCreator), EC2 VPC networking, CloudWatch Logs, and Cognito admin permissions
6. THE CDK_Stack SHALL create a preSignupRole for preSignupLambda with only SSM (AllowedEmailDomains parameter) and CloudWatch Logs permissions
7. THE CDK_Stack SHALL create an sqsLambdaRole for sqsFunction with Secrets Manager (secretPathUser), EC2 VPC networking, CloudWatch Logs, and SQS permissions

### Requirement 16: Scope Secrets Manager Policies to Specific Secret ARNs

**User Story:** As a security engineer, I want each IAM role's Secrets Manager access scoped to the specific secrets its functions read, so that no role can access arbitrary secrets in the account.

#### Acceptance Criteria

1. WHEN a per-function-group role grants secretsmanager:GetSecretValue, THE CDK_Stack SHALL restrict the resource to the specific secret ARN(s) that the role's functions access
2. THE CDK_Stack SHALL NOT have any policy statement granting secretsmanager:GetSecretValue on arn:aws:secretsmanager:*:*:secret:*

### Requirement 17: Scope DynamoDB Access for textGenLambdaDockerFunc

**User Story:** As a security engineer, I want the text generation Lambda's DynamoDB access split into management actions on all tables and data actions on the specific conversation table, so that data-plane access is restricted.

#### Acceptance Criteria

1. WHEN the textGenLambdaDockerFunc DynamoDB policy is synthesized, THE CDK_Stack SHALL grant dynamodb:ListTables, dynamodb:CreateTable, and dynamodb:DescribeTable on all table resources
2. WHEN the textGenLambdaDockerFunc DynamoDB policy is synthesized, THE CDK_Stack SHALL grant dynamodb:PutItem, dynamodb:GetItem, and dynamodb:UpdateItem only on the specific conversation table ARN

### Requirement 18: Scope CloudWatch Logs Policies to Specific Log Groups

**User Story:** As a security engineer, I want CloudWatch Logs permissions scoped to the specific log groups each role's functions write to, so that no role can write to arbitrary log groups.

#### Acceptance Criteria

1. WHEN a per-function-group role grants logs:CreateLogGroup, logs:CreateLogStream, and logs:PutLogEvents, THE CDK_Stack SHALL restrict the resource to the specific log group ARN(s) for the functions using that role
2. THE CDK_Stack SHALL NOT have any policy statement granting CloudWatch Logs actions on arn:aws:logs:*:*:*

### Requirement 19: Scope RDS Proxy Connect Permission

**User Story:** As a security engineer, I want the RDS Proxy IAM role's connect permission scoped to the specific database resource, so that the role cannot connect to arbitrary RDS instances.

#### Acceptance Criteria

1. WHEN the rdsProxyRole policy is synthesized, THE Database_Stack SHALL restrict rds-db:connect to the specific DB instance resource ID ARN instead of using a wildcard resource

### Requirement 20: Verify and Remove AWS Marketplace Permission

**User Story:** As a security engineer, I want the AWS Marketplace permission verified and removed if the account uses Bedrock native model access, so that unnecessary broad permissions are eliminated.

#### Acceptance Criteria

1. IF the AWS account uses Bedrock native access for Claude (not a Marketplace subscription), THEN THE CDK_Stack SHALL remove the aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe, and aws-marketplace:Unsubscribe policy statement from textGenLambdaDockerFunc and dataIngestLambdaDockerFunc

### Requirement 21: Add CDK Assertion Tests for IAM Policy Guardrails

**User Story:** As a developer, I want CDK assertion tests that verify IAM policies follow least-privilege rules, so that future changes cannot accidentally reintroduce overly broad permissions.

#### Acceptance Criteria

1. THE CDK_Assertion_Test suite SHALL verify that no IAM policy grants secretsmanager:GetSecretValue on a wildcard secret resource
2. THE CDK_Assertion_Test suite SHALL verify that no IAM role has the AmazonS3FullAccess managed policy attached
3. THE CDK_Assertion_Test suite SHALL verify that no IAM role has the AmazonSSMReadOnlyAccess managed policy attached
4. THE CDK_Assertion_Test suite SHALL verify that no IAM policy grants iam:AddUserToGroup
5. THE CDK_Assertion_Test suite SHALL verify that no IAM policy grants CloudWatch Logs actions on arn:aws:logs:*:*:*

### Requirement 22: Add CDK Assertion Tests for S3 Bucket Security

**User Story:** As a developer, I want CDK assertion tests that verify S3 bucket security configuration, so that storage policy regressions are caught before deployment.

#### Acceptance Criteria

1. THE CDK_Assertion_Test suite SHALL verify that all S3 buckets have BlockPublicAccess set to BLOCK_ALL
2. THE CDK_Assertion_Test suite SHALL verify that all S3 buckets enforce SSL (require aws:SecureTransport)
3. THE CDK_Assertion_Test suite SHALL verify that no S3 bucket has an archiveAccessTierTime in its Intelligent Tiering configuration
4. THE CDK_Assertion_Test suite SHALL verify that all S3 buckets have an AbortIncompleteMultipartUpload lifecycle rule

### Requirement 23: Add CDK Assertion Tests for Database Security

**User Story:** As a developer, I want CDK assertion tests that verify database security configuration, so that SSL enforcement and proxy TLS settings cannot regress.

#### Acceptance Criteria

1. THE CDK_Assertion_Test suite SHALL verify that the RDS parameter group sets rds.force_ssl to '1'
2. THE CDK_Assertion_Test suite SHALL verify that all three RDS proxies have requireTLS set to true
3. THE CDK_Assertion_Test suite SHALL verify that the RDS instance has publiclyAccessible set to false
4. THE CDK_Assertion_Test suite SHALL verify that the RDS instance has storageEncrypted set to true

### Requirement 24: Add CDK Assertion Tests for Lambda, Cognito, and Network Security

**User Story:** As a developer, I want CDK assertion tests covering Lambda runtime consistency, Cognito password policy, and network security, so that configuration drift across the full stack is detected.

#### Acceptance Criteria

1. THE CDK_Assertion_Test suite SHALL verify that all Node.js Lambda functions use the NODEJS_22_X runtime
2. THE CDK_Assertion_Test suite SHALL verify that all Python Lambda functions use the PYTHON_3_11 runtime
3. THE CDK_Assertion_Test suite SHALL verify that the Cognito user pool password policy requires minimum length 10, lowercase, uppercase, digits, and symbols
4. THE CDK_Assertion_Test suite SHALL verify that a WAF WebACL is associated with the API Gateway
5. THE CDK_Assertion_Test suite SHALL verify that the WAF includes AWSManagedRulesCommonRuleSet and AWSManagedRulesSQLiRuleSet rules

### Requirement 25: Wire CDK Tests into Deployment Flow

**User Story:** As a developer, I want CDK tests to run automatically before every deployment, so that infrastructure regressions are caught before they reach AWS.

#### Acceptance Criteria

1. WHEN a developer runs the deploy command, THE Build_System SHALL execute npm test before initiating the CDK deployment
2. IF any CDK assertion test fails, THEN THE Build_System SHALL abort the deployment and report the failure
