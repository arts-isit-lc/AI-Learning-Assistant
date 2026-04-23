# Performance Improvements

## P-1: Reduce Lambda Cold Starts

Lambda functions in a VPC have longer cold starts because they need to attach an ENI (Elastic Network Interface). The authorizer functions are hit on every single API request and are in the VPC.

Options:
- Move authorizer functions out of the VPC — they only need Secrets Manager access (available via the internet or a VPC endpoint). They don't query the database directly.
- Use Provisioned Concurrency on the authorizer functions (keeps 1-2 instances warm). Costs ~$5/mo per function but eliminates cold starts for the most latency-sensitive path.

## P-2: Add Bedrock VPC Endpoint

The `TextGenLambdaDockerFunc` calls Bedrock from inside the VPC. Without a Bedrock VPC endpoint, this traffic routes through the NAT Gateway, adding latency and data transfer cost. Adding a Bedrock Runtime interface endpoint keeps traffic on the AWS backbone.

```typescript
this.vpc.addInterfaceEndpoint("BedrockEndpoint", {
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
});
```

## P-3: Frontend Code Splitting

The Vite build produces a single 2.5MB JS bundle. Every page load downloads the entire app regardless of which role the user has. Implement route-based code splitting:

```jsx
const AdminHomepage = React.lazy(() => import("./pages/admin/AdminHomepage"));
const InstructorHomepage = React.lazy(() => import("./pages/instructor/InstructorHomepage"));
const StudentHomepage = React.lazy(() => import("./pages/student/StudentHomepage"));
```

This would split the bundle into role-specific chunks, reducing initial load time by 40-60% for most users.

## P-4: Cache Bedrock LLM Model Configuration

The `TextGenLambdaDockerFunc` queries SSM Parameter Store for the LLM model ID, embedding model ID, and table name on every cold start. These values rarely change. Cache them with a TTL (already partially done with global variables, but the SSM calls still happen on every cold start). Consider using Lambda Extensions for background parameter refresh.
