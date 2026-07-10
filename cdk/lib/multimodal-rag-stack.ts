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
import {
  SONNET_45,
  HAIKU_45,
  TITAN_EMBED_V2,
  crisInvokeResources,
  inRegionModelResource,
} from "./constants/bedrock";

export class MultimodalRagStack extends cdk.Stack {
  public readonly irBucket: s3.Bucket;
  public readonly embeddingCacheTable: dynamodb.Table;
  public readonly enrichmentCacheTable: dynamodb.Table;
  public readonly enrichmentQueue: sqs.Queue;
  public readonly enrichmentDlq: sqs.Queue;
  public readonly ragIngestionFunction: lambda.DockerImageFunction;
  public readonly ragEnrichmentFunction: lambda.DockerImageFunction;
  public readonly ragRetrievalFunction: lambda.DockerImageFunction;
  public readonly sessionStateTable: dynamodb.Table;
  public readonly chatbotV2Function: lambda.DockerImageFunction;

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
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ["*"],
        },
      ],
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
            // Bedrock InvokeModel — Claude Haiku 4.5 (vision, Geo-US CRIS) + Titan Embed v2
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:InvokeModel"],
              resources: [
                ...crisInvokeResources(HAIKU_45, this.region, this.account),
                inRegionModelResource(TITAN_EMBED_V2, this.region),
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
            // Bedrock InvokeModel — Claude Haiku 4.5 (query analysis + single-image
            // vision escalation) + Claude Sonnet 4.5 (multi-image figure comparison),
            // both via Geo-US CRIS, plus Titan Embed v2 (in-Region).
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:InvokeModel"],
              resources: [
                ...crisInvokeResources(HAIKU_45, this.region, this.account),
                ...crisInvokeResources(SONNET_45, this.region, this.account),
                inRegionModelResource(TITAN_EMBED_V2, this.region),
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
          // Vision model ids injected from constants/bedrock.ts (single source of
          // truth): Haiku 4.5 for single-image escalation, Sonnet 4.5 for the
          // multi-image figure-comparison call. COMPARISON_VISION_MODEL_ID doubles
          // as the runtime kill-switch — repoint it to Haiku 4.5 to disable Sonnet.
          VISION_MODEL_ID: HAIKU_45.profileId,
          COMPARISON_VISION_MODEL_ID: SONNET_45.profileId,
          // Optimization feature flags — all enabled in every environment per
          // operator decision. Each remains instantly revertible: set a flag back
          // to "false" + redeploy. (Behavioral flags ideally pass the eval harness
          // in eval_harness/ before being relied on in prod.)
          QUERY_EMBEDDING_CACHE: "true", // #5: behavior-preserving (cached embeddings)
          RAG_RETURN_PASSAGES: "true", // #1: return passages + skip reasoning LLM (eliminates double generation)
          STRICT_IMAGE_ESCALATION: "true", // #9: gate vision escalation to explicit figure references
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
        reportBatchItemFailures: true,
      })
    );

    // ─── Docker Lambda: Math Compute (SymPy) ────────────────────────────────
    const mathComputeRole = new iam.Role(this, `${id}-mathComputeRole`, {
      roleName: `${id}-mathComputeRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        mathComputePolicy: new iam.PolicyDocument({
          statements: [
            // CloudWatch Logs — scoped to specific log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-mathComputeFunction:*`],
            }),
            // X-Ray — resource '*' acceptable
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    const mathComputeFunction = new lambda.DockerImageFunction(
      this,
      `${id}-mathComputeFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./math_compute", {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 256,
        timeout: Duration.seconds(30),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        functionName: `${id}-mathComputeFunction`,
        role: mathComputeRole,
        environment: {
          REGION: this.region,
        },
      }
    );

    // ─── DynamoDB: Session_State_Table (Chatbot V2 learning session state) ────
    this.sessionStateTable = new dynamodb.Table(this, `${id}-sessionStateTable`, {
      tableName: `${id}-sessionStateTable`,
      partitionKey: {
        name: "session_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── IAM Role: Chatbot V2 Lambda ──────────────────────────────────────────
    // ─── SQS: RDS Projection Queue (#8 — async UI-history projection) ─────────
    // chatbotV2 enqueues here when ASYNC_RDS_PROJECTION is on; a dedicated
    // consumer Lambda writes the relational projection off the response path.
    const rdsProjectionDlq = new sqs.Queue(this, `${id}-rdsProjectionDlq`, {
      queueName: `${id}-rdsProjectionDlq`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const rdsProjectionQueue = new sqs.Queue(this, `${id}-rdsProjectionQueue`, {
      queueName: `${id}-rdsProjectionQueue`,
      visibilityTimeout: Duration.seconds(120),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deadLetterQueue: { queue: rdsProjectionDlq, maxReceiveCount: 3 },
    });

    const chatbotV2Role = new iam.Role(this, `${id}-chatbotV2Role`, {
      roleName: `${id}-chatbotV2Role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        chatbotV2Policy: new iam.PolicyDocument({
          statements: [
            // Bedrock InvokeModel — Claude Sonnet 4.5 (generation) + Claude Haiku 4.5
            // (evaluation), both via Geo-US cross-Region inference profiles.
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
              ],
              resources: [
                ...crisInvokeResources(SONNET_45, this.region, this.account),
                ...crisInvokeResources(HAIKU_45, this.region, this.account),
              ],
            }),
            // Bedrock ApplyGuardrail — required when invoking the model WITH a
            // guardrail (guardrailIdentifier/Version passed to
            // InvokeModelWithResponseStream). Without this, the streamed call
            // fails with AccessDeniedException on bedrock:ApplyGuardrail.
            // The guardrail is created in ApiGatewayStack (which depends on this
            // stack) and its id is resolved at runtime via SSM, so the concrete
            // guardrail ARN is not available at synth here — and a cross-stack
            // grant would create a circular stack dependency. Scope to this
            // account+region's guardrails (documented wildcard on the id only).
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:ApplyGuardrail"],
              resources: [
                `arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`,
              ],
            }),
            // Lambda InvokeFunction — ragRetrievalFunction only
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["lambda:InvokeFunction"],
              resources: [this.ragRetrievalFunction.functionArn, mathComputeFunction.functionArn],
            }),
            // DynamoDB data ops — Session_State_Table (full CRUD)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
              ],
              resources: [this.sessionStateTable.tableArn],
            }),
            // DynamoDB data ops — Chat_History_Table (read + write)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query",
              ],
              resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/DynamoDB-Conversation-Table`,
              ],
            }),
            // DynamoDB management (ListTables, CreateTable, DescribeTable)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:ListTables",
                "dynamodb:CreateTable",
                "dynamodb:DescribeTable",
              ],
              resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/*`,
              ],
            }),
            // Secrets Manager — DB secret (specific ARN)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["secretsmanager:GetSecretValue"],
              resources: [db.secretPathUser.secretArn],
            }),
            // SQS SendMessage — RDS projection queue (#8 async projection enqueue)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["sqs:SendMessage"],
              resources: [rdsProjectionQueue.queueArn],
            }),
            // SSM — guardrail + AppSync URL params (scoped to this environment's path)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter"],
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/AILA/${environment}/*`,
              ],
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
            // CloudWatch Logs — scoped to chatbotV2Function log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-chatbotV2Function:*`,
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
            // AppSync GraphQL mutations (sendChatChunk)
            // TODO: Scope to specific AppSync API ID once cross-stack reference is wired
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["appsync:GraphQL"],
              resources: [
                `arn:aws:appsync:${this.region}:${this.account}:apis/*/types/Mutation/fields/sendChatChunk`,
              ],
            }),
            // AWS Marketplace — for Anthropic model first-time subscription
            // Resource '*' required: Marketplace actions do not support resource-level permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "aws-marketplace:Subscribe",
                "aws-marketplace:Unsubscribe",
                "aws-marketplace:ViewSubscriptions",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // ─── Docker Lambda: Chatbot V2 ───────────────────────────────────────────
    // Diagnostic toggle (DEV-ONLY): when `-c streamGuardrailDisabled=true` is
    // passed at deploy time, detach the Bedrock guardrail from the streaming
    // generation call to measure its time-to-first-token cost (see
    // chatbot_v2/src/flags.py STREAM_GUARDRAIL_DISABLED). While on, streamed
    // output is UNFILTERED, so the flag is hard-gated: the context value is
    // ignored in prod and STREAM_GUARDRAIL_DISABLED is always "false" there.
    const streamGuardrailDisabled =
      !isProd &&
      (this.node.tryGetContext("streamGuardrailDisabled") === true ||
        this.node.tryGetContext("streamGuardrailDisabled") === "true");
    this.chatbotV2Function = new lambda.DockerImageFunction(
      this,
      `${id}-chatbotV2Function`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./chatbot_v2", {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 1024,
        timeout: Duration.seconds(120),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        functionName: `${id}-chatbotV2Function`,
        role: chatbotV2Role,
        vpc: vpc.vpc,
        environment: {
          REGION: this.region,
          RAG_RETRIEVAL_FUNCTION_ARN: this.ragRetrievalFunction.functionArn,
          MATH_COMPUTE_FUNCTION_ARN: mathComputeFunction.functionArn,
          ENABLE_CROSS_MODULE_REFERENCING: "true", // runtime kill switch; set "false" to revert to module_id-only scoping
          SESSION_STATE_TABLE: this.sessionStateTable.tableName,
          CHAT_HISTORY_TABLE: "DynamoDB-Conversation-Table", // TODO: pass from ApiGatewayStack or use env var pattern
          DB_SECRET_ARN: db.secretPathUser.secretArn,
          DB_PROXY_ENDPOINT: db.rdsProxyEndpoint,
          // Resolved at runtime from SSM. The AppSync API and guardrail params are
          // created in ApiGatewayStack (which depends on this stack), so they are
          // referenced by deterministic parameter name rather than passed directly —
          // a direct reference would create a circular cross-stack dependency.
          APPSYNC_API_URL_PARAM: `/AILA/${environment}/AppSyncApiUrl`,
          GUARDRAIL_ID_PARAM: `/AILA/${environment}/GuardrailId`,
          GUARDRAIL_VERSION_PARAM: `/AILA/${environment}/GuardrailVersion`,
          // Optimization feature flags — all enabled in every environment per
          // operator decision. #11 is a safety-posture change (fail closed on a
          // guardrail service error instead of retrying ungated). Each remains
          // instantly revertible: set a flag back to "false" + redeploy.
          CACHE_MODULE_METADATA: "true", // #10: behavior-preserving (cached per-module metadata)
          PARALLEL_EVAL_RETRIEVAL: "true", // #7: run evaluation + retrieval concurrently
          GUARDRAIL_FAIL_CLOSED: "true", // #11: fail closed on guardrail service error (safer posture)
          ASYNC_RDS_PROJECTION: "true", // #8: offload RDS projection to the SQS consumer
          // Rollout flag. Dev-first: ConverseStream + async-guardrail generation
          // is ON in dev (validating the measured ~6.8s guardrail-TTFT win) and
          // OFF in prod until validated. Flip prod to "true" once validated, or
          // set both to "false" to fully revert to the InvokeModel +
          // synchronous-guardrail path.
          USE_CONVERSE_STREAMING: isProd ? "false" : "true",
          RDS_PROJECTION_QUEUE_URL: rdsProjectionQueue.queueUrl,
          // DEV-ONLY diagnostic (default "false"): detach the guardrail from the
          // streaming call to measure its TTFT contribution. Forced "false" in
          // prod (the -c streamGuardrailDisabled context flag is ignored there),
          // so production output is never streamed unfiltered.
          STREAM_GUARDRAIL_DISABLED: String(streamGuardrailDisabled),
        },
      }
    );

    // Override logical ID so OpenAPI spec can reference this Lambda via Fn::Sub
    const cfnChatbotV2Function = this.chatbotV2Function.node
      .defaultChild as lambda.CfnFunction;
    cfnChatbotV2Function.overrideLogicalId("chatbotV2Function");

    // Grant API Gateway permission to invoke this Lambda
    // sourceArn uses wildcard for the API Gateway resource since the API is in a different stack
    this.chatbotV2Function.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/student/chatbot-v2`,
    });

    // ─── IAM Role: RDS Projection Consumer Lambda (#8) ────────────────────────
    // Minimal: write the relational projection (Secrets + RDS Proxy via VPC) and
    // consume from the projection queue. No Bedrock/S3/DynamoDB/Cognito.
    const rdsProjectionConsumerRole = new iam.Role(this, `${id}-rdsProjectionConsumerRole`, {
      roleName: `${id}-rdsProjectionConsumerRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        rdsProjectionConsumerPolicy: new iam.PolicyDocument({
          statements: [
            // Secrets Manager — DB secret (specific ARN)
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
            // CloudWatch Logs — scoped to consumer function log group
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${id}-rdsProjectionConsumerFunction:*`,
              ],
            }),
            // X-Ray — resource '*' acceptable (no resource-level scoping)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
              resources: ["*"],
            }),
            // SQS consume — RDS projection queue
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              resources: [rdsProjectionQueue.queueArn],
            }),
          ],
        }),
      },
    });

    // Reuses the chatbot_v2 image (psycopg2 + rds_projection) with a different CMD.
    const rdsProjectionConsumerFunction = new lambda.DockerImageFunction(
      this,
      `${id}-rdsProjectionConsumerFunction`,
      {
        code: lambda.DockerImageCode.fromImageAsset("./chatbot_v2", {
          cmd: ["rds_projection_consumer.handler"],
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 256,
        timeout: Duration.seconds(60),
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logRetention,
        functionName: `${id}-rdsProjectionConsumerFunction`,
        role: rdsProjectionConsumerRole,
        vpc: vpc.vpc,
        environment: {
          REGION: this.region,
          DB_SECRET_ARN: db.secretPathUser.secretArn,
          DB_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        },
      }
    );

    rdsProjectionConsumerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(rdsProjectionQueue, { batchSize: 10 })
    );

    // Export the Lambda ARN for cross-stack reference (used by ApiGatewayStack OpenAPI spec)
    new cdk.CfnOutput(this, "ChatbotV2FunctionArn", {
      value: this.chatbotV2Function.functionArn,
      exportName: `${id}-chatbotV2FunctionArn`,
    });
  }
}
