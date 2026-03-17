# Cross-File Referencing Implementation Plan

## Overview

This document defines the implementation plan for allowing a module to reference uploaded files from other modules in the same course. When a student chats in a module, the RAG retrieval pipeline will include chunks from any cross-referenced files in addition to the module's own files.

The approach is **file-level referencing (Option A)**: instructors select specific files from other modules, stored in a junction table, and the vectorstore filters chunks by `file_id` at retrieval time.

---

## Key Design Decisions

- **File-level granularity**: references are to individual files, not entire modules
- **`file_id` stamped on chunk metadata**: every chunk in the vectorstore carries a `file_id` so retrieval can filter precisely
- **Full-replace on save**: `PUT /instructor/module_file_references` deletes existing references and inserts the new set — no separate add/remove endpoints needed
- **Own module files excluded from dropdown**: files belonging to the module being created/edited are always implicitly included and should not appear in the multi-select
- **Empty references fallback**: if a module has no entries in `Module_File_References`, retrieval falls back to only the module's own files
- **Backfill for existing chunks**: a one-time migration in `initializer.py` stamps `file_id` onto existing vectorstore chunks that predate this feature

---

## Important Note on Create Flow Timing

When a new module is created, the `Module_Files` rows for its uploaded files **do not exist yet** at save time. The actual sequence is:

1. `POST /instructor/create_module` → creates `Course_Modules` row, returns `module_id`
2. `uploadFiles(...)` → files uploaded directly to S3 via presigned URLs
3. S3 upload triggers the data ingestion Lambda **asynchronously** → this creates `Module_Files` rows and vectorstore chunks

This means the multi-select dropdown on the create page can only reference files from **other already-existing modules** (which is the intended use case). The save flow for create is:

1. `POST /instructor/create_module` → get `module_id`
2. `uploadFiles(...)` → S3 upload
3. `PUT /instructor/module_file_references?module_id=<new_module_id>` → save selected cross-module references

---

## Files Changed

| File | Change |
|---|---|
| `cdk/lambda/initializer/initializer.py` | New `Module_File_References` table + backfill migration |
| `cdk/data_ingestion/src/main.py` | Fetch `file_id` after insert, pass to vectorstore update |
| `cdk/data_ingestion/src/helpers/helper.py` | Thread `file_id` through to `process_documents` |
| `cdk/data_ingestion/src/processing/documents.py` | Stamp `file_id` on chunk metadata |
| `cdk/lambda/lib/instructorFunction.js` | 3 new route cases |
| `cdk/OpenAPI_Swagger_Definition.yaml` | 3 new route definitions for API Gateway |
| `frontend/src/pages/instructor/InstructorNewModule.jsx` | Multi-select dropdown + save references |
| `frontend/src/pages/instructor/InstructorEditCourse.jsx` | Multi-select dropdown + pre-populate + save references |
| `cdk/text_generation/src/main.py` | Resolve `allowed_file_ids` from DB |
| `cdk/text_generation/src/helpers/vectorstore.py` | Apply `file_id` filter + hybrid search retrieval |

---

## 1. Database — `cdk/lambda/initializer/initializer.py`

### A) New Table

Add to the `sqlTableCreation` block:

```sql
CREATE TABLE IF NOT EXISTS "Module_File_References" (
    source_module_id   uuid REFERENCES "Course_Modules"(module_id) ON DELETE CASCADE,
    referenced_file_id uuid REFERENCES "Module_Files"(file_id) ON DELETE CASCADE,
    PRIMARY KEY (source_module_id, referenced_file_id)
);
```

### B) Backfill Migration Block

