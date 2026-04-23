# Performance Improvements

Prioritized by user-facing latency impact. The primary complaint is noticeable latency when chatting with the AI.

## AI Chat Latency Analysis

Every student message to the AI triggers the following sequential chain in `TextGenLambdaDockerFunc`:

```
1. [Cold start only] ENI attachment + Secrets Manager + 3x SSM calls + BedrockEmbeddings init + DynamoDB table check
2. 4x sequential DB queries (system_prompt, llm_model_id, module_prompt, allowed_file_ids)
3. Bedrock embedding call (convert query to vector) — via NAT Gateway
4. 2x PostgreSQL queries (hybrid vector + keyword search)
5. Bedrock LLM call #1: history-aware retriever (reformulate question with chat history) — via NAT
6. DynamoDB read (load chat history) — via Gateway Endpoint (not NAT)
7. Bedrock LLM call #2: RAG response generation — via NAT
8. DynamoDB write (save to chat history) — via Gateway Endpoint (not NAT)
9. [First message only] Bedrock LLM call #3: generate session name — via NAT
```

The dominant latency sources are:
- **Bedrock LLM calls** (steps 5, 7, 9): Each takes 2-10+ seconds depending on model and response length. These are the biggest bottleneck and are sequential.
- **NAT Gateway routing**: Bedrock traffic goes through the NAT, adding ~5-15ms per call. Adds up across 2-3 Bedrock calls per request. (Note: DynamoDB and S3 traffic already use gateway endpoints and do NOT go through NAT.)
- **Cold starts**: ENI attachment in VPC adds 1-5 seconds. Only affects first request after idle period.
- **Sequential DB queries** (step 2): 4 separate queries that could be combined into 1.

---

## P-1: Add Bedrock VPC Endpoint (High Impact on Chat Latency)

Every Bedrock call (1 embedding + 2 LLM calls per message, 3 LLM on first message) routes through the NAT Gateway. A Bedrock VPC endpoint keeps this traffic on the AWS backbone — lower latency, more consistent performance, and reduces NAT data transfer costs.

This is the single most impactful infrastructure change for chat latency because it affects every Bedrock call, and there are 3-4 per student message (1 embedding + 2 LLM, plus 1 more LLM on first message).

### Deep Dive Verification

**Bedrock usage confirmed** in two Lambda functions:
- `TextGenLambdaDockerFunc` (`text_generation/src/main.py`): Creates `boto3.client("bedrock-runtime")` at module level. Used for `BedrockEmbeddings` (embedding calls) and indirectly via `ChatBedrock`/`BedrockLLM` in `helpers/chat.py` (LLM inference). Per student message: 1 embedding call + 2 LLM calls (+ 1 more LLM on first message for session naming).
- `DataIngestLambdaDockerFunc` (`data_ingestion/src/main.py`): Creates `boto3.client("bedrock-runtime")` at module level. Used for `BedrockEmbeddings` during document ingestion.

**VPC placement confirmed**: Both Lambdas are defined with `vpc: vpcStack.vpc` and no explicit `vpcSubnets`, so they default to `PRIVATE_WITH_EGRESS` subnets. All Bedrock traffic currently routes through the NAT Gateway.

**VPC stack analysis** (`vpc-stack.ts`): The `else` block (new VPC deployment path, the default) creates a VPC with 2 AZs, 1 NAT Gateway, and already has gateway endpoints for S3/DynamoDB and an interface endpoint for Secrets Manager. No Bedrock endpoint exists.

**CDK constant verified**: `ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME` exists in CDK v2.249+ (confirmed against AWS CDK docs). Project uses `aws-cdk-lib: ^2.249.0`.

**Subnet placement**: Omitting the `subnets` option on the endpoint defaults to placing ENIs in all private subnets, making it reachable from the `PRIVATE_WITH_EGRESS` subnets where the Lambdas run. This is correct.

**No code changes needed**: boto3 automatically resolves the `bedrock-runtime` service hostname to the VPC endpoint's private IPs via private DNS (enabled by default on interface endpoints).

### Recommended Change

Add to `vpc-stack.ts` in the `else` block, after the existing gateway endpoints:

```typescript
this.vpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
});
```

### Risk Assessment

