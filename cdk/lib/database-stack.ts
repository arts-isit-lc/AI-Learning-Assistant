import { Stack, StackProps, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { VpcStack } from './vpc-stack';

interface DatabaseStackProps extends StackProps {
  environment?: string;
}

export class DatabaseStack extends Stack {
    public readonly dbInstance: rds.DatabaseInstance;
    public readonly secretPathAdminName: string;
    public readonly secretPathUser: secretsmanager.Secret;
    public readonly secretPathTableCreator: secretsmanager.Secret;
    /** Endpoint of the single shared RDS Proxy, used by every database client. */
    public readonly rdsProxyEndpoint: string;
    constructor(scope: Construct, id: string, vpcStack: VpcStack, props?: DatabaseStackProps){
        super(scope, id, props);
        
        const environment = props?.environment || "dev";
        const isProduction = environment === "prod";

        /**
         * 
         * Retrive a secrete from Secret Manager
         * aws secretsmanager create-secret --name AILASecrets --secret-string '{\"DB_Username\":\"DB-USERNAME\"}' --profile <your-profile-name>
         */
        const secret = secretmanager.Secret.fromSecretNameV2(this, "ImportedSecrets", "AILASecrets");
        /**
         * 
         * Create Empty Secret Manager
         * Secrets will be populate at initalization of data
         */
        this.secretPathAdminName = `${id}-AILA/credentials/rdsDbCredential`; // Name in the Secret Manager to store DB credentials        
        const secretPathUserName = `${id}-AILA/userCredentials/rdsDbCredential`;
        this.secretPathUser = new secretsmanager.Secret(this, secretPathUserName, {
            secretName: secretPathUserName,
            description: "Secrets for clients to connect to RDS",
            removalPolicy: RemovalPolicy.DESTROY,
            secretObjectValue: {
                username: SecretValue.unsafePlainText("applicationUsername"),   // this will change later at runtime
                password: SecretValue.unsafePlainText("applicationPassword")    // in the initializer
            }
        })

        const secretPathTableCreator = `${id}-AILA/userCredentials/TableCreator`;
        this.secretPathTableCreator= new secretsmanager.Secret(this, secretPathTableCreator, {
            secretName: secretPathTableCreator,
            description: "Secrets for TableCreator to connect to RDS",
            removalPolicy: RemovalPolicy.DESTROY,
            secretObjectValue: {
                username: SecretValue.unsafePlainText("applicationUsername"),   // this will change later at runtime
                password: SecretValue.unsafePlainText("applicationPassword")    // in the initializer
            }
        })
        const parameterGroup = new rds.ParameterGroup(this, `${id}rdsParameterGroup`, {
            engine: rds.DatabaseInstanceEngine.postgres({
              version: rds.PostgresEngineVersion.VER_16_10,
            }),
            description: "Empty parameter group", // Might need to change this later
            parameters: {
              'rds.force_ssl': '1'
            }
          });

        /**
         * 
         * Create an RDS with Postgres database in an isolated subnet
         */
        this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
            vpc: vpcStack.vpc,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            },
            ...(isProduction ? {} : { availabilityZone: vpcStack.vpc.availabilityZones[0] }),
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_16_10,
            }),
            instanceType: ec2.InstanceType.of(
                ec2.InstanceClass.BURSTABLE3,
                isProduction ? ec2.InstanceSize.MEDIUM : ec2.InstanceSize.MICRO
            ),
            credentials: rds.Credentials.fromUsername(secret.secretValueFromJson("DB_Username").unsafeUnwrap(), {
                secretName: this.secretPathAdminName,
            }),
            multiAz: isProduction,
            allocatedStorage: 100,
            maxAllocatedStorage: 115,
            storageType: rds.StorageType.GP3,
            allowMajorVersionUpgrade: false,
            autoMinorVersionUpgrade: true,
            // Security Hub RDS.11 (>= 7 days) and RDS.8, in both environments.
            // Backup storage is free up to the allocated storage, so 7 days
            // costs nothing extra. Deletion protection means the P2.1 rebuild
            // must switch it off first in dev, just as in prod.
            backupRetention: Duration.days(7),
            deleteAutomatedBackups: true,
            deletionProtection: true,
            databaseName: "aila",
            publiclyAccessible: false,
            // Security Hub RDS.9 / RDS.36. Without the exports, the retention
            // below applied to nothing. The volume is tiny (~100 KB/day in dev).
            cloudwatchLogsExports: ['postgresql', 'upgrade'],
            cloudwatchLogsRetention: isProduction ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.TWO_WEEKS,
            storageEncrypted: true, // storage encryption at rest
            monitoringInterval: isProduction ? Duration.seconds(60) : Duration.seconds(0),
            parameterGroup: parameterGroup
        });

        // Add CIDR ranges of private subnets to inbound rules of RDS
        const dbSecurityGroup = this.dbInstance.connections.securityGroups[0];
        if (vpcStack.privateSubnetsCidrStrings && vpcStack.privateSubnetsCidrStrings.length > 0) {
            vpcStack.privateSubnetsCidrStrings.forEach((cidr) => {
                dbSecurityGroup.addIngressRule(
                    ec2.Peer.ipv4(cidr),
                    ec2.Port.tcp(5432),
                    `Allow PostgreSQL traffic from private subnet CIDR range ${cidr}`
                );
            });
        } else {
            console.log("Deploying with new VPC. No need to add private subnet CIDR ranges to inbound rules of RDS.");
        }

        // Add CIDR ranges of public subnets to inbound rules of RDS
        this.dbInstance.connections.securityGroups.forEach(function (securityGroup) {
            // Allow Postgres access in VPC
            securityGroup.addIngressRule(
                ec2.Peer.ipv4(vpcStack.vpcCidrString),
                ec2.Port.tcp(5432),
                "Allow PostgreSQL traffic from public subnets"
            );
        });
         

        const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
            assumedBy: new iam.ServicePrincipal('rds.amazonaws.com')
        });

        rdsProxyRole.addToPolicy(new iam.PolicyStatement({
            resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:${this.dbInstance.instanceResourceId}/*`],
            actions: [
              'rds-db:connect',
            ],
          }));

        const secretPathAdmin = secretmanager.Secret.fromSecretNameV2(this, 'AdminSecret', this.secretPathAdminName);

        /**
         * One shared RDS Proxy for all three database users (P1.1 in
         * AWS_COST_OPTIMIZATION_PLAN.md). Each client authenticates as its own
         * user and the proxy picks the matching secret, so the app user, the
         * table creator and the master user each keep their own credentials.
         *
         * It's a standalone construct, not `dbInstance.addProxy(...)`: a proxy
         * created by addProxy is a child of the instance, so replacing the
         * instance (the P2.1 rebuild) would replace the proxy and change the
         * endpoint other stacks import. A standalone proxy keeps its endpoint;
         * only its target changes.
         *
         * Settings match the three proxies it replaces (TLS required, 30 min
         * idle client timeout, full connection pool, debug logging off).
         */
        const sharedProxy = new rds.DatabaseProxy(this, `${id}-sharedProxy`, {
            proxyTarget: rds.ProxyTarget.fromInstance(this.dbInstance),
            secrets: [this.secretPathUser, this.secretPathTableCreator, secretPathAdmin],
            vpc: vpcStack.vpc,
            role: rdsProxyRole,
            securityGroups: this.dbInstance.connections.securityGroups,
            requireTLS: true,
            idleClientTimeout: Duration.minutes(30),
            maxConnectionsPercent: 100,
            debugLogging: false,
        });

        this.dbInstance.grantConnect(rdsProxyRole);
        this.rdsProxyEndpoint = sharedProxy.endpoint;

        /**
         * TEMPORARY (P1.1 deploy 1 of 2): the three per-user proxies this
         * replaces. Nothing in this app uses them any more, but other stacks
         * still import their endpoint exports until those stacks are deployed,
         * and CloudFormation refuses to remove an export that is in use. Keep
         * them (same construct IDs) and pin their exports for one deploy, then
         * delete this block in deploy 2.
         */
        const legacyProxyProps = {
            vpc: vpcStack.vpc,
            role: rdsProxyRole,
            securityGroups: this.dbInstance.connections.securityGroups,
            requireTLS: true,
        };
        const legacyProxies = [
            this.dbInstance.addProxy(id + '-proxy', { ...legacyProxyProps, secrets: [this.secretPathUser] }),
            this.dbInstance.addProxy(id + '+proxy', { ...legacyProxyProps, secrets: [this.secretPathTableCreator] }),
            this.dbInstance.addProxy(id + '-proxy-admin', { ...legacyProxyProps, secrets: [secretPathAdmin] }),
        ];
        for (const proxy of legacyProxies) {
            this.exportValue(proxy.endpoint);
        }

    }
}
