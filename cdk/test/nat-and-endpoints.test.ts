import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EnvironmentSizing, NAT_INSTANCE_AMI, sizingFor } from '../lib/constants/sizing';

/**
 * P2.2 (NAT Gateway -> NAT instance) and P2.3 (remove the Secrets Manager and
 * Bedrock Runtime interface endpoints) in AWS_COST_OPTIMIZATION_PLAN.md.
 */

function vpcTemplate(sizing: Partial<EnvironmentSizing>, environment: 'dev' | 'prod' = 'dev'): Template {
  const app = new cdk.App({ context: { StackPrefix: 'Test', environment } });
  const env = { account: '123456789012', region: 'ca-central-1' };
  return Template.fromStack(new VpcStack(app, 'Test-VpcStack', { env, environment, sizing }));
}

function interfaceEndpointServices(template: Template): string[] {
  return Object.values(template.findResources('AWS::EC2::VPCEndpoint'))
    .filter((r) => r.Properties.VpcEndpointType === 'Interface')
    .map((r) => JSON.stringify(r.Properties.ServiceName));
}

describe('NAT Gateway (prod until Stage B)', () => {
  test('prod keeps the NAT Gateway and both interface endpoints', () => {
    expect(sizingFor('prod').nat).toBe('gateway');
    expect(sizingFor('prod').interfaceEndpoints).toBe(true);
  });

  const template = vpcTemplate({ nat: 'gateway', interfaceEndpoints: true });

  test('one NAT Gateway, no NAT instance', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::Instance', 0);
  });

  test('Secrets Manager and Bedrock Runtime interface endpoints exist', () => {
    const services = interfaceEndpointServices(template);
    expect(services.some((s) => s.includes('secretsmanager'))).toBe(true);
    expect(services.some((s) => s.includes('bedrock-runtime'))).toBe(true);
  });
});

describe('NAT instance (P2.2)', () => {
  const template = vpcTemplate({ nat: 'instance', natInstanceType: 't4g.nano', interfaceEndpoints: true });

  test('replaces the NAT Gateway with one NAT instance of the profile type', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.nano',
      SourceDestCheck: false,
    });
  });

  test('private subnets route to the NAT instance', () => {
    const routes = Object.values(template.findResources('AWS::EC2::Route', {
      Properties: { DestinationCidrBlock: '0.0.0.0/0', InstanceId: Match.anyValue() },
    }));
    expect(routes.length).toBeGreaterThan(0);
  });

  test('uses the pinned AMI, so a new AMI release cannot replace it on deploy', () => {
    template.hasResourceProperties('AWS::EC2::Instance', { ImageId: NAT_INSTANCE_AMI['ca-central-1'] });
  });

  test('requires IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  test('accepts inbound traffic only from inside the VPC', () => {
    const [sg] = Object.values(template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security Group for NAT instances' },
    }));
    const ingress = JSON.stringify(sg.Properties.SecurityGroupIngress ?? []);
    expect(ingress).not.toContain('0.0.0.0/0');
    expect(ingress).toContain('"CidrBlock"');
  });

  test('uses ip route, not net-tools, to find the egress interface', () => {
    const [instance] = Object.values(template.findResources('AWS::EC2::Instance'));
    const userData = JSON.stringify(instance.Properties.UserData);
    expect(userData).toContain('ip route show default');
    expect(userData).toContain('MASQUERADE');
  });

  test('is managed by SSM, patched weekly, and recovered or rebooted on failed checks', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore']) ]) }),
      ]),
    });
    template.hasResourceProperties('AWS::SSM::Association', {
      Name: 'AWS-RunPatchBaseline',
      ApplyOnlyAtCronInterval: true,
    });
    const actions = JSON.stringify(Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmActions));
    expect(actions).toContain(':automate:');
    expect(actions).toContain('ec2:recover');
    expect(actions).toContain('ec2:reboot');
  });
});

describe('Interface endpoints removed (P2.3)', () => {
  const template = vpcTemplate({ nat: 'instance', interfaceEndpoints: false });

  test('no interface endpoints; the free S3 and DynamoDB gateway endpoints stay', () => {
    expect(interfaceEndpointServices(template)).toEqual([]);
    const gateways = Object.values(template.findResources('AWS::EC2::VPCEndpoint'))
      .filter((r) => r.Properties.VpcEndpointType === 'Gateway');
    expect(gateways).toHaveLength(2);
  });
});