- **Breaking changes**: None. The NAT Gateway remains as fallback for other traffic. Adding an endpoint is additive.
- **Existing VPC path**: The `if` block (existing VPC deployment) is not modified. That path already has its own endpoint setup and would need separate consideration.
- **Cost**: ~$14.40/mo per environment (2 AZs × $7.20). Pays for itself via reduced NAT data transfer on Bedrock calls.

---

## P-2: Combine Sequential DB Queries in TextGen Handler (High Impact)

The handler makes 4 separate sequential DB queries before any LLM work begins:

```python
system_prompt = get_system_prompt(course_id)        # query 1
course_llm_model_id = get_course_llm_model_id(course_id)  # query 2
module_prompt = get_module_prompt(module_id)          # query 3
topic = get_module_name(module_id)                    # query 4
# ... later:
allowed_file_ids = get_allowed_file_ids(module_id)   # query 5 (2 queries)
```

Each query opens a cursor, executes, fetches, and closes. With RDS Proxy latency, each round-trip is ~5-15ms. That's 30-90ms of pure DB overhead before any AI work starts.

### Deep Dive Verification

**Individual query functions** (`text_generation/src/main.py`):
- `get_system_prompt(course_id)`: Queries `"Courses"` by `course_id` → returns `system_prompt` or `None`
- `get_course_llm_model_id(course_id)`: Queries `"Courses"` by `course_id` → returns `llm_model_id` or `None`
- `get_module_prompt(module_id)`: Queries `"Course_Modules"` by `module_id` → returns `module_prompt` or `""`
- `get_module_name(module_id)`: Queries `"Course_Modules"` by `module_id` → returns `module_name` or `None`
- `get_allowed_file_ids(module_id)`: Two queries — `"Module_Files"` + `"Module_File_References"` → returns list of IDs or `[]`

**No external callers**: All 5 functions are only called from the `handler()` function in the same file. Safe to replace.

**Schema relationships confirmed** (`lambda/initializer/initializer.py`):
- `Courses` has `course_id` (PK), `system_prompt`, `llm_model_id`
- `Course_Concepts` has `concept_id` (PK), `course_id` (FK → Courses)
- `Course_Modules` has `module_id` (PK), `concept_id` (FK → Course_Concepts), `module_name`, `module_prompt`
- `Module_Files` has `file_id` (PK), `module_id` (FK → Course_Modules)
- `Module_File_References` has `source_module_id` (FK), `referenced_file_id` (FK) — composite PK

The JOIN path `Courses → Course_Concepts → Course_Modules` is valid and already used elsewhere in the codebase (`helpers/chat.py:get_other_module_names`, `sqsTrigger/src/main.py`).

**Handler error handling semantics** that must be preserved:
1. `system_prompt is None` → return 400 "Error fetching system prompt"
2. `course_llm_model_id` is `None` → fallback to `BEDROCK_LLM_ID` system default (not an error)
3. `module_prompt` is `None`/empty → defaults to `""` (not an error)
4. `topic` (`module_name`) is `None` → return 400 "Invalid module_id"
5. `allowed_file_ids` error → defaults to `[]` (not an error)

**Behavioral difference with combined query**: The current code queries `Courses` and `Course_Modules` independently. The combined JOIN validates that the module belongs to the course (via `Course_Concepts`). If a module_id doesn't belong to the given course_id, the current code would still return both values independently, while the combined query returns no rows. This is actually a correctness improvement — it catches invalid course/module combinations. In practice, the frontend always sends valid pairs.

**Result uniqueness**: Since `module_id` is a primary key, the JOIN returns at most one row regardless of how many concepts exist.

### Recommended Change

Replace the 4 individual query functions with a single `get_module_context(course_id, module_id)`:

```python
def get_module_context(course_id, module_id):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return None
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT
                c.system_prompt,
                c.llm_model_id,
                cm.module_name,
                cm.module_prompt
            FROM "Courses" c
            JOIN "Course_Concepts" cc ON cc.course_id = c.course_id
            JOIN "Course_Modules" cm ON cm.concept_id = cc.concept_id
            WHERE c.course_id = %s AND cm.module_id = %s;
        """, (course_id, module_id))
        result = cur.fetchone()
        cur.close()
        if result is None:
            return None
        return {
            'system_prompt': result[0],
            'llm_model_id': result[1] if result[1] else None,
            'module_name': result[2],
            'module_prompt': result[3] if result[3] else "",
        }
    except Exception as e:
        logger.error(f"Error fetching module context: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None
```

