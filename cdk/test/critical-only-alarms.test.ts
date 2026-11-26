import { Template } from 'aws-cdk-lib/assertions';
import { createObservabilityTemplate, FULL_ALARM_TIER } from './helpers/stack-setup';
import { sizingFor } from '../lib/constants/sizing';

/**
 * P1.3 in AWS_COST_OPTIMIZATION_PLAN.md: critical-tier alarms only, and a
 * dashboard within the free tier. Dev runs this profile (Stage A); prod keeps
 * the warning tier until Stage B flips its flags.
 */

const devTemplate = createObservabilityTemplate();
const fullTemplate = createObservabilityTemplate(FULL_ALARM_TIER);

function alarmNames(template: Template): string[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
    (r) => r.Properties.AlarmName as string
  );
}

/** Metrics graphed on the dashboard: each metric entry starts with its namespace. */
function dashboardMetricCount(template: Template): number {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
  const body = JSON.stringify(dashboard.Properties.DashboardBody);
  return (body.match(/\[\\"AWS\//g) ?? []).length;
}

describe('Dev profile (P1.3 applied)', () => {
  test('dev is critical-only with a free-tier dashboard', () => {
    expect(sizingFor('dev').warningAlarms).toBe(false);
    expect(sizingFor('dev').freeTierDashboard).toBe(true);
  });

  test('no warning-tier alarms, except the two SQS inputs of DataPipelineHealth', () => {
    const warnings = alarmNames(devTemplate).filter((name) => name.endsWith('-Warning')).sort();
    expect(warnings).toEqual(['AILA-dev-SQS-QueueAge-Warning', 'AILA-dev-SQS-QueueDepth-Warning']);
  });

  test('every critical-tier alarm is kept', () => {
    const kept = new Set(alarmNames(devTemplate));
    const notWarning = alarmNames(fullTemplate).filter((name) => !name.endsWith('-Warning'));
    expect(notWarning.length).toBeGreaterThan(0);
    expect(notWarning.filter((name) => !kept.has(name))).toEqual([]);
  });

  test('both composite alarms are kept', () => {
    const composites = Object.values(devTemplate.findResources('AWS::CloudWatch::CompositeAlarm')).map(
      (r) => r.Properties.AlarmName
    );
    expect(composites.sort()).toEqual(['AILA-dev-DataPipelineHealth', 'AILA-dev-SystemHealthCritical']);
  });

  test('the dashboard graphs at most 50 metrics (free tier)', () => {
    expect(dashboardMetricCount(devTemplate)).toBeGreaterThan(0);
    expect(dashboardMetricCount(devTemplate)).toBeLessThanOrEqual(50);
  });
});

describe('Full alarm tier (prod until Stage B)', () => {
  test('prod keeps the warning tier and the original dashboard', () => {
    expect(sizingFor('prod').warningAlarms).toBe(true);
    expect(sizingFor('prod').freeTierDashboard).toBe(false);
  });

  test('has the warning tier, so the dev assertions above are meaningful', () => {
    expect(alarmNames(fullTemplate).filter((name) => name.endsWith('-Warning')).length).toBeGreaterThan(2);
    expect(alarmNames(fullTemplate).length).toBeGreaterThan(alarmNames(devTemplate).length);
  });
});