After the table creation, add a conditional migration block that runs once. For each row in `Module_Files`, update the `langchain_pg_embedding` table (PGVector's internal table) to stamp `file_id` into the `cmetadata` JSONB column where the chunk's `source` metadata matches the file's S3 path.

```python
# Backfill file_id into existing vectorstore chunks
cursor.execute("""
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'langchain_pg_embedding'
    )
""")
if cursor.fetchone()[0]:
    cursor.execute("""
        SELECT file_id, module_id, filename, filetype
        FROM "Module_Files";
    """)
    files = cursor.fetchall()
    for file_id, module_id, filename, filetype in files:
        s3_path_pattern = f"%/{module_id}/documents/{filename}.{filetype}%"
        cursor.execute("""
            UPDATE langchain_pg_embedding
            SET cmetadata = cmetadata || jsonb_build_object('file_id', %s::text)
            WHERE cmetadata->>'source' LIKE %s
            AND cmetadata->>'file_id' IS NULL;
        """, (str(file_id), s3_path_pattern))
    connection.commit()
```

---

## 2. Data Ingestion — Stamp `file_id` on Chunks

### `cdk/data_ingestion/src/main.py`

After `insert_file_into_db(...)` succeeds, query `Module_Files` to retrieve the `file_id` for the just-inserted/updated file. Pass it down to `update_vectorstore_from_s3`.

```python
# After insert_file_into_db(...)
file_id = get_file_id_from_db(module_id, file_name, file_type)

# Pass file_id into vectorstore update
update_vectorstore_from_s3(bucket_name, course_id, module_id, file_id)
```

Add a helper function:

```python
def get_file_id_from_db(module_id, file_name, file_type):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT file_id FROM "Module_Files"
            WHERE module_id = %s AND filename = %s AND filetype = %s;
        """, (module_id, file_name, file_type))
        result = cur.fetchone()
        cur.close()
        return str(result[0]) if result else None
    except Exception as e:
        logger.error(f"Error fetching file_id: {e}")
        return None
```

Update `update_vectorstore_from_s3` signature to accept and pass through `file_id`:

```python
def update_vectorstore_from_s3(bucket, course_id, module_id, file_id):
    # ... existing setup ...
    update_vectorstore(
        bucket=bucket,
        course=course_id,
        module=module_id,
        vectorstore_config_dict=vectorstore_config_dict,
        embeddings=embeddings,
        file_id=file_id
    )
```

### `cdk/data_ingestion/src/helpers/helper.py`

Thread `file_id` through `store_module_data` to `process_documents`:

```python
def store_module_data(bucket, course, module, vectorstore_config_dict, embeddings, file_id):
    # ... existing vectorstore init ...
    process_documents(
        bucket=bucket,
        course=course,
        module=module,
        vectorstore=vectorstore,
        embeddings=embeddings,
        record_manager=record_manager,
        file_id=file_id
    )
```

### `cdk/data_ingestion/src/helpers/vectorstore.py`

Pass `file_id` through to `store_module_data`:

```python
def update_vectorstore(bucket, course, module, vectorstore_config_dict, embeddings, file_id):
    store_module_data(
        bucket=bucket,
        course=course,
        module=module,
        vectorstore_config_dict=vectorstore_config_dict,
        embeddings=embeddings,
        file_id=file_id
    )
```

### `cdk/data_ingestion/src/processing/documents.py`

`process_documents` receives `file_id` and passes it to `add_document` → `store_doc_chunks`. In `store_doc_chunks`, stamp it on every chunk:

```python
doc_chunk.metadata["file_id"] = file_id
```

---

## 3. Backend

### `cdk/OpenAPI_Swagger_Definition.yaml`

The API Gateway is driven entirely by the OpenAPI spec — any route added to `instructorFunction.js` that isn't declared here will return a 404. Add the following three path blocks. Each follows the same pattern as existing instructor routes: an `options` block for CORS, then the HTTP method block with `instructorAuthorizer` security and `x-amazon-apigateway-integration` pointing to `instructorFunction.Arn`.

```yaml
  /instructor/course_files:
    options:
      summary: CORS support
      description: |
        Enable CORS by returning correct headers
      responses:
        200:
          $ref: "#/components/responses/Success"
      x-amazon-apigateway-integration:
        type: mock
        requestTemplates:
          application/json: |
            {
              "statusCode" : 200
            }
        responses:
          default:
            statusCode: "200"
            responseParameters:
              method.response.header.Access-Control-Allow-Headers: "'Content-Type,X-Amz-Date,Authorization,X-Api-Key'"
              method.response.header.Access-Control-Allow-Methods: "'*'"
              method.response.header.Access-Control-Allow-Origin: "'*'"
            responseTemplates:
              application/json: |
                {}
    get:
      tags:
        - Instructor
      summary: Get all files across all modules in a course
      operationId: instructor_course_files_GET
      parameters:
        - in: query
          name: course_id
          required: true
          description: The ID of the course
          schema:
            type: string
      responses:
        "200":
          description: Files retrieved successfully
        "400":
          description: Bad Request
        "401":
          description: Unauthorized
        "429":
          description: Too Many Requests
        "500":
          description: Internal Server Error
      security:
        - instructorAuthorizer: []
      x-amazon-apigateway-integration:
        uri:
          Fn::Sub: "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${instructorFunction.Arn}/invocations"
        passthroughBehavior: "when_no_match"
        httpMethod: "POST"
        type: "aws_proxy"

  /instructor/module_file_references:
    options:
      summary: CORS support
      description: |
        Enable CORS by returning correct headers
      responses:
        200:
          $ref: "#/components/responses/Success"
      x-amazon-apigateway-integration:
        type: mock
        requestTemplates:
          application/json: |
            {
              "statusCode" : 200
            }
        responses:
          default:
            statusCode: "200"
            responseParameters:
              method.response.header.Access-Control-Allow-Headers: "'Content-Type,X-Amz-Date,Authorization,X-Api-Key'"
              method.response.header.Access-Control-Allow-Methods: "'*'"
              method.response.header.Access-Control-Allow-Origin: "'*'"
            responseTemplates:
              application/json: |
                {}
    get:
      tags:
        - Instructor
      summary: Get cross-file references for a module
      operationId: instructor_module_file_references_GET
      parameters:
        - in: query
          name: module_id
          required: true
          description: The ID of the module
          schema:
            type: string
      responses:
        "200":
          description: References retrieved successfully
        "400":
          description: Bad Request
        "401":
          description: Unauthorized
        "429":
          description: Too Many Requests
        "500":
          description: Internal Server Error
      security:
        - instructorAuthorizer: []
      x-amazon-apigateway-integration:
        uri:
          Fn::Sub: "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${instructorFunction.Arn}/invocations"
        passthroughBehavior: "when_no_match"
        httpMethod: "POST"
        type: "aws_proxy"
    put:
      tags:
        - Instructor
      summary: Set cross-file references for a module (full replace)
      operationId: instructor_module_file_references_PUT
      parameters:
        - in: query
          name: module_id
          required: true
          description: The ID of the module
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                referenced_file_ids:
                  type: array
                  items:
                    type: string
                  description: List of file IDs to reference
      responses:
        "200":
          description: References updated successfully
        "400":
          description: Bad Request
        "401":
          description: Unauthorized
        "429":
          description: Too Many Requests
        "500":
          description: Internal Server Error
      security:
        - instructorAuthorizer: []
      x-amazon-apigateway-integration:
        uri:
          Fn::Sub: "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${instructorFunction.Arn}/invocations"
        passthroughBehavior: "when_no_match"
        httpMethod: "POST"
        type: "aws_proxy"
```

### `cdk/lambda/lib/instructorFunction.js`

Add three new cases to the existing switch statement.

### `GET /instructor/course_files`

Query params: `course_id`

Returns all files across all modules in the course. Used to populate the multi-select dropdown, grouped by module.

```javascript
case "GET /instructor/course_files":
  if (event.queryStringParameters?.course_id) {
    const { course_id } = event.queryStringParameters;
    try {
      const files = await sqlConnection`
        SELECT
          mf.file_id,
          mf.filename,
          mf.filetype,
          mf.module_id,
          cm.module_name
        FROM "Module_Files" mf
        JOIN "Course_Modules" cm ON mf.module_id = cm.module_id
        JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
        WHERE cc.course_id = ${course_id}
        ORDER BY cm.module_number ASC, mf.filename ASC;
      `;
      response.statusCode = 200;
      response.body = JSON.stringify(files);
    } catch (err) {
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  } else {
    response.statusCode = 400;
    response.body = JSON.stringify({ error: "course_id is required" });
  }
  break;
```

### `GET /instructor/module_file_references`

Query params: `module_id`

Returns the current set of referenced file IDs for a module. Used by the edit page to pre-populate the multi-select.

```javascript
case "GET /instructor/module_file_references":
  if (event.queryStringParameters?.module_id) {
    const { module_id } = event.queryStringParameters;
    try {
      const refs = await sqlConnection`
        SELECT referenced_file_id
        FROM "Module_File_References"
        WHERE source_module_id = ${module_id};
      `;
      response.statusCode = 200;
      response.body = JSON.stringify(refs.map(r => r.referenced_file_id));
    } catch (err) {
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  } else {
    response.statusCode = 400;
    response.body = JSON.stringify({ error: "module_id is required" });
  }
  break;
```

### `PUT /instructor/module_file_references`

Query params: `module_id`
Body: `{ referenced_file_ids: [...] }`

Full replace — deletes all existing references for this module and inserts the new set. Handles empty array (clears all references).

```javascript
case "PUT /instructor/module_file_references":
  if (event.queryStringParameters?.module_id) {
    const { module_id } = event.queryStringParameters;
    const { referenced_file_ids } = JSON.parse(event.body || "{}");
    try {
      await sqlConnection`
        DELETE FROM "Module_File_References"
        WHERE source_module_id = ${module_id};
      `;
      if (referenced_file_ids?.length > 0) {
        await Promise.all(
          referenced_file_ids.map(file_id => sqlConnection`
            INSERT INTO "Module_File_References" (source_module_id, referenced_file_id)
            VALUES (${module_id}, ${file_id});
          `)
        );
      }
      response.statusCode = 200;
      response.body = JSON.stringify({ message: "Module file references updated successfully" });
    } catch (err) {
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  } else {
    response.statusCode = 400;
    response.body = JSON.stringify({ error: "module_id is required" });
  }
  break;
```

---

## 4. Frontend

### `frontend/src/pages/instructor/InstructorNewModule.jsx`

**New state:**
```javascript
const [referencedFileIds, setReferencedFileIds] = useState([]);
const [courseFiles, setCourseFiles] = useState([]);
```

**On mount** — fetch all course files (no module_id yet, so no filtering needed at fetch time):
```javascript
useEffect(() => {
  const fetchCourseFiles = async () => {
    const session = await fetchAuthSession();
    const token = session.tokens.idToken;
    const response = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}instructor/course_files?course_id=${encodeURIComponent(course_id)}`,
      { method: "GET", headers: { Authorization: token, "Content-Type": "application/json" } }
    );
    if (response.ok) {
      const data = await response.json();
      setCourseFiles(data); // files from other modules; own module doesn't exist yet
    }
  };
  fetchCourseFiles();
}, [course_id]);
```

**New UI element** — add below the Concept `<FormControl>` and above `<FileManagement>`:
```jsx
<FormControl fullWidth margin="normal">
  <InputLabel id="referenced-files-label">Reference Files from Other Modules (Optional)</InputLabel>
  <Select
    labelId="referenced-files-label"
    multiple
    value={referencedFileIds}
    onChange={(e) => setReferencedFileIds(e.target.value)}
    label="Reference Files from Other Modules (Optional)"
    renderValue={(selected) =>
      selected.map(id => {
        const f = courseFiles.find(f => f.file_id === id);
        return f ? `${f.filename}.${f.filetype}` : id;
      }).join(", ")
    }
  >
    {Object.entries(
      courseFiles.reduce((groups, file) => {
        (groups[file.module_name] = groups[file.module_name] || []).push(file);
        return groups;
      }, {})
    ).map(([moduleName, files]) => [
      <ListSubheader key={moduleName}>{titleCase(moduleName)}</ListSubheader>,
      ...files.map(file => (
        <MenuItem key={file.file_id} value={file.file_id}>
          {file.filename}.{file.filetype}
        </MenuItem>
      ))
    ])}
  </Select>