Replace the 2-query `get_allowed_file_ids` with a single UNION query:

```python
def get_allowed_file_ids(module_id):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT file_id FROM "Module_Files" WHERE module_id = %s
            UNION
            SELECT referenced_file_id FROM "Module_File_References" WHERE source_module_id = %s;
        """, (module_id, module_id))
        ids = [str(row[0]) for row in cur.fetchall()]
        cur.close()
        return ids
    except Exception as e:
        logger.error(f"Error fetching allowed_file_ids: {e}")
        return []
```

Update the handler to use `get_module_context()` and extract values from the returned dict, preserving all existing error handling (400 on missing system_prompt, 400 on missing topic, fallback for llm_model_id, empty string default for module_prompt).

### Risk Assessment

- **Breaking changes**: None for valid course/module pairs. For invalid pairs (module not belonging to course), the combined query returns `None` instead of returning partial data — this is a correctness improvement.
- **UNION vs concatenation**: `UNION` deduplicates IDs that appear in both `Module_Files` and `Module_File_References`. The original code could return duplicates. Deduplication is the correct behavior for a filter list.
- **Error handling**: All original error paths preserved. The combined function returns `None` on any failure, and the handler checks each extracted field individually.

This reduces 6 DB round-trips to 2, saving ~30-60ms per chat request.

---

## P-3: Reduce Lambda Cold Starts for Authorizers (Medium Impact)

The 3 authorizer functions run on every API request and are in the VPC. VPC cold starts add 1-5 seconds for ENI attachment. The authorizers only need Secrets Manager access (to fetch Cognito credentials) — they don't query the database.

### Deep Dive Verification

**Authorizer code analysis** (`adminAuthorizerFunction.js`, `studentAuthorizerFunction.js`, `instructorAuthorizerFunction.js`):

All three are structurally identical. Each does exactly two things:
1. Calls Secrets Manager (`GetSecretValueCommand`) to fetch Cognito credentials (`VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_USER_POOL_CLIENT_ID`)
2. Verifies a JWT using `aws-jwt-verify` (`CognitoJwtVerifier`), which fetches JWKS from Cognito's public endpoint (`cognito-idp.{region}.amazonaws.com`)

Neither service requires VPC access:
- Secrets Manager is a public AWS service — accessible directly from a non-VPC Lambda
- Cognito JWKS endpoint is public internet — also accessible directly without VPC
- No database calls, no RDS Proxy connections, no VPC-internal resources of any kind

**CDK configuration** (`api-gateway-stack.ts`, lines ~812-909):

All three authorizers are defined with `vpc: vpcStack.vpc` and `role: lambdaRole`.

The `lambdaRole` (`postgresLambdaRole`) is shared by 7 Lambdas:
- `studentFunction`, `instructorFunction`, `adminFunction` — VPC, need DB access (keep in VPC)
- `adminLambdaAuthorizer`, `studentLambdaAuthorizer`, `instructorLambdaAuthorizer` — VPC, no DB access (remove from VPC)
- `NotificationFunction` — VPC, AppSync data source (keep in VPC for now, could be reviewed separately)

The role has EC2 network interface permissions (`CreateNetworkInterface`, etc.) which become unused for the authorizers outside VPC — this is harmless. The role is an IAM construct, not tied to VPC placement.

**OpenAPI integration** (`OpenAPI_Swagger_Definition.yaml`, lines ~4413-4436):

The authorizers are referenced by logical IDs (`adminLambdaAuthorizer`, `studentLambdaAuthorizer`, `instructorLambdaAuthorizer`) set via `overrideLogicalId()`. These IDs are unaffected by removing the VPC property. The `grantInvoke` for API Gateway is also unaffected.

**Only difference in authorizer behavior**: The `groups` claim validation:
- `adminLambdaAuthorizer`: requires `admin` group
- `instructorLambdaAuthorizer`: requires `['instructor', 'admin']`
- `studentLambdaAuthorizer`: requires `['student', 'instructor', 'admin']`

None of this involves VPC resources.

### Recommended Change

Remove `vpc: vpcStack.vpc` from all three authorizer Lambda definitions in `api-gateway-stack.ts`:

