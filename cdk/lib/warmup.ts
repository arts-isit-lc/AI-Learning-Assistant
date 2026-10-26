import { Duration } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

/**
 * Daily keep-warm ping for container-image Lambdas.
 *
 * Lambda marks a function Inactive after several weeks without invocations and
 * reclaims its cached image and VPC network interfaces. The next real
 * invocation then fails while the function reactivates: a synchronous caller
 * (API Gateway → chatbotV2) gets a 5XX, and an SQS-triggered function
 * (enrichment) leaves the message in flight until the queue's visibility
 * timeout expires (900 s). See CLAUDE_HISTORY.md (2026-10-26).
 *
 * The rule sends `{"warmup": true}`; each handler returns on that flag before
 * doing any I/O. One rule per function keeps each under EventBridge's
 * 5-targets-per-rule limit and lets a single schedule be disabled on its own.
 */
export const WARMUP_EVENT = { warmup: true };

export function addDailyWarmup(
  scope: Construct,
  name: string,
  fn: lambda.IFunction
): events.Rule {
  const rule = new events.Rule(scope, `${name}-warmupSchedule`, {
    schedule: events.Schedule.rate(Duration.days(1)),
    description: `Daily keep-warm ping so ${name} never goes Inactive from idleness`,
  });
  rule.addTarget(
    new targets.LambdaFunction(fn, {
      event: events.RuleTargetInput.fromObject(WARMUP_EVENT),
    })
  );
  return rule;
}
