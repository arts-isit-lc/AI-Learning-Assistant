/**
 * Per-environment sizing and rollout profile (AWS_COST_OPTIMIZATION_PLAN.md,
 * section 9).
 *
 * Dev and prod deploy the same stacks and constructs; only the values here
 * differ. Keeping them in one place means a size difference can't turn into a
 * missing resource.
 *
 * The cost plan rolls out dev first (Stage A) and prod only after the dev
 * validation gate (Stage B). Each step is a flag here, so the `dev` branch can
 * be deployed to prod at any time without taking prod through a step early.
 * Stage B flips prod's flags one step at a time, in the plan's order.
 */
export interface EnvironmentSizing {
  /**
   * P1.1: keep the three per-user RDS Proxies (and their pinned exports) next
   * to the shared proxy. `true` is deploy 1 of 2; `false` is deploy 2, which
   * deletes them. Flip to `false` only after deploy 1 has run in that
   * environment and nothing imports the old exports.
   */
  readonly legacyProxies: boolean;
  /**
   * P1.3: create the warning-tier alarms. `false` keeps only the critical
   * tier, plus the two SQS alarms the DataPipelineHealth composite reads.
   */
  readonly warningAlarms: boolean;
  /**
   * P1.3: keep the dashboard's graphs within the free tier (3 dashboards of
   * up to 50 metrics each). `false` is the original per-function dashboard,
   * which is billed at $3/mo.
   */
  readonly freeTierDashboard: boolean;
  /** P2.1: the rebuilt database instance. */
  readonly database: DatabaseSizing;
  /**
   * P2.2: `instance` replaces the NAT Gateway with one NAT instance of
   * `natInstanceType` (AL2023, AMI pinned in NAT_INSTANCE_AMI).
   *
   * BLOCKED (2026-11-26): a UBC organization SCP denies ec2:ReplaceRoute,
   * CreateRoute, DeleteRoute and CreateRouteTable in OCELIA's accounts, so the
   * private subnets' default route can't move off the NAT Gateway. The dev
   * deploy failed on the route update and was rolled back with no egress
   * change. Both environments stay on `gateway` until UBC Hybrid Cloud allows
   * the route change (or makes it).
   */
  readonly nat: 'gateway' | 'instance';
  readonly natInstanceType: string;
  /**
   * P2.3: keep the Secrets Manager and Bedrock Runtime interface endpoints.
   * Without them, those calls go out through NAT (the managed NAT Gateway
   * while P2.2 is blocked), which chat already depends on for AppSync.
   */
  readonly interfaceEndpoints: boolean;
}

/**
 * P2.1 rebuild stages. Each stage is one deploy (plan section 6, "Procedure"):
 * - `none`: only the original instance.
 * - `created` (Deploy A): the rebuilt instance exists next to the original,
 *   which the app still uses. Copy the data in this stage.
 * - `cutover` (Deploy B): the proxy, alarms, admin secret and DB initializer
 *   use the rebuilt instance. The original stays untouched as the rollback
 *   target, with its exports pinned.
 * - `done` (Deploy C): the original instance is deleted, with a final
 *   snapshot. Turn off its deletion protection first.
 */
export type DatabaseRebuildStage = 'none' | 'created' | 'cutover' | 'done';

export interface DatabaseSizing {
  readonly rebuild: DatabaseRebuildStage;
  /** Instance type without the `db.` prefix, e.g. `t4g.micro`. */
  readonly instanceType: string;
  /** gp3's minimum (20 GB) gives 3,000 IOPS at any size. */
  readonly allocatedStorageGb: number;
  /** Storage autoscaling ceiling. Allocated storage can never shrink again. */
  readonly maxAllocatedStorageGb: number;
  /** Set explicitly so a rebuild can't move it (RDS assigns one at random). */
  readonly preferredMaintenanceWindow: string;
}

/**
 * Rebuilt instances run PostgreSQL 17 (standard support to Feb 2030), pinned
 * to the major version only: RDS picks the current default minor at creation
 * and auto minor upgrades take it from there, so a retired minor version can't
 * break a new instance the way `VER_16_10` did.
 */
export const POSTGRES_MAJOR_VERSION = '17';

/**
 * P2.2: the NAT instance's AMI, pinned here rather than in cdk.context.json
 * (which is git-ignored): an AMI change replaces the instance and cuts egress
 * for a few minutes, so it should only happen on purpose, in a quiet window.
 * Patch Manager keeps the running instance's packages current in between.
 * al2023-ami-2023.12.20261120.0-kernel-6.1-arm64, from
 * /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64 on 2026-11-26.
 */
export const NAT_INSTANCE_AMI: Record<string, string> = {
  'ca-central-1': 'ami-0c1d4c411d1c0569f',
};

const SIZING: Record<'dev' | 'prod', EnvironmentSizing> = {
  dev: {
    legacyProxies: false,
    warningAlarms: false,
    freeTierDashboard: true,
    database: {
      rebuild: 'done',
      // Load-tested at t4g.small first (plan section 6), then sized down.
      instanceType: 't4g.micro',
      allocatedStorageGb: 20,
      maxAllocatedStorageGb: 30,
      preferredMaintenanceWindow: 'mon:09:51-mon:10:21',
    },
    nat: 'gateway',
    natInstanceType: 't4g.nano',
    interfaceEndpoints: false,
  },
  prod: {
    legacyProxies: true,
    warningAlarms: true,
    freeTierDashboard: false,
    database: {
      rebuild: 'none',
      // t4g.medium if step 5 shows retrieval_units plus its indexes above ~700 MB.
      instanceType: 't4g.small',
      allocatedStorageGb: 20,
      maxAllocatedStorageGb: 50,
      preferredMaintenanceWindow: 'sat:09:38-sat:10:08',
    },
    nat: 'gateway',
    natInstanceType: 't4g.micro',
    interfaceEndpoints: true,
  },
};

export function sizingFor(environment: string | undefined): EnvironmentSizing {
  return environment === 'prod' ? SIZING.prod : SIZING.dev;
}