```typescript
// In api-gateway-stack.ts — for each authorizer:
const authorizationFunction = new lambda.Function(
  this,
  `${id}-admin-authorization-api-gateway`,
  {
    runtime: lambda.Runtime.NODEJS_22_X,
    code: lambda.Code.fromAsset("lambda/adminAuthorizerFunction"),
    handler: "adminAuthorizerFunction.handler",
    timeout: Duration.seconds(30),
    // vpc: vpcStack.vpc,  ← REMOVE THIS LINE
    environment: {
      SM_COGNITO_CREDENTIALS: this.secret.secretName,
    },
    functionName: `${id}-adminLambdaAuthorizer`,
    memorySize: 256,
    layers: [jwt],
    role: lambdaRole,
  }
);
```

Apply the same removal to `studentLambdaAuthorizer` and `instructorLambdaAuthorizer`.

### Risk Assessment

- **Breaking changes**: None. The authorizers access only public AWS services (Secrets Manager, Cognito JWKS). No VPC-internal dependencies.
- **Shared role**: The `lambdaRole` EC2 permissions become unused for these 3 Lambdas but remain needed by the other 4 Lambdas sharing the role. No impact.
- **OpenAPI references**: Logical IDs are unchanged. API Gateway integration is unaffected.
- **Deployment note**: CloudFormation will replace the Lambda functions (VPC → non-VPC is a resource replacement). Brief authorizer downtime during deployment — plan accordingly.

Without VPC, cold starts drop from ~3-5s to ~500ms-1s. This affects every first request after an idle period for any API call (not just chat).

---

## P-4: Frontend Code Splitting (Medium Impact)

`App.jsx` eagerly imports all page components:

```jsx
import StudentHomepage from "./pages/student/StudentHomepage";
import AdminHomepage from "./pages/admin/AdminHomepage";
import InstructorHomepage from "./pages/instructor/InstructorHomepage";
// ... etc
```

Every user downloads the entire app regardless of role. Switch to lazy loading.

### Deep Dive Verification

**Current import structure** (`frontend/src/App.jsx`):

5 page components are eagerly imported at the top level:
- `Login` — shared, always needed
- `StudentHomepage` — student role
- `StudentChat` — student role
- `AdminHomepage` — admin role
- `InstructorHomepage` — instructor role
- `CourseView` — student role

No `React.lazy()` or `<Suspense>` usage exists anywhere in the frontend codebase.

**Role-specific code sizes** (lines of JSX, excluding shared components):
- Instructor pages: ~4,390 lines across 14 files (largest role-specific chunk)
- Admin pages: ~2,065 lines across 7 files
- Student pages: ~1,508 lines across 3 files

**Heavy role-specific dependencies** (biggest code splitting wins):
- `recharts` (charting library) — only imported by `InstructorAnalytics.jsx`
- `material-react-table` — only imported by `InstructorModules.jsx` and `InstructorConcepts.jsx`
- These are large libraries that students and admins currently download but never use

**Shared dependencies** (stay in common bundle regardless):
- `@mui/material` — used by all roles
- `aws-amplify` — used by all roles
- `react-syntax-highlighter` — used by `AIMessage.jsx` and `StudentMessage.jsx` (shared components used in student chat)
- `react-router-dom` — used by all roles

**Build setup**: Vite (`vite.config.js`) with `@vitejs/plugin-react`. Vite automatically creates separate chunks for `React.lazy()` imports — no additional config needed. Frontend is deployed via AWS Amplify with `vite build` producing output to `dist/`.

**Routing analysis** — two patterns need lazy loading:

1. Direct route elements: `StudentChat`, `CourseView`, `InstructorHomepage` are rendered directly in `<Route element={...}>` — straightforward to lazy load.

2. Conditional `getHomePage()` function: Returns `AdminHomepage`, `InstructorHomepage`, or `StudentHomepage` based on `userGroup` state. Lazy components work here since React renders them like normal components — `<Suspense>` just needs to wrap the `<Routes>`.

**Props compatibility**: All lazy-loaded components receive props (`course`, `module`, `setCourse`, `setModule`). `React.lazy()` components accept props normally — no issue.

**`Login` should NOT be lazy loaded**: It's the first page users see (the `/` route redirects to it when unauthenticated). Lazy loading it would add a loading flash on the very first page load.