</FormControl>
```

**On save** — after `uploadFiles(...)` completes, call the references endpoint:
```javascript
await fetch(
  `${import.meta.env.VITE_API_ENDPOINT}instructor/module_file_references?module_id=${encodeURIComponent(updatedModule.module_id)}`,
  {
    method: "PUT",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ referenced_file_ids: referencedFileIds }),
  }
);
```

**Add `ListSubheader` to MUI imports.**

---

### `frontend/src/pages/instructor/InstructorEditCourse.jsx`

**New state:**
```javascript
const [referencedFileIds, setReferencedFileIds] = useState([]);
const [courseFiles, setCourseFiles] = useState([]);
```

**On mount** — fetch course files and existing references. Filter out files belonging to the current module:
```javascript
useEffect(() => {
  if (!module) return;
  const fetchCrossFileData = async () => {
    const session = await fetchAuthSession();
    const token = session.tokens.idToken;

    const [filesRes, refsRes] = await Promise.all([
      fetch(
        `${import.meta.env.VITE_API_ENDPOINT}instructor/course_files?course_id=${encodeURIComponent(course_id)}`,
        { method: "GET", headers: { Authorization: token, "Content-Type": "application/json" } }
      ),
      fetch(
        `${import.meta.env.VITE_API_ENDPOINT}instructor/module_file_references?module_id=${encodeURIComponent(module.module_id)}`,
        { method: "GET", headers: { Authorization: token, "Content-Type": "application/json" } }
      )
    ]);

    if (filesRes.ok) {
      const data = await filesRes.json();
      // Exclude files belonging to the current module
      setCourseFiles(data.filter(f => f.module_id !== module.module_id));
    }
    if (refsRes.ok) {
      const refs = await refsRes.json();
      setReferencedFileIds(refs);
    }
  };
  fetchCrossFileData();
}, [module]);
```

**New UI element** — same multi-select as the create page, placed below the Concept `<FormControl>` and above `<FileManagement>`.

**On save** — add to the existing `handleSave` try block alongside `updateModule()`:
```javascript
await fetch(
  `${import.meta.env.VITE_API_ENDPOINT}instructor/module_file_references?module_id=${encodeURIComponent(module.module_id)}`,
  {
    method: "PUT",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ referenced_file_ids: referencedFileIds }),
  }
);
```

**Add `ListSubheader` to MUI imports.**

---

## 5. Retrieval — `cdk/text_generation`

### Overview of Retrieval Pipeline

The retrieval pipeline runs two searches in parallel against `langchain_pg_embedding` (PGVector's internal table), both filtered to `allowed_file_ids`:

1. **Vector search** — cosine similarity between the query embedding and chunk embeddings
2. **Keyword search** — PostgreSQL full-text search (`tsvector`/`tsquery`) against chunk text

Scores are normalised to [0, 1] and blended:
```
final_score = 0.7 * vector_score + 0.3 * keyword_score
```
The top 6 chunks by final score are returned to the LLM.

This is implemented as a custom retrieval function in `vectorstore.py` that replaces the default `vectorstore.as_retriever()` call. No new infrastructure, no extra API calls — both queries run on the existing RDS instance.

### `cdk/text_generation/src/main.py`

After `module_id` is validated, resolve `allowed_file_ids` from the DB before building the vectorstore config:

```python
def get_allowed_file_ids(module_id):
    connection = connect_to_db()
    try:
        cur = connection.cursor()
        # Own files
        cur.execute("""
            SELECT file_id FROM "Module_Files"
            WHERE module_id = %s;
        """, (module_id,))
        own_ids = [str(row[0]) for row in cur.fetchall()]

        # Referenced files
        cur.execute("""
            SELECT referenced_file_id FROM "Module_File_References"
            WHERE source_module_id = %s;
        """, (module_id,))
        ref_ids = [str(row[0]) for row in cur.fetchall()]

        cur.close()
        return own_ids + ref_ids
    except Exception as e:
        logger.error(f"Error fetching allowed_file_ids: {e}")
        return []
