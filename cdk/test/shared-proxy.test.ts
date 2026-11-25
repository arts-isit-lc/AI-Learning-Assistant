import { Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

// P1.1 in AWS_COST_OPTIMIZATION_PLAN.md: one standalone RDS Proxy holds the
// secrets of all three database users, and every database client connects
// through it. RDS Proxy bills a 2-vCPU minimum per proxy, so each extra proxy
// costs ~$24/mo regardless of load.

let dbTemplate: Template;
let apiTemplate: Template;
let ragTemplate: Template;

beforeAll(() => {
  ({ dbTemplate, apiTemplate, ragTemplate } = createTestStacks());
});

function sharedProxy(): { id: string; props: Record<string, unknown> } {
  const proxies = dbTemplate.findResources('AWS::RDS::DBProxy');
  const shared = Object.entries(proxies).filter(([id]) => id.includes('sharedProxy'));
  expect(shared).toHaveLength(1);
  const [id, resource] = shared[0];
  return { id, props: (resource as { Properties: Record<string, unknown> }).Properties };
}

describe('Shared RDS Proxy', () => {
  test('is a standalone construct, not a child of the DB instance', () => {
    // A child of the instance (dbInstance.addProxy) would be replaced, with a
    // new endpoint, whenever the instance is replaced (the P2.1 rebuild).
    const { id } = sharedProxy();
    expect(id).not.toMatch(/database.*sharedProxy/);
  });

  test('holds the app user, table creator and master secrets', () => {
    const auth = sharedProxy().props.Auth as unknown[];
    expect(auth).toHaveLength(3);
    const secretRefs = JSON.stringify(auth);
    expect(secretRefs).toContain('userCredentialsrdsDbCredential');
    expect(secretRefs).toContain('userCredentialsTableCreator');
    expect(secretRefs).toContain('credentials/rdsDbCredential');
  });

  test('keeps the settings of the proxies it replaces', () => {
    const { props } = sharedProxy();
    expect(props.RequireTLS).toBe(true);
    expect(props.IdleClientTimeout).toBe(1800);
    expect(props.DebugLogging).toBe(false);
  });

  test('targets the DB instance with the full connection pool', () => {
    const { id } = sharedProxy();
    dbTemplate.hasResourceProperties('AWS::RDS::DBProxyTargetGroup', {
      DBProxyName: { Ref: id },
      ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 100 },
    });
  });
});

describe('Every database client uses the shared proxy', () => {
  const PROXY_ENV_VARS = ['RDS_PROXY_ENDPOINT', 'DB_PROXY_ENDPOINT'];

  function proxyEndpointValues(template: Template): Array<[string, string]> {
    const values: Array<[string, string]> = [];
    for (const [id, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
      const vars = (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables ?? {};
      for (const name of PROXY_ENV_VARS) {
        if (name in vars) values.push([id, JSON.stringify(vars[name])]);
      }
    }
    return values;
  }

  test.each([
    ['ApiGatewayStack', () => apiTemplate],
    ['MultimodalRagStack', () => ragTemplate],
  ])('%s Lambdas all import the shared proxy endpoint', (_name, template) => {
    const values = proxyEndpointValues(template());
    expect(values.length).toBeGreaterThan(0);
    for (const [fn, value] of values) {
      expect({ fn, usesSharedProxy: value.includes('sharedProxy') }).toEqual({ fn, usesSharedProxy: true });
    }
  });
});
