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
import { DatabaseSizing, POSTGRES_MAJOR_VERSION, sizingFor } from './constants/sizing';

interface DatabaseStackProps extends StackProps {
  environment?: string;
  /** Overrides the sizing profile's database settings. For tests only. */
  database?: Partial<DatabaseSizing>;
}

export class DatabaseStack extends Stack {
    /** The instance the app uses: the original until the P2.1 cutover, then the rebuilt one. */
    public readonly dbInstance: rds.DatabaseInstance;
    /**
     * Identifier of `dbInstance`. After the cutover it's the rebuilt
     * instance's fixed identifier, a plain string, so consumers need no
     * CloudFormation export.
     */
    public readonly dbInstanceIdentifier: string;
    /** `dbInstance`'s class (e.g. `db.t4g.micro`) and allocated storage, for alarms. */
    public readonly dbInstanceClass: string;
    public readonly dbAllocatedStorageGb: number;
    /**
     * Whether consumers still grant `rds-db:connect` on the instance's
     * resource ID. Nothing uses IAM database auth (every client signs in with
     * a Secrets Manager password through the proxy), and the resource ID
     * changes with every rebuild or restore, so the grants go at the cutover.
     */
    public readonly rdsDbConnectGrants: boolean;
    public readonly secretPathAdminName: string;
    public readonly secretPathUser: secretsmanager.Secret;
    public readonly secretPathTableCreator: secretsmanager.Secret;
    /** Endpoint of the single shared RDS Proxy, used by every database client. */
    public readonly rdsProxyEndpoint: string;
    constructor(scope: Construct, id: string, vpcStack: VpcStack, props?: DatabaseStackProps){
        super(scope, id, props);

        const environment = props?.environment || "dev";
        const isProduction = environment === "prod";
        const baseSizing = sizingFor(environment);
        const sizing = { ...baseSizing, database: { ...baseSizing.database, ...props?.database } };
        const rebuild = sizing.database.rebuild;
        const hasOriginalInstance = rebuild !== 'done';
        const hasRebuiltInstance = rebuild !== 'none';
        const cutOver = rebuild === 'cutover' || rebuild === 'done';

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
        const originalAdminSecretName = `${id}-AILA/credentials/rdsDbCredential`; // Name in the Secret Manager to store DB credentials
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

        const rdsProxyRole = new iam.Role(this, `${id}-DBProxyRole`, {
            assumedBy: new iam.ServicePrincipal('rds.amazonaws.com')
        });

        /**
         * The original instance (PostgreSQL 16, 100 GB). The P2.1 rebuild
         * replaces it; it's deleted at the `done` stage.
         */
        let originalInstance: rds.DatabaseInstance | undefined;
        if (hasOriginalInstance) {
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
        originalInstance = new rds.DatabaseInstance(this, `${id}-database`, {
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
                secretName: originalAdminSecretName,
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
            parameterGroup: parameterGroup,
            // Security Hub RDS.10. It used to be switched on implicitly by
            // grantConnect below, which goes away at the cutover.
            iamAuthentication: true,
        });

        // Add CIDR ranges of private subnets to inbound rules of RDS
        const dbSecurityGroup = originalInstance.connections.securityGroups[0];
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
        originalInstance.connections.securityGroups.forEach(function (securityGroup) {
            // Allow Postgres access in VPC
            securityGroup.addIngressRule(
                ec2.Peer.ipv4(vpcStack.vpcCidrString),
                ec2.Port.tcp(5432),
                "Allow PostgreSQL traffic from public subnets"
            );
        });
        }

        /**
         * The rebuilt instance (P2.1): PostgreSQL 17 at the sizing profile's
         * class and storage. It's created standalone of everything that
         * outlives it, so it can be replaced or restored again (Phase 4)
         * without other stacks noticing:
         * - a fixed identifier, so its endpoint and alarm dimensions are stable
         * - its own admin secret (the original's belongs to that instance's
         *   construct and is deleted with it)
         * - a security group shared with the proxy, not owned by the instance
         */
        let rebuiltInstance: rds.DatabaseInstance | undefined;
        let rebuiltAdminSecret: rds.DatabaseSecret | undefined;
        let rebuiltSecurityGroup: ec2.SecurityGroup | undefined;
        const rebuiltIdentifier = `${id}-postgres`.toLowerCase();
        const rebuiltAdminSecretName = `${id}-AILA/credentials/rdsDbCredential-v2`;
        if (hasRebuiltInstance) {
            rebuiltSecurityGroup = new ec2.SecurityGroup(this, `${id}-dbSecurityGroup`, {
                vpc: vpcStack.vpc,
                description: 'PostgreSQL instance and the RDS Proxy in front of it',
            });
            for (const cidr of [vpcStack.vpcCidrString, ...(vpcStack.privateSubnetsCidrStrings ?? [])]) {
                rebuiltSecurityGroup.addIngressRule(
                    ec2.Peer.ipv4(cidr),
                    ec2.Port.tcp(5432),
                    `Allow PostgreSQL traffic from ${cidr}`
                );
            }

            rebuiltAdminSecret = new rds.DatabaseSecret(this, `${id}-adminSecret`, {
                username: secret.secretValueFromJson("DB_Username").unsafeUnwrap(),
                secretName: rebuiltAdminSecretName,
            });

            const engine = rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.of(POSTGRES_MAJOR_VERSION, POSTGRES_MAJOR_VERSION),
            });
            rebuiltInstance = new rds.DatabaseInstance(this, `${id}-postgres`, {
                instanceIdentifier: rebuiltIdentifier,
                vpc: vpcStack.vpc,
                vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
                ...(isProduction ? {} : { availabilityZone: vpcStack.vpc.availabilityZones[0] }),
                securityGroups: [rebuiltSecurityGroup],
                engine,
                instanceType: new ec2.InstanceType(sizing.database.instanceType),
                credentials: rds.Credentials.fromSecret(rebuiltAdminSecret),
                multiAz: false,
                allocatedStorage: sizing.database.allocatedStorageGb,
                maxAllocatedStorage: sizing.database.maxAllocatedStorageGb,
                storageType: rds.StorageType.GP3,
                allowMajorVersionUpgrade: false,
                autoMinorVersionUpgrade: true,
                // Without this, RDS enrolls the instance in paid Extended
                // Support once PostgreSQL 17's standard support ends.
                engineLifecycleSupport: rds.EngineLifecycleSupport.OPEN_SOURCE_RDS_EXTENDED_SUPPORT_DISABLED,
                preferredMaintenanceWindow: sizing.database.preferredMaintenanceWindow,
                // Security Hub RDS.8, RDS.9/36, RDS.10, RDS.11 (same as the original).
                backupRetention: Duration.days(7),
                deleteAutomatedBackups: true,
                deletionProtection: true,
                cloudwatchLogsExports: ['postgresql', 'upgrade'],
                cloudwatchLogsRetention: isProduction ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.TWO_WEEKS,
                iamAuthentication: true,
                databaseName: "aila",
                publiclyAccessible: false,
                storageEncrypted: true,
                monitoringInterval: isProduction ? Duration.seconds(60) : Duration.seconds(0),
                parameterGroup: new rds.ParameterGroup(this, `${id}-postgresParameterGroup`, {
                    engine,
                    description: `PostgreSQL ${POSTGRES_MAJOR_VERSION}: TLS required`,
                    parameters: { 'rds.force_ssl': '1' },
                }),
            });
        }

        const activeInstance = cutOver ? rebuiltInstance! : originalInstance!;
        this.dbInstance = activeInstance;
        this.dbInstanceIdentifier = cutOver ? rebuiltIdentifier : activeInstance.instanceIdentifier;
        this.dbInstanceClass = cutOver
            ? `db.${sizing.database.instanceType}`
            : (isProduction ? 'db.t3.medium' : 'db.t3.micro');
        this.dbAllocatedStorageGb = cutOver ? sizing.database.allocatedStorageGb : 100;
        this.rdsDbConnectGrants = !cutOver;
        this.secretPathAdminName = cutOver ? rebuiltAdminSecretName : originalAdminSecretName;

        // Between the cutover and the original's deletion, other stacks may
        // still import its identifier and resource ID until they're deployed.
        // Pin both exports so DatabaseStack can deploy first.
        if (cutOver && originalInstance) {
            this.exportValue(originalInstance.instanceIdentifier);
            this.exportValue(originalInstance.instanceResourceId);
        }

        if (this.rdsDbConnectGrants) {
            rdsProxyRole.addToPolicy(new iam.PolicyStatement({
                resources: [`arn:aws:rds-db:${this.region}:${this.account}:dbuser:${activeInstance.instanceResourceId}/*`],
                actions: [
                  'rds-db:connect',
                ],
              }));
        }

        const secretPathAdmin = cutOver
            ? rebuiltAdminSecret!
            : secretmanager.Secret.fromSecretNameV2(this, 'AdminSecret', originalAdminSecretName);

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
            proxyTarget: rds.ProxyTarget.fromInstance(activeInstance),
            secrets: [this.secretPathUser, this.secretPathTableCreator, secretPathAdmin],
            vpc: vpcStack.vpc,
            role: rdsProxyRole,
            securityGroups: cutOver ? [rebuiltSecurityGroup!] : activeInstance.connections.securityGroups,
            requireTLS: true,
            idleClientTimeout: Duration.minutes(30),
            maxConnectionsPercent: 100,
            debugLogging: false,
        });

        if (this.rdsDbConnectGrants) {
            activeInstance.grantConnect(rdsProxyRole);
        }
        this.rdsProxyEndpoint = sharedProxy.endpoint;

        /**
         * TEMPORARY (P1.1 deploy 1 of 2): the three per-user proxies this
         * replaces. Nothing in this app uses them any more, but other stacks
         * still import their endpoint exports until those stacks are deployed,
         * and CloudFormation refuses to remove an export that is in use. Kept
         * (same construct IDs, exports pinned) while `sizing.legacyProxies` is
         * true; deploy 2 sets it to false. Delete this block once every
         * environment has run deploy 2. It must run before the P2.1 rebuild:
         * these proxies belong to the original instance.
         */
        if (sizing.legacyProxies) {
            if (!originalInstance || hasRebuiltInstance) {
                throw new Error('DatabaseStack: run P1.1 deploy 2 (legacyProxies: false) before the P2.1 rebuild');
            }
            const legacyProxyProps = {
                vpc: vpcStack.vpc,
                role: rdsProxyRole,
                securityGroups: originalInstance.connections.securityGroups,
                requireTLS: true,
            };
            const legacyProxies = [
                originalInstance.addProxy(id + '-proxy', { ...legacyProxyProps, secrets: [this.secretPathUser] }),
                originalInstance.addProxy(id + '+proxy', { ...legacyProxyProps, secrets: [this.secretPathTableCreator] }),
                originalInstance.addProxy(id + '-proxy-admin', { ...legacyProxyProps, secrets: [secretPathAdmin] }),
            ];
            for (const proxy of legacyProxies) {
                this.exportValue(proxy.endpoint);
            }
        }

    }
}