### Recommended Change

In `frontend/src/App.jsx`, replace eager imports with lazy imports for role-specific pages:

```jsx
import { lazy, Suspense } from "react";

// Login stays eagerly loaded — it's the entry point
import Login from "./pages/Login";

// Role-specific pages lazy loaded
const StudentHomepage = lazy(() => import("./pages/student/StudentHomepage"));
const StudentChat = lazy(() => import("./pages/student/StudentChat"));
const AdminHomepage = lazy(() => import("./pages/admin/AdminHomepage"));
const InstructorHomepage = lazy(() => import("./pages/instructor/InstructorHomepage"));
const CourseView = lazy(() => import("./pages/student/CourseView"));
```

Wrap `<Routes>` in `<Suspense>`:

```jsx
<Router>
  <Suspense fallback={<div>Loading...</div>}>
    <Routes>
      {/* ... existing routes unchanged ... */}
    </Routes>
  </Suspense>
</Router>
```

The Suspense fallback could be improved with the existing `l-helix` spinner pattern already used in `StudentHomepage` and `CourseView`, but a simple `<div>Loading...</div>` works as a starting point.

### Risk Assessment

- **Breaking changes**: None. `React.lazy()` is a stable React 18 API. Vite handles chunk splitting automatically.
- **Loading flash**: Users will see the Suspense fallback briefly on first navigation to a lazy-loaded route. This is a one-time cost per route per session (chunks are cached by the browser). The fallback should be kept minimal to avoid layout shift.
- **Error handling**: If a chunk fails to load (network error), React will throw an error. Consider adding an error boundary around `<Suspense>` for production robustness, but this is optional for the initial implementation.
- **No Vite config changes needed**: Vite's default code splitting handles `React.lazy()` imports out of the box.
- **Biggest win**: Students (the most common role) will no longer download the instructor pages, `recharts`, or `material-react-table`. This is the largest bundle reduction.

---

## P-5: Cache Bedrock LLM Model Configuration (Low Impact)

`TextGenLambdaDockerFunc` calls SSM Parameter Store for 3 parameters on every cold start. These are already cached in global variables for warm invocations. The SSM calls only add ~50-100ms on cold starts.

This is already partially implemented. The remaining improvement (Lambda Extensions for background refresh) is marginal. Defer unless cold starts are frequent.

### Deep Dive Verification

**SSM parameter caching** (`text_generation/src/main.py`):

Three SSM parameters are fetched in `initialize_constants()`:
- `BEDROCK_LLM_ID` — default LLM model ID (`meta.llama3-70b-instruct-v1:0`)
- `EMBEDDING_MODEL_ID` — embedding model ID (`amazon.titan-embed-text-v2:0`)
- `TABLE_NAME` — DynamoDB table name (`DynamoDB-Conversation-Table`)

The caching pattern works correctly:
1. Global variables (`BEDROCK_LLM_ID`, `EMBEDDING_MODEL_ID`, `TABLE_NAME`) start as `None`
2. `get_parameter(param_name, cached_var)` only calls SSM when `cached_var is None`
3. `initialize_constants()` assigns the return value back to the global, so on warm invocations the cached value is passed in and SSM is skipped
4. `BedrockEmbeddings` initialization is also guarded by `if embeddings is None` — only runs on cold start

**Conclusion: SSM caching is already fully implemented.** No further SSM optimization is needed.

**However, a related issue was found — `create_dynamodb_history_table` runs on every invocation:**

`initialize_constants()` calls `create_dynamodb_history_table(TABLE_NAME)` unconditionally (no cache guard). This function:
1. Creates a new `boto3.resource("dynamodb")` and `boto3.client("dynamodb")` on every call
2. Calls `dynamodb_client.list_tables()` (paginated) to check if the table exists
3. Only creates the table if it doesn't exist

On warm invocations, the table already exists, but the `list_tables` call still happens every time. This adds ~10-30ms of unnecessary overhead per request (DynamoDB API call via NAT Gateway or VPC endpoint).

**Same pattern in data ingestion** (`data_ingestion/src/main.py`): Uses the same SSM caching pattern for 1 parameter (`EMBEDDING_MODEL_ID`). Caching works correctly. No `create_dynamodb_history_table` call.

