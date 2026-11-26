import { ArnFormat, Aspects, Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import { EnvironmentSizing, NAT_INSTANCE_AMI, sizingFor } from "./constants/sizing";
import { Fn } from "aws-cdk-lib";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";

interface VpcStackProps extends StackProps {
  environment?: string;
  /** Overrides the sizing profile. For tests only. */
  sizing?: Partial<EnvironmentSizing>;
}

export class VpcStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcCidrString: string;
  public readonly privateSubnetsCidrStrings: string[];

  constructor(scope: Construct, id: string, props?: VpcStackProps) {
    super(scope, id, props);

    const environment = props?.environment || "dev";
    const isProduction = environment === "prod";
    const sizing = { ...sizingFor(environment), ...props?.sizing };

    const existingVpcId: string = ""; // CHANGE IF DEPLOYING WITH EXISTING VPC

    if (existingVpcId !== "") {
      const AWSControlTowerStackSet = ""; // CHANGE TO YOUR CONTROL TOWER STACK SET

      const existingPublicSubnetID: string = "" // CHANGE IF DEPLOYING WITH EXISTING PUBLIC SUBNET

      const ailaPrefix = "AI-LEARNING-ASSISTANT-production";

      this.vpcCidrString = "172.31.94.0/20";

      // VPC for application
      this.vpc = ec2.Vpc.fromVpcAttributes(this, `${id}-Vpc`, {
        vpcId: existingVpcId,
        availabilityZones: ["ca-central-1a", "ca-central-1b", "ca-central-1d"],
        privateSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        privateSubnetRouteTableIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`),
        ],
        isolatedSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        isolatedSubnetRouteTableIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`),
        ],
        vpcCidrBlock: Fn.importValue(`${AWSControlTowerStackSet}-VPCCIDR`),
      }) as ec2.Vpc;

      // Extract CIDR ranges from the private subnets
      this.privateSubnetsCidrStrings = [
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ACIDR`),
      ];

      if (existingPublicSubnetID === "") {
        console.log("No public subnet exists. Creating new public subnet, IGW, and NAT GW.");

        // Create a public subnet
        const publicSubnet = new ec2.Subnet(this, `PublicSubnet`, {
          vpcId: this.vpc.vpcId,
          availabilityZone: this.vpc.availabilityZones[0],
          cidrBlock: this.vpcCidrString,
          mapPublicIpOnLaunch: true,
        });

        // Create an Internet Gateway and attach it to the VPC
        const internetGateway = new ec2.CfnInternetGateway(this, `InternetGateway`, {});
        new ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
          vpcId: this.vpc.vpcId,
          internetGatewayId: internetGateway.ref,
        });

        // Add a NAT Gateway in the public subnet
        const natGateway = new ec2.CfnNatGateway(this, `NatGateway`, {
          subnetId: publicSubnet.subnetId,
          allocationId: new ec2.CfnEIP(this, "EIP", {}).attrAllocationId,
        });

        // Use the route table associated with the public subnet
        const publicRouteTableId = publicSubnet.routeTable.routeTableId;

        // Add a route to the Internet Gateway in the existing public route table
        new ec2.CfnRoute(this, `PublicRoute`, {
          routeTableId: publicRouteTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: internetGateway.ref,
        });

        // Update route table for private subnets
        new ec2.CfnRoute(this, `${ailaPrefix}PrivateSubnetRoute1`, {
          routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${ailaPrefix}PrivateSubnetRoute2`, {
          routeTableId: this.vpc.privateSubnets[1].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${ailaPrefix}PrivateSubnetRoute3`, {
          routeTableId: this.vpc.privateSubnets[2].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });
      } else {
        console.log(`Public subnet already exists. Skipping creation of public resources.`);
      }

      // Add interface endpoints for private isolated subnets
      this.vpc.addInterfaceEndpoint("SSM Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.vpc.addInterfaceEndpoint("Secrets Manager Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.vpc.addInterfaceEndpoint("RDS Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.RDS,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.vpc.addInterfaceEndpoint("Glue Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.GLUE,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.grantFlowLogDescribeLogStreams(this.vpc.addFlowLog(`${id}-vpcFlowLog`));

      // Get default security group for VPC
      const defaultSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        id,
        this.vpc.vpcDefaultSecurityGroup
      );
    } else {
      this.vpcCidrString = "10.0.0.0/16";

      // P2.2: a NAT instance instead of the NAT Gateway (~$37/mo of hourly
      // charges for under 5 cents of data). Chat already depends on NAT for
      // AppSync, and there was only ever one NAT Gateway, in one AZ.
      const natInstanceProvider = sizing.nat === "instance"
        ? ec2.NatProvider.instanceV2({
            instanceType: new ec2.InstanceType(sizing.natInstanceType),
            // Pinned (see NAT_INSTANCE_AMI): an unpinned "latest" AMI would
            // replace the instance, and cut egress, on any deploy after a release.
            machineImage: ec2.MachineImage.genericLinux(NAT_INSTANCE_AMI),
            associatePublicIpAddress: true,
            // The default also allows inbound traffic from anywhere.
            defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
            // CDK's default user data finds the interface with `route`
            // (net-tools); this uses `ip route` instead.
            userData: natInstanceUserData(),
          })
        : undefined;
      const natGatewayProvider = natInstanceProvider ?? ec2.NatProvider.gateway();

      // VPC for application
      this.vpc = new ec2.Vpc(this, "aila-Vpc", {
        ipAddresses: ec2.IpAddresses.cidr(this.vpcCidrString),
        natGatewayProvider: natGatewayProvider,
        natGateways: 1,
        maxAzs: 2,
        subnetConfiguration: [
          {
            name: "public-subnet-1",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: "isolated-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });

      if (natInstanceProvider) {
        this.configureNatInstance(natInstanceProvider, environment);
      }

      // CO-8b: VPC Flow Logs with retention limits
      const flowLogGroup = new logs.LogGroup(this, "aila-vpcFlowLogGroup", {
        retention: isProduction ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
      });

      this.grantFlowLogDescribeLogStreams(
        this.vpc.addFlowLog("aila-vpcFlowLog", {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
        })
      );

      // Interface endpoints, ~$16/mo each for two AZs. Their private DNS
      // applies VPC-wide, so every Lambda uses them today. P2.3 removes them;
      // the calls then go out through NAT, which chat already depends on.
      if (sizing.interfaceEndpoints) {
      // Add secrets manager endpoint to VPC
      this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
      }

      // CO-3: RDS endpoint removed — unused, Lambdas connect to RDS Proxy via TCP

      // CO-1: Add S3 and DynamoDB gateway endpoints (free, reduces NAT traffic)
      this.vpc.addGatewayEndpoint("S3Endpoint", {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });
      this.vpc.addGatewayEndpoint("DynamoDBEndpoint", {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      });

      // P-1: Bedrock Runtime VPC endpoint — keeps all Bedrock calls (embeddings + LLM)
      // on the AWS backbone instead of routing through NAT Gateway.
      if (sizing.interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      });
      }
    }
  }

  /**
   * Hardening, recovery and patching for the NAT instance (P2.2): inbound only
   * from the VPC, IMDSv2, EC2 recover/reboot on failed status checks, and a
   * weekly Patch Manager run through SSM.
   */
  /**
   * CDK grants a CloudWatch Logs flow log's role logs:DescribeLogStreams only
   * on `log-group:<name>:*`, a log-stream ARN. From 2027-04-26 CloudWatch Logs
   * stops granting log-group actions via that ARN, so also grant it on the
   * bare log group ARN. Remove once aws-cdk-lib does this itself.
   */
  private grantFlowLogDescribeLogStreams(flowLog: ec2.FlowLog) {
    if (!flowLog.iamRole || !flowLog.logGroup) return;
    flowLog.iamRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:DescribeLogStreams"],
        resources: [
          Stack.of(this).formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: flowLog.logGroup.logGroupName,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      })
    );
  }

  private configureNatInstance(provider: ec2.NatInstanceProviderV2, environment: string) {
    provider.connections.allowFrom(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      "Outbound traffic from the VPC"
    );
    Aspects.of(this.vpc).add(new ec2.InstanceRequireImdsv2Aspect());

    provider.gatewayInstances.forEach((instance, i) => {
      instance.role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
      );
      const statusCheck = (metricName: string) =>
        new cloudwatch.Metric({
          namespace: "AWS/EC2",
          metricName,
          dimensionsMap: { InstanceId: instance.instanceId },
          statistic: "Maximum",
          period: Duration.minutes(1),
        });
      new cloudwatch.Alarm(this, `NatInstance${i}SystemCheck`, {
        alarmName: `AILA-${environment}-NatInstance${i}-SystemCheck-Recover`,
        alarmDescription: "NAT instance failed its system status check: EC2 recovers it onto new hardware.",
        metric: statusCheck("StatusCheckFailed_System"),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
      }).addAlarmAction(new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.RECOVER));
      new cloudwatch.Alarm(this, `NatInstance${i}InstanceCheck`, {
        alarmName: `AILA-${environment}-NatInstance${i}-InstanceCheck-Reboot`,
        alarmDescription: "NAT instance failed its instance status check: EC2 reboots it.",
        metric: statusCheck("StatusCheckFailed_Instance"),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
      }).addAlarmAction(new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.REBOOT));
      // Weekly patching, Sunday 10:00 UTC (early morning in Vancouver). A
      // reboot, if one is needed, interrupts egress for about a minute.
      new ssm.CfnAssociation(this, `NatInstance${i}Patching`, {
        name: "AWS-RunPatchBaseline",
        associationName: `AILA-${environment}-NatInstance${i}-Patching`,
        scheduleExpression: "cron(0 10 ? * SUN *)",
        applyOnlyAtCronInterval: true,
        parameters: { Operation: ["Install"], RebootOption: ["RebootIfNeeded"] },
        targets: [{ key: "InstanceIds", values: [instance.instanceId] }],
      });
    });
  }
}

/** NAT setup for Amazon Linux 2023 (the same steps as CDK's default). */
function natInstanceUserData(): ec2.UserData {
  const userData = ec2.UserData.forLinux();
  userData.addCommands(
    "dnf install -y iptables-services",
    "systemctl enable --now iptables",
    'echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/custom-ip-forwarding.conf',
    "sysctl -p /etc/sysctl.d/custom-ip-forwarding.conf",
    "IFACE=$(ip route show default | awk '{print $5; exit}')",
    'iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE',
    "iptables -F FORWARD",
    "service iptables save",
  );
  return userData;
}