```

Call it in `handler` and pass the result to `get_vectorstore_retriever`:

```python
allowed_file_ids = get_allowed_file_ids(module_id)

history_aware_retriever = get_vectorstore_retriever(
    llm=llm,
    vectorstore_config_dict=vectorstore_config_dict,
    embeddings=embeddings,
    allowed_file_ids=allowed_file_ids
)
```

### `cdk/text_generation/src/helpers/vectorstore.py`

Replace `vectorstore.as_retriever()` with a custom hybrid retrieval function. The function queries `langchain_pg_embedding` directly using both vector similarity and PostgreSQL full-text search, normalises both scores, blends them, and returns the top chunks as LangChain `Document` objects wrapped in a `RunnableLambda` so the rest of the chain (history-aware retriever, `create_retrieval_chain`) works unchanged.

```python
from typing import Dict, List, Optional
import psycopg2
from langchain_core.documents import Document
from langchain_core.runnables import RunnableLambda
from langchain_core.vectorstores import VectorStoreRetriever
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.chains import create_history_aware_retriever
from helpers.helper import get_vectorstore

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3
TOP_K = 6

def hybrid_search(
    query: str,
    query_embedding: List[float],
    connection_string: str,
    collection_name: str,
    allowed_file_ids: Optional[List[str]],
    k: int = TOP_K
) -> List[Document]:
    """
    Run vector search and keyword search against langchain_pg_embedding,
    blend scores, and return top k chunks as Documents.
    """
    conn = psycopg2.connect(connection_string)
    cur = conn.cursor()

    file_id_filter = ""
    params_base = [collection_name]

    if allowed_file_ids:
        placeholders = ",".join(["%s"] * len(allowed_file_ids))
        file_id_filter = f"AND e.cmetadata->>'file_id' IN ({placeholders})"
        params_base += allowed_file_ids

    # Vector search — cosine similarity via pgvector operator
    # 1 - (embedding <=> query_embedding) gives similarity in [0, 1]
    vector_sql = f"""
        SELECT
            e.id,
            e.document,
            e.cmetadata,
            1 - (e.embedding <=> %s::vector) AS vector_score
        FROM langchain_pg_embedding e
        JOIN langchain_pg_collection c ON e.collection_id = c.uuid
        WHERE c.name = %s
        {file_id_filter}
        ORDER BY vector_score DESC
        LIMIT 20;
    """
    cur.execute(vector_sql, [query_embedding] + params_base)
    vector_rows = cur.fetchall()  # (id, document, cmetadata, vector_score)

    # Keyword search — PostgreSQL full-text search
    keyword_sql = f"""
        SELECT
            e.id,
            ts_rank_cd(
                to_tsvector('english', e.document),
                plainto_tsquery('english', %s)
            ) AS keyword_score
        FROM langchain_pg_embedding e
        JOIN langchain_pg_collection c ON e.collection_id = c.uuid
        WHERE c.name = %s
        AND to_tsvector('english', e.document) @@ plainto_tsquery('english', %s)
        {file_id_filter}
        ORDER BY keyword_score DESC
        LIMIT 20;
    """
    cur.execute(keyword_sql, [query, collection_name, query] + (allowed_file_ids or []))
    keyword_rows = cur.fetchall()  # (id, keyword_score)

    cur.close()
    conn.close()

    # Build score maps
    vector_scores = {row[0]: row for row in vector_rows}  # id -> full row
    keyword_scores = {row[0]: row[1] for row in keyword_rows}  # id -> score

    # Normalise keyword scores to [0, 1]
    max_kw = max(keyword_scores.values(), default=1) or 1
    keyword_scores_norm = {id_: score / max_kw for id_, score in keyword_scores.items()}

    # Normalise vector scores to [0, 1] (already roughly in range but normalise for safety)
    max_vec = max((row[3] for row in vector_rows), default=1) or 1

    # Blend scores across union of candidate ids
    all_ids = set(vector_scores.keys()) | set(keyword_scores_norm.keys())
    blended = []
    for id_ in all_ids:
        v_score = (vector_scores[id_][3] / max_vec) if id_ in vector_scores else 0.0
        k_score = keyword_scores_norm.get(id_, 0.0)
        final = VECTOR_WEIGHT * v_score + KEYWORD_WEIGHT * k_score
        blended.append((id_, final))

    blended.sort(key=lambda x: x[1], reverse=True)
    top_ids = [id_ for id_, _ in blended[:k]]

    # Build Document objects from vector_rows (which contain document text + metadata)
    id_to_row = {row[0]: row for row in vector_rows}
    # For ids that only appeared in keyword results, fetch their text
    missing_ids = [id_ for id_ in top_ids if id_ not in id_to_row]
    if missing_ids:
        conn2 = psycopg2.connect(connection_string)
        cur2 = conn2.cursor()
        placeholders = ",".join(["%s"] * len(missing_ids))
        cur2.execute(
            f"SELECT id, document, cmetadata FROM langchain_pg_embedding WHERE id IN ({placeholders});",
            missing_ids
        )
        for row in cur2.fetchall():
            id_to_row[row[0]] = (row[0], row[1], row[2], 0.0)
        cur2.close()
        conn2.close()

    docs = []
    for id_ in top_ids:
        if id_ in id_to_row:
            row = id_to_row[id_]
            docs.append(Document(page_content=row[1], metadata=row[2] or {}))

    return docs


def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    allowed_file_ids: Optional[List[str]] = None
) -> VectorStoreRetriever:
    """
    Returns a history-aware retriever using hybrid search (vector + keyword).
    """
    vectorstore, connection_string = get_vectorstore(
        collection_name=vectorstore_config_dict['collection_name'],
        embeddings=embeddings,
        dbname=vectorstore_config_dict['dbname'],
        user=vectorstore_config_dict['user'],
        password=vectorstore_config_dict['password'],
        host=vectorstore_config_dict['host'],
        port=int(vectorstore_config_dict['port'])
    )

    collection_name = vectorstore_config_dict['collection_name']

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids
        )

    retriever = RunnableLambda(retrieve)

    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history. Do NOT answer the question, "
        "just reformulate it if needed and otherwise return it as is."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", contextualize_q_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history_aware_retriever = create_history_aware_retriever(
        llm, retriever, contextualize_q_prompt
    )

    return history_aware_retriever
```

---

## End of Plan
