# Dependency Upgrade Plan

## Summary

| Area | Location | Issue | Priority |
|---|---|---|---|
| ~~CDK CLI~~ | ~~`cdk/package.json`~~ | ~~Pinned to `2.146.0`, latest is `2.1118.0`, has CVE~~ | ✅ Done |
| ~~CDK Lib~~ | ~~`cdk/package.json`~~ | ~~Resolves to `2.219.0`, latest is `2.249.0`~~ | ✅ Done |
| ~~Alpha packages~~ | ~~`cdk/package.json`~~ | ~~Both pinned to old mismatched versions, `aws-appsync-alpha` removed (unused)~~ | ✅ Done |
| `aws-sdk` v2 (CDK) | `cdk/package.json` | Deprecated, migrate to v3 | High |
| `aws-sdk` v2 (frontend) | `frontend/package.json` | Deprecated, migrate to v3 | High |
| ~~`@types/node` (CDK)~~ | ~~`cdk/package.json`~~ | ~~Pinned to `20.12.7`, running Node 24~~ | ✅ Done |
| `typescript` (CDK) | `cdk/package.json` | `~5.4.5`, latest is `6.0.2` | Low |
| ~~Lambda runtimes (Node)~~ | ~~`api-gateway-stack.ts`~~ | ~~All 13 Node Lambdas on `NODEJS_20_X`~~ | ✅ Done |
| Lambda runtimes (Python) | `api-gateway-stack.ts`, `dbFlow-stack.ts` | All 9 Python Lambdas on `PYTHON_3_11` | Low |
| ~~Powertools layer~~ | ~~`api-gateway-stack.ts`~~ | ~~Hard-pinned to version `:78`~~ | ~~N/A~~ — Public Powertools layer not available in `ca-central-1`. Functions work via runtime pre-install. No action needed. |
| ~~`aws-jwt-verify` layer~~ | ~~`cdk/layers/aws-jwt-verify.zip`~~ | ~~Bundled version `4.0.0`, latest is `5.1.1`~~ | ✅ Done |
| `langchain-aws` | `requirements.txt` (x2) | Pinned to `0.2.29`, latest is `1.4.3` | High |
| ~~`PyPDF2`~~ | ~~`requirements.txt` (x3)~~ | ~~Deprecated, unused in code~~ | ✅ Done |
| ~~`PyMuPDF`~~ | ~~`requirements.txt` (x3)~~ | ~~Pinned to `1.24.10`, upgraded to `1.25.5` (max supported on AL2/Python 3.11)~~ | ✅ Done |
| ~~CDK npm audit~~ | ~~`cdk/package.json`~~ | ~~10 vulnerabilities resolved down to 1 (aws-sdk v2 advisory, deferred to step 10)~~ | ✅ Done |
| ~~Frontend npm audit~~ | ~~`frontend/package.json`~~ | ~~56 vulnerabilities resolved to 14 (remaining tied to `react-syntax-highlighter` and `aws-sdk` v2, deferred to steps 8 and 10)~~ | ✅ Done |
| ~~Frontend packages~~ | ~~`frontend/package.json`~~ | ~~`axios` removed (unused + supply chain risk), `prism` removed (unused), `react-router-dom` `6.24.1` → `7.14.1`, `react-syntax-highlighter` `15.5.0` → `16.1.1`~~ | ✅ Done |
| MUI v5 → v9 | `frontend/package.json` | `@mui/material` and `@mui/icons-material` are 4 major versions behind | Medium |
| React 18 → 19 | `frontend/package.json` | React 19 available | Low |

---

## 1. CDK CLI & Library (`cdk/package.json`)