**Same pattern in deleteLastMessage** (`lambda/deleteLastMessage/deleteLastMessage.py`): Uses the same SSM caching pattern for 1 parameter (`TABLE_NAME`). Caching works correctly.

### Recommended Change

The original P-5 recommendation (Lambda Extensions for background SSM refresh) is not needed — caching is already working.

Instead, the actionable improvement is to guard `create_dynamodb_history_table` with a global flag so it only runs once per Lambda container lifetime:

```python
# Add to global cached resources
_dynamodb_table_checked = False

def initialize_constants():
    global BEDROCK_LLM_ID, EMBEDDING_MODEL_ID, TABLE_NAME, embeddings, _dynamodb_table_checked
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    EMBEDDING_MODEL_ID = get_parameter(EMBEDDING_MODEL_PARAM, EMBEDDING_MODEL_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)

    if embeddings is None:
        embeddings = BedrockEmbeddings(
            model_id=EMBEDDING_MODEL_ID,
            client=bedrock_runtime,
            region_name=REGION,
        )
    
    if not _dynamodb_table_checked:
        create_dynamodb_history_table(TABLE_NAME)
        _dynamodb_table_checked = True
```

This eliminates the `list_tables` DynamoDB call on every warm invocation.

### Risk Assessment

- **Breaking changes**: None. The DynamoDB table is created once and persists. Checking on every invocation is redundant after the first successful check.
- **Edge case**: If the table is deleted externally while the Lambda container is warm, the flag would prevent re-creation. This is an extremely unlikely operational scenario and would require a Lambda redeployment anyway.
- **Impact**: Saves ~10-30ms per warm invocation by eliminating the unnecessary `list_tables` call. Small but free improvement.
- **Original P-5 recommendation (Lambda Extensions)**: Not needed. SSM caching is already working correctly. Defer/remove from the plan.

---

## P-6: Optimize Hybrid Search Connection Management (Low Impact)

The `hybrid_search` function in `vectorstore.py` opens a new `psycopg2` connection for every search call, and potentially opens a second connection for missing IDs:

```python
conn = psycopg2.connect(connection_string)  # new connection every call
# ... vector search + keyword search ...
conn.close()

# If missing IDs:
conn2 = psycopg2.connect(connection_string)  # another new connection
```

Each connection establishment to RDS Proxy takes ~10-30ms. The handler already maintains a global `connection` object — pass it to `hybrid_search` instead of creating new ones.

### Deep Dive Verification

**Connection inventory per request** — the text generation handler currently creates/uses these connections:

1. **Global `connection`** (`main.py`): Created by `connect_to_db()`, cached globally across warm invocations. Used for DB queries (`get_module_context`, `get_allowed_file_ids`) and passed to `get_response()` for `get_other_module_names()`. Uses psycopg2 keyword format: `"dbname=X user=Y password=Z host=H port=P"`.

2. **PGVector internal connection** (`helper.py:get_vectorstore()`): Creates a `PGVector` instance with a SQLAlchemy connection string (`postgresql+psycopg://...`). This initializes a SQLAlchemy engine and connection pool. **However, the returned `vectorstore` object is never used** — `get_vectorstore_retriever()` assigns it to a variable that is never referenced again. This is entirely wasted initialization.

3. **`hybrid_search` connection #1** (`vectorstore.py`): `psycopg2.connect(connection_string)` — new connection every call. Used for vector search + keyword search queries. Closed after use.

4. **`hybrid_search` connection #2** (`vectorstore.py`): Conditionally created if keyword-only results need document content fetched (`missing_ids`). Another `psycopg2.connect()`. Closed after use.

**All connections use the same credentials and endpoint**: The global connection, PGVector, and hybrid_search all connect to the same RDS Proxy with the same `db_secret` credentials. Verified by tracing `vectorstore_config_dict` construction in the handler — it uses the same `db_secret` and `RDS_PROXY_ENDPOINT` as `connect_to_db()`.

