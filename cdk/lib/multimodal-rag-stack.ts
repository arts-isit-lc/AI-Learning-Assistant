import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { DatabaseStack } from "./database-stack";
import { VpcStack } from "./vpc-stack";

export class MultimodalRagStack extends cdk.Stack {
  public readonly irBucket: s3.Bucket;
  public readonly embeddingCacheTable: dynamodb.Table;
  public readonly enrichmentCacheTable: dynamodb.Table;
  public readonly enrichmentQueue: sqs.Queue;
  public readonly enrichmentDlq: sqs.Queue;
  public readonly ragIngestionFunction: lambda.DockerImageFunction;
  public readonly ragEnrichmentFunction: lambda.DockerImageFunction;
  public readonly ragRetrievalFunction: lambda.DockerImageFunction;

  constructor(
    scope: Construct,
    id: string,
    db: DatabaseStack,
    vpc: VpcStack,
    props?: cdk.StackProps & { environment?: string }
  ) {
    super(scope, id, props);

    const environment = props?.environment || "dev";
    const isProd = environment === "prod";
    const logRetention = isProd
      ? logs.RetentionDays.THREE_MONTHS
      : logs.RetentionDays.ONE_MONTH;

    // ─── S3: IR Persistence Bucket ────────────────────────────────────────────
    this.irBucket = new s3.Bucket(this, `${id}-irBucket`, {
      bucketName: `${id}-ir-bucket`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
      enforceSSL: true,
    });

    // ─── DynamoDB: EmbeddingCache Table ───────────────────────────────────────
    this.embeddingCacheTable = new dynamodb.Table(
      this,
      `${id}-embeddingCacheTable`,
      {
        tableName: `${id}-embeddingCacheTable`,
        partitionKey: {
          name: "content_hash",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "embedding_version",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // ─── DynamoDB: EnrichmentCache Table ──────────────────────────────────────
    this.enrichmentCacheTable = new dynamodb.Table(
      this,
      `${id}-enrichmentCacheTable`,
      {
        tableName: `${id}-enrichmentCacheTable`,
        partitionKey: {
          name: "content_hash",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "sort_key",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // ─── SQS: Enrichment Queue (decouples ingestion → enrichment) ─────────────
    this.enrichmentDlq = new sqs.Queue(this, `${id}-enrichmentDlq`, {
      queueName: `${id}-enrichmentDlq`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.enrichmentQueue = new sqs.Queue(this, `${id}-enrichmentQueue`, {
      queueName: `${id}-enrichmentQueue`,
      visibilityTimeout: Duration.seconds(900),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deadLetterQueue: {
        queue: this.enrichmentDlq,
        maxReceiveCount: 3,
      },
    });

    // ─── IAM Role: Ingestion Lambda ──────────────────────────────────────────
    const ragIngestionRole = new iam.Role(this, `${id}-ragIngestionRole`, {
      roleName: `${id}-ragIngestionRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        ragIngestionPolicy: new iam.PolicyDocument({
          statements: [
            // S3 GetObject on source bucket (courses/* prefix)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetObject"],
              resources: [`${this.irBucket.bucketArn}/courses/*`],
            }),
            // S3 PutObject on IR bucket (for persisting DocumentIR)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:PutObject"],
              resources: [`${this.irBucket.bucketArn}/*`],
            }),
            // CloudWatch Logs scoped to ingestion function log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-ragIngestionFunction:*`,
              ],
            }),
            // X-Ray — resource '*' acceptable (service does not support resource-level scoping)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
              ],
              resources: ["*"],
            }),
            // SQS SendMessage to enrichment queue
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["sqs:SendMessage"],
              resources: [this.enrichmentQueue.queueArn],
            }),
          ],
        }),
      },
    });

    // ─── IAM Role: Enrichment Lambda ──────────────────────────────────────────
    const ragEnrichmentRole = new iam.Role(this, `${id}-ragEnrichmentRole`, {
      roleName: `${id}-ragEnrichmentRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        ragEnrichmentPolicy: new iam.PolicyDocument({
          statements: [
            // S3 GetObject on IR bucket (load DocumentIR for enrichment)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetObject"],
              resources: [this.irBucket.bucketArn, `${this.irBucket.bucketArn}/*`],
            }),
            // Bedrock InvokeModel — Claude 3 Haiku (vision) + Titan Embed v2
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:InvokeModel"],
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
              ],
            }),
            // DynamoDB GetItem/PutItem on EmbeddingCache table
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [this.embeddingCacheTable.tableArn],
            }),
            // DynamoDB GetItem/PutItem on EnrichmentCache table
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [this.enrichmentCacheTable.tableArn],
            }),
            // Secrets Manager — specific DB secret ARN
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["secretsmanager:GetSecretValue"],
              resources: [db.secretPathUser.secretArn],
            }),
            // EC2 VPC networking — resource '*' required by AWS for ENI operations
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface",
                "ec2:AssignPrivateIpAddresses",
                "ec2:UnassignPrivateIpAddresses",
              ],
              resources: ["*"],
            }),
            // RDS Proxy connect — specific instance resource ID
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["rds-db:connect"],
              resources: [
                `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${db.dbInstance.instanceResourceId}/*`,
              ],
            }),
            // CloudWatch Logs scoped to enrichment function log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-ragEnrichmentFunction:*`,
              ],
            }),
            // X-Ray — resource '*' acceptable (service does not support resource-level scoping)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
              ],
              resources: ["*"],
            }),
            // SQS ReceiveMessage/DeleteMessage/GetQueueAttributes on enrichment queue
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              resources: [this.enrichmentQueue.queueArn],
            }),
          ],
        }),
      },
    });

    // ─── IAM Role: Retrieval + Reasoning Lambda ───────────────────────────────
    const ragRetrievalRole = new iam.Role(this, `${id}-ragRetrievalRole`, {
      roleName: `${id}-ragRetrievalRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        ragRetrievalPolicy: new iam.PolicyDocument({
          statements: [
            // Bedrock InvokeModel — Claude 3 Haiku (query analysis + reasoning) + Titan Embed v2
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:InvokeModel"],
              resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
              ],
            }),
            // DynamoDB GetItem on EmbeddingCache table (read-only for retrieval)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["dynamodb:GetItem"],
              resources: [this.embeddingCacheTable.tableArn],
            }),
            // Secrets Manager — specific DB secret ARN
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["secretsmanager:GetSecretValue"],
              resources: [db.secretPathUser.secretArn],
            }),
            // EC2 VPC networking — resource '*' required by AWS for ENI operations
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface",
                "ec2:AssignPrivateIpAddresses",
                "ec2:UnassignPrivateIpAddresses",
              ],
              resources: ["*"],
            }),
            // RDS Proxy connect — specific instance resource ID
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["rds-db:connect"],
              resources: [
                `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${db.dbInstance.instanceResourceId}/*`,
              ],
            }),
            // S3 GetObject on IR bucket (for image escalation)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetObject"],
              resources: [this.irBucket.bucketArn, `${this.irBucket.bucketArn}/*`],
            }),
            // CloudWatch Logs scoped to retrieval function log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-ragRetrievalFunction:*`,
              ],
            }),
            // X-Ray — resource '*' acceptable (service does not support resource-level scoping)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // ─── Docker Lambda: Ingestion ─────────────────────────────────────────────
    this.ragIngestionFunction = new lambda.DockerImageFunction(
      this,
      `${id}-ragIngestionFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./multimodal_rag_v2", {
          cmd: ["multimodal_rag_v2.ingestion.handler.handler"],
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 1024,
        timeout: Duration.seconds(300),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        functionName: `${id}-ragIngestionFunction`,
        role: ragIngestionRole,
        environment: {
          IR_BUCKET_NAME: this.irBucket.bucketName,
          ENRICHMENT_QUEUE_URL: this.enrichmentQueue.queueUrl,
          REGION: this.region,
        },
      }
    );

    // ─── Docker Lambda: Enrichment ────────────────────────────────────────────
    this.ragEnrichmentFunction = new lambda.DockerImageFunction(
      this,
      `${id}-ragEnrichmentFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./multimodal_rag_v2", {
          cmd: ["multimodal_rag_v2.enrichment.handler.handler"],
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 2048,
        timeout: Duration.seconds(900),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        vpc: vpc.vpc,
        functionName: `${id}-ragEnrichmentFunction`,
        role: ragEnrichmentRole,
        environment: {
          IR_BUCKET_NAME: this.irBucket.bucketName,
          EMBEDDING_CACHE_TABLE: this.embeddingCacheTable.tableName,
          ENRICHMENT_CACHE_TABLE: this.enrichmentCacheTable.tableName,
          DB_SECRET_ARN: db.secretPathUser.secretArn,
          DB_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          REGION: this.region,
        },
      }
    );

    // ─── Docker Lambda: Retrieval + Reasoning ─────────────────────────────────
    this.ragRetrievalFunction = new lambda.DockerImageFunction(
      this,
      `${id}-ragRetrievalFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./multimodal_rag_v2", {
          cmd: ["multimodal_rag_v2.retrieval.handler.handler"],
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 1024,
        timeout: Duration.seconds(60),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        vpc: vpc.vpc,
        functionName: `${id}-ragRetrievalFunction`,
        role: ragRetrievalRole,
        environment: {
          EMBEDDING_CACHE_TABLE: this.embeddingCacheTable.tableName,
          DB_SECRET_ARN: db.secretPathUser.secretArn,
          DB_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          IR_BUCKET_NAME: this.irBucket.bucketName,
          REGION: this.region,
        },
      }
    );

    // ─── S3 Event Notification → Ingestion Lambda (courses/ prefix) ───────────
    this.ragIngestionFunction.addEventSource(
      new lambdaEventSources.S3EventSource(this.irBucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: "courses/" }],
      })
    );

    // ─── SQS Event Source → Enrichment Lambda ─────────────────────────────────
    this.ragEnrichmentFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(this.enrichmentQueue, {
        batchSize: 1,
      })
    );
  }
}