### Problem
- `aws-cdk` CLI hard-pinned to `2.146.0` — causes the "Newer version of CDK is available" message on every deploy
- `aws-cdk` `2.142.0–2.148.0` has a known CVE: RestApi not generating `authorizationScope` correctly ([GHSA-qj85-69xf-2vxq](https://github.com/advisories/GHSA-qj85-69xf-2vxq))
- `aws-cdk-lib` resolves to `2.219.0`, latest is `2.249.0`
- `@aws-cdk/aws-amplify-alpha` pinned to `2.146.0-alpha.0` (latest: `2.249.0-alpha.0`)
- `@aws-cdk/aws-appsync-alpha` pinned to `2.59.0-alpha.0` — significantly behind and mismatched. Only used in `amplify-stack.ts`

### Action
Update `cdk/package.json`:

```json
"devDependencies": {
  "aws-cdk": "2.249.0",
  "@types/node": "^24.0.0"
},
"dependencies": {
  "@aws-cdk/aws-amplify-alpha": "2.249.0-alpha.0",
  "@aws-cdk/aws-appsync-alpha": "2.249.0-alpha.0",
  "aws-cdk-lib": "^2.249.0"
}
```

> ⚠️ `aws-appsync-alpha` is a large jump (`2.59.0` → `2.249.0`). Review the [changelog](https://github.com/aws/aws-cdk/blob/main/packages/%40aws-cdk/aws-appsync-alpha/CHANGELOG.md) for breaking API changes. Run `cdk diff` after upgrading.

```bash
cd cdk && npm install
```

---

## 2. Lambda Runtimes

### Node.js Lambdas — `NODEJS_20_X` (13 functions)
All Node.js Lambda functions in `api-gateway-stack.ts` use `Runtime.NODEJS_20_X`. Node 20 is currently in maintenance mode. Node 22 is the current active LTS on Lambda.

Affected functions: `studentFunction`, `instructorFunction`, `adminFunction`, `preSignupLambda`, `addStudentOnSignUp`, `adjustUserRoles`, `adminLambdaAuthorizer`, `studentLambdaAuthorizer`, `instructorLambdaAuthorizer`, `AuthHandler`, `sqsFunction`, and the two layer definitions.

### Action
Update all occurrences in `api-gateway-stack.ts`:
```typescript
// from
runtime: lambda.Runtime.NODEJS_20_X
// to
runtime: lambda.Runtime.NODEJS_22_X
```

Also update the two layer `compatibleRuntimes` arrays:
```typescript
compatibleRuntimes: [lambda.Runtime.NODEJS_22_X]
```

### Python Lambdas — `PYTHON_3_11` (9 functions)
All Python Lambdas use `PYTHON_3_11`. Python 3.11 is still supported on Lambda and not deprecated — no urgent action needed. Python 3.13 is the latest available on Lambda if you want to stay current.

---

## 3. AWS Lambda Powertools Layer

### Problem
The Powertools layer is hard-pinned to version `:78` in `api-gateway-stack.ts`:
```typescript
`arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:78`
```
The latest release is `v3.27.0`. Pinning to a specific ARN version means you never get bug fixes or security patches automatically.

### Action
Use the SSM public parameter approach so it always resolves to the latest compatible version, or bump the version number manually. To get the latest layer version ARN for your region:

```bash
aws lambda list-layer-versions \
  --layer-name AWSLambdaPowertoolsPythonV2 \
  --region <your-region> \
  --query 'LayerVersions[0].LayerVersionArn' \
  --output text
```

Then update the ARN in `api-gateway-stack.ts`. Alternatively, use the SSM-based lookup which always stays current:
```typescript
const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
  this,
  `${id}-PowertoolsLayer`,
  ssm.StringParameter.valueForStringParameter(
    this,
    `/aws/service/aws-lambda-powertools/python/latest/layer-arn`
  )
);
```

---

## 4. `aws-jwt-verify` Lambda Layer

### Problem
The bundled `aws-jwt-verify` in `cdk/layers/aws-jwt-verify.zip` is version `4.0.0`. The latest is `5.1.1`. This library is used by all three authorizer Lambda functions (`adminAuthorizerFunction`, `studentAuthorizerFunction`, `instructorAuthorizerFunction`).

### Action
Rebuild the layer zip with the latest version:
```bash
mkdir -p /tmp/jwt-layer/nodejs
cd /tmp/jwt-layer/nodejs
npm init -y
npm install aws-jwt-verify@5.1.1
cd /tmp/jwt-layer
zip -r aws-jwt-verify.zip nodejs/
cp aws-jwt-verify.zip /path/to/cdk/layers/aws-jwt-verify.zip
```

Then review the [v4 → v5 migration notes](https://github.com/awslabs/aws-jwt-verify/releases) for any breaking changes in the authorizer function code.

---

## 5. `aws-sdk` v2 Deprecation

### CDK (`cdk/package.json`)
`aws-sdk` v2 is in the `dependencies` of the CDK project. Check which CDK lib files use it:
```bash
grep -r "require('aws-sdk')\|from 'aws-sdk'" cdk/lib cdk/bin --include="*.ts"
```
Replace with the equivalent v3 scoped packages (e.g. `@aws-sdk/client-ssm`, `@aws-sdk/client-secrets-manager`) and remove `aws-sdk` from `dependencies`.

### Frontend (`frontend/package.json`)
`aws-sdk` v2 is also in the frontend dependencies. The frontend already uses v3 packages (`@aws-sdk/client-s3`, `@aws-sdk/client-cognito-identity`, etc.). Find and remove all v2 usages:
```bash
grep -r "require('aws-sdk')\|from 'aws-sdk'" frontend/src --include="*.js" --include="*.jsx"
```
Then remove `aws-sdk` from `frontend/package.json` dependencies entirely.

---

## 6. npm Audit — CDK (`cdk/package.json`)

10 vulnerabilities (3 high, 5 moderate, 2 low). After completing §1, run:
```bash
cd cdk && npm audit fix
```

Key vulnerabilities:

| Package | Severity | Notes |
|---|---|---|
| `aws-cdk` 2.142–2.148 | Moderate CVE | Fixed by upgrading CLI (§1) |
| `minimatch` | High | ReDoS — `npm audit fix` |
| `picomatch` | High | ReDoS — `npm audit fix` |
| `brace-expansion` | Moderate | ReDoS — `npm audit fix` |
| `diff` | Moderate | DoS — `npm audit fix` |
| `js-yaml` | Moderate | Prototype pollution — `npm audit fix` |
| `yaml` | Moderate | Stack overflow — fixed by upgrading `aws-cdk-lib` to `2.249.0` |
| `ajv` | Moderate | ReDoS — `npm audit fix` |

---

## 7. npm Audit — Frontend (`frontend/package.json`)

**56 vulnerabilities (15 critical, 17 high, 16 moderate, 8 low)** — this is the most urgent area.

The frontend has not had `npm install` run (all packages show as MISSING), so install first:
```bash
cd frontend && npm install
```

Key vulnerabilities requiring attention:

| Package | Severity | Issue |
|---|---|---|
| `axios` ≤1.14.0 | Critical | SSRF, credential leakage, DoS — update to `^1.15.0` |
| `form-data` 4.0.0–4.0.3 | Critical | Unsafe random boundary — `npm audit fix` |
| `fast-xml-parser` | Critical | Entity expansion, regex injection — `npm audit fix` |
| `react-syntax-highlighter` ≤15.6.6 | High | Vulnerability in `prismjs` — update to `^16.1.1` (breaking change) |
| `@remix-run/router` ≤1.23.1 | High | XSS via open redirects — update `react-router-dom` |
| `rollup` 4.0–4.58 | High | Arbitrary file write, XSS — `npm audit fix` |
| `lodash` | High | Prototype pollution — `npm audit fix` |
| `cross-spawn` 7.0.0–7.0.4 | High | ReDoS — `npm audit fix` |
| `node-fetch` <2.6.7 | High | Forwards secure headers to untrusted sites |
| `flatted` | High | Prototype pollution, DoS |

Run after `npm install`:
```bash
cd frontend && npm audit fix
```

---

## 8. Frontend Package Upgrades (`frontend/package.json`)

### MUI v5 → v9
`@mui/material` and `@mui/icons-material` are on `^5.x`, latest is `9.0.0`. This is a large jump with breaking changes. Review the [MUI migration guides](https://mui.com/material-ui/migration/) for v6, v7, v8, and v9 before upgrading. This affects all components across `pages/admin`, `pages/instructor`, and `pages/student`.

### `material-react-table` v2 → v3
Currently `^2.13.1`, latest is `3.2.1`. Has breaking API changes — review the [v3 migration guide](https://www.material-react-table.com/docs/guides/migrating-to-v3).

### `react-router-dom` v6 → v7
Currently `^6.24.1`, latest is `7.14.0`. v7 has breaking changes around loaders and actions. Also fixes the `@remix-run/router` XSS CVE. Review the [v7 upgrade guide](https://reactrouter.com/upgrading/v6).

### `react-icons` v4 → v5
Currently `^4.9.0`, latest is `5.6.0`. Minor breaking changes in icon naming.

### `@smithy` packages
`@smithy/eventstream-codec`, `@smithy/protocol-http`, `@smithy/signature-v4`, `@smithy/util-utf8` are all on v3/v4 while v4/v5 are available. These should be bumped together as they are part of the same SDK.

### `aws-jwt-verify` (frontend)
Currently `^4.0.1`, latest is `5.1.1`. Update to `^5.1.1`.

### `react-toastify` v10 → v11
Currently `^10.0.5`, latest is `11.0.5`. Minor breaking changes.

### `recharts` v2 → v3
Currently `^2.12.7`, latest is `3.8.1`. Has breaking changes — review changelog before upgrading.

### `eslint` v8 → v9
Currently `^8.57.0`, latest is v9. v9 uses a flat config format — breaking change for `.eslintrc.cjs`.

---

## 9. Python Dependencies (`requirements.txt`)

### `langchain-aws` — `0.2.29` → `1.4.3`
Pinned in both `text_generation/requirements.txt` and `data_ingestion/requirements.txt`. The `1.0.0` release introduced breaking changes to `ChatBedrock`, `BedrockEmbeddings`, and `BedrockLLM` interfaces used in `chat.py` and `main.py`. Review the [1.0.0 release notes](https://github.com/langchain-ai/langchain-aws/releases/tag/v1.0.0) before upgrading. Test Lambda responses end-to-end after upgrading.

### ~~`PyPDF2`~~ — ✅ Removed
Removed from all three `requirements.txt` files. Confirmed not imported anywhere in the source code across the full data ingestion pipeline.

### ~~`PyMuPDF`~~ — ✅ Upgraded to `1.25.5`
Upgraded in all three `requirements.txt` files. `1.27.2.2` was attempted but requires C++20 which the Amazon Linux 2 base image (`python:3.11`) does not support. `1.25.5` is the maximum version compatible with the current base image. Further upgrade to `1.27.2.2` is possible when the Lambda base image is upgraded to `python:3.12` or `python:3.13` (Amazon Linux 2023, gcc 11+).

---

## Recommended Upgrade Order

| Step | Action | Risk |
|---|---|---|
| ~~1~~ | ~~Remove `PyPDF2` from all 3 `requirements.txt`~~ | ✅ Done |
| ~~2~~ | ~~Bump `PyMuPDF` to `1.25.5`~~ | ✅ Done |
| ~~3~~ | ~~CDK CLI + lib + alpha packages, then `npm audit fix` in `cdk/`~~ | ✅ Done |
| ~~4~~ | ~~Update Node Lambda runtimes to `NODEJS_22_X`~~ | ✅ Done |
| ~~5~~ | ~~Rebuild `aws-jwt-verify` layer to `5.1.1`~~ | ✅ Done |
| ~~6~~ | ~~Update Powertools layer ARN to latest version~~ | N/A — Public layer not available in `ca-central-1`, skipped |
| ~~7~~ | ~~`npm install` + `npm audit fix` in `frontend/`~~ | ✅ Done |
| 8 | Fix critical frontend CVEs: `axios`, `react-router-dom`, `react-syntax-highlighter` | ✅ Done |
| 9 | `langchain-aws` `0.2.29` → `1.4.3` | High |
| 10 | `aws-sdk` v2 → v3 in CDK and frontend | High |
| 11 | MUI v5 → v9, `material-react-table` v2 → v3 | High |
| 12 | `typescript` `5.4.5` → `6.x`, `eslint` v8 → v9 | Medium |