**Call sequence**: `hybrid_search` runs during `get_response()`, which is called after all DB queries succeed. The global connection is in a clean state at that point (read-only SELECTs don't leave dirty transaction state).

**Transaction safety**: Both the global connection and `hybrid_search` only execute SELECT queries (read-only). psycopg2 defaults to autocommit=False with implicit transactions, but read-only queries are safe to run on a shared connection sequentially. No commits needed.

**`missing_ids` scenario**: The second connection (`conn2`) is created when keyword search returns document IDs that weren't in the vector search results (so their full content needs fetching). This happens when keyword search finds relevant documents that vector search missed. The frequency depends on data distribution but it's a common case.

### Recommended Changes

**Change 1: Remove the unused `get_vectorstore()` call**

In `get_vectorstore_retriever()`, the `PGVector` instance is created but never used. Remove it:

```python
def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None
):
    # PGVector initialization removed — hybrid_search uses raw SQL directly

    collection_name = vectorstore_config_dict['collection_name']
    psycopg2_connection_string = (
        f"dbname={vectorstore_config_dict['dbname']} "
        f"user={vectorstore_config_dict['user']} "
        f"password={vectorstore_config_dict['password']} "
        f"host={vectorstore_config_dict['host']} "
        f"port={vectorstore_config_dict['port']}"
    )
    # ... rest unchanged
```

This eliminates a wasted SQLAlchemy engine initialization + connection pool creation per request. Also remove the `from helpers.helper import get_vectorstore` import.

**Change 2: Pass the global connection to `hybrid_search`**

Modify `hybrid_search` to accept an optional `connection` parameter. If provided, use it instead of creating a new one (and don't close it, since it's owned by the caller):

```python
def hybrid_search(
    query: str,
    query_embedding: List[float],
    connection_string: str,
    collection_name: str,
    allowed_file_ids: Optional[List[str]],
    k: int = TOP_K,
    connection=None  # new optional parameter
) -> List[Document]:
    owns_connection = connection is None
    conn = connection if connection else psycopg2.connect(connection_string)
    cur = conn.cursor()

    # ... existing vector_sql + keyword_sql query logic unchanged ...

    cur.close()
    # NOTE: Do NOT close conn here — we may need it for missing_ids below

    # ... existing blending logic unchanged (pure Python, no DB) ...

    # For missing_ids, reuse the same connection instead of opening conn2
    if missing_ids:
        cur2 = conn.cursor()
        # ... fetch missing docs ...
        cur2.close()

    # Only close if we created the connection ourselves
    if owns_connection:
        conn.close()

    return [...]
```

Update `get_vectorstore_retriever` to pass the connection through:

```python
def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None,
    connection=None  # new parameter
):
    # ...
    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids,
            connection=connection
        )
```

And in the handler, pass the global connection:

```python
history_aware_retriever = get_vectorstore_retriever(
    llm=llm,
    vectorstore_config_dict=vectorstore_config_dict,
    embeddings=embeddings,
    allowed_file_ids=allowed_file_ids,
    connection=connect_to_db()
)
```

### Risk Assessment

- **Change 1 (remove unused PGVector)**: Zero risk. The `vectorstore` variable is assigned but never read. Removing it eliminates dead code and a wasted connection pool initialization.
- **Change 2 (pass connection)**: Low risk. The connection is used for read-only SELECTs only. The `missing_ids` fetch can reuse the same connection instead of opening `conn2` — just open a new cursor. The `connection_string` parameter is kept as fallback if no connection is passed, maintaining backward compatibility.
- **Connection lifecycle**: The global connection is managed by `connect_to_db()` and persists across warm invocations. `hybrid_search` must not close it. The `owns_connection` flag handles this.
- **Error handling**: If a query fails in `hybrid_search`, the connection's transaction state will be dirty. The current code has no try/except — exceptions propagate and the owned connection is garbage collected. With a passed connection, a failed query would leave the global connection in `InFailedSqlTransaction` state, breaking subsequent queries. **The implementation must wrap the DB operations in try/except and call `conn.rollback()` on error when using a passed connection.** This is the same pattern used by the existing DB query functions in `main.py`.
- **Impact**: Eliminates 1-2 `psycopg2.connect()` calls per request (~10-30ms each) plus 1 wasted SQLAlchemy engine initialization. Total savings: ~30-70ms per request.
- **Note on current code**: The existing `hybrid_search` closes `conn` before the blending logic, then must open `conn2` for missing IDs because `conn` is already closed. The refactored version defers the close to the end, allowing both the main queries and the `missing_ids` fetch to share one connection.

---

## P-7: Parallelize Frontend `create_message` and `text_generation` Calls (Medium Impact)

### Deep Dive Verification

**Current chat flow** (`frontend/src/pages/student/StudentChat.jsx`):

When a student sends a message, the frontend makes these sequential API calls:

1. `POST student/create_message` — saves student message to `Messages` table, updates `Sessions.last_accessed`, logs to `User_Engagement_Log` (runs in `studentFunction` Lambda, VPC)
2. `POST student/text_generation` — the slow LLM call (runs in `TextGenLambdaDockerFunc`, VPC)
3. `PUT student/update_session_name` + `POST student/update_module_score` — parallel, after text gen
4. `POST student/create_ai_message` — saves AI response to DB, after step 3

Step 1 must complete before step 2 starts (chained `.then()` promises). This adds ~100-300ms (API Gateway → authorizer → studentFunction Lambda → RDS Proxy → DB) before the text generation Lambda even begins.

**The text generation Lambda does NOT depend on `create_message`**: The `text_generation` endpoint receives the message content in the request body (`message_content`). It never reads from the `Messages` table. The `create_message` call is purely for persistence/logging — it doesn't produce data that `text_generation` needs.

**Why they're currently sequential**: The frontend uses the `messageData` response from `create_message` to set `setNewMessage(messageData[0])` (updates the UI with the saved message) and extracts `messageData[0].message_content` to pass to `text_generation`. But the message content is already available in the local `messageContent` variable — it doesn't need to come from the DB response.

### Recommended Change

Fire `create_message` and `text_generation` in parallel using `Promise.all` (or fire-and-forget `create_message`):

```javascript
// Instead of: create_message.then(() => text_generation)
// Do: Promise.all([create_message, text_generation])

const [messageResponse, textGenResponse] = await Promise.all([
  fetch(messageUrl, { method: "POST", headers: {...}, body: JSON.stringify({ message_content: messageContent }) }),
  fetch(textGenUrl, { method: "POST", headers: {...}, body: JSON.stringify({ message_content: messageContent }) }),
]);
```

Update the UI with the local `messageContent` immediately instead of waiting for the `create_message` response.

**UI update note**: Currently `setNewMessage(messageData[0])` uses the DB response object (which has `message_id`, `session_id`, `student_sent`, `message_content`, `time_sent`). With parallelization, show the message optimistically using a locally constructed object before `create_message` resolves. This is actually better UX — the student sees their message instantly.

### Risk Assessment

- **Breaking changes**: None. The two API calls are independent — they hit different Lambda functions and different DB tables.
- **Failure handling**: If `create_message` fails but `text_generation` succeeds, the student sees the AI response but the message isn't persisted. This is acceptable — the DynamoDB chat history (used by the RAG chain) still has the message. The `Messages` table is used for analytics/logging, not for the chat flow.
- **Race condition**: None. The two Lambdas operate on different tables and don't share state.
- **Impact**: Saves ~100-300ms per message by overlapping the DB write with the start of LLM processing. The LLM call takes 2-10+ seconds, so the `create_message` call completes well before the LLM response arrives.

---

## P-8: Move `preSignupLambda` Out of VPC (Low Impact)

### Deep Dive Verification

**Code analysis** (`lambda/lib/preSignup.js`):

The `preSignupLambda` is a Cognito Pre Sign-Up trigger. It does exactly one thing: calls SSM Parameter Store (`GetParameterCommand`) to fetch allowed email domains, then validates the signup email against that list.

SSM Parameter Store is a public AWS service — no VPC access needed.

**CDK configuration** (`api-gateway-stack.ts`):

```typescript
const preSignupLambda = new lambda.Function(this, `${id}-preSignupLambda`, {
  // ...
  vpc: vpcStack.vpc,  // ← unnecessary
  role: coglambdaRole,
});
```

Uses `coglambdaRole` which is shared with `addStudentOnSignUp` and `adjustUserRoles` (both need VPC for DB access). Same situation as P-3 — the role's EC2 permissions become unused but harmless.

### Recommended Change

Remove `vpc: vpcStack.vpc` from the `preSignupLambda` definition.

### Risk Assessment

- **Breaking changes**: None. Only accesses SSM (public service).
- **Impact**: Eliminates 1-5s VPC cold start on signup attempts after idle. Low frequency (only on signups), but improves the signup experience.
- **Deployment note**: Same as P-3 — CloudFormation resource replacement, brief downtime during deployment.
