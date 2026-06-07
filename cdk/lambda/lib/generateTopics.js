/**
 * Topic Aggregator Module
 *
 * Consolidates per-file topics from all files in a module into a final
 * set of module-level topics using Claude 3 Haiku via Amazon Bedrock.
 */
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

// NOTE: Hard-coded to Haiku for cost/speed. Make configurable via env var in future.
const TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";
const REGION = process.env.REGION || "ca-central-1";
const BEDROCK_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Generate consolidated module topics from per-file extraction results.
 *
 * @param {string} moduleId - The module ID to generate topics for.
 * @param {object} sqlConnection - Active postgres.js connection.
 * @returns {object} The consolidated result or processing status.
 */
async function generateModuleTopics(moduleId, sqlConnection) {
  if (!moduleId) {
    return { statusCode: 400, body: { error: "module_id is required" } };
  }

  // 1. Query all Module_Files for this module
  const files = await sqlConnection`
    SELECT file_id, filename, filetype, metadata
    FROM "Module_Files"
    WHERE module_id = ${moduleId};
  `;

  if (files.length === 0) {
    return {
      statusCode: 200,
      body: { status: "no_files", topics: [], learning_objectives: [] },
    };
  }

  // 2. Check completion status and collect topics
  const totalFiles = files.length;
  let filesWithTopics = 0;
  const allTopics = [];
  const allObjectives = [];
  const sourceFileIds = [];
  const sourceFileEtags = {};

  for (const file of files) {
    let metadata = file.metadata;

    // Handle case where metadata is returned as a JSON string instead of object
    if (metadata && typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }

    if (metadata && metadata.topic_extraction && metadata.topic_extraction.topics && metadata.topic_extraction.topics.length > 0) {
      filesWithTopics++;
      allTopics.push(...metadata.topic_extraction.topics);
      if (metadata.topic_extraction.learning_objectives) {
        allObjectives.push(...metadata.topic_extraction.learning_objectives);
      }
      sourceFileIds.push(String(file.file_id));
      if (metadata.topic_extraction.s3_etag) {
        sourceFileEtags[String(file.file_id)] = metadata.topic_extraction.s3_etag;
      }
    }
  }

  // 3. If not all files have completed extraction, return processing status
  if (filesWithTopics < totalFiles) {
    return {
      statusCode: 200,
      body: { status: "processing", ready: filesWithTopics, total: totalFiles },
    };
  }

  // 4. If topics are small enough, passthrough without LLM call
  let consolidated;
  if (allTopics.length <= 5 && allObjectives.length <= 5) {
    consolidated = {
      topics: allTopics,
      learning_objectives: allObjectives,
      generated_at: new Date().toISOString(),
      model: "direct-passthrough",
      source_file_count: filesWithTopics,
      source_file_ids: sourceFileIds,
      source_file_etags: sourceFileEtags,
    };
  } else {
    // 5. Call Haiku for consolidation
    try {
      const llmResult = await callHaikuForConsolidation(allTopics, allObjectives, filesWithTopics);
      consolidated = {
        ...llmResult,
        generated_at: new Date().toISOString(),
        model: TOPIC_EXTRACTION_MODEL_ID,
        source_file_count: filesWithTopics,
        source_file_ids: sourceFileIds,
        source_file_etags: sourceFileEtags,
      };
    } catch (error) {
      console.error("Topic consolidation failed:", error.message);
      return {
        statusCode: 500,
        body: { status: "error", message: "Topic consolidation failed after 3 attempts" },
      };
    }
  }

  // 6. Store in Course_Modules.generated_topics
  await sqlConnection`
    UPDATE "Course_Modules"
    SET generated_topics = ${sqlConnection.json(consolidated)}
    WHERE module_id = ${moduleId};
  `;

  return { statusCode: 200, body: consolidated };
}

/**
 * Call Claude 3 Haiku to consolidate per-file topics into module-level topics.
 * Retries up to 3 times on JSON parse failures.
 *
 * @param {string[]} allTopics - Combined topics from all files.
 * @param {string[]} allObjectives - Combined learning objectives from all files.
 * @param {number} fileCount - Number of source files.
 * @returns {object} Parsed consolidation result with topics and learning_objectives.
 */
async function callHaikuForConsolidation(allTopics, allObjectives, fileCount) {
  const topicsList = allTopics.map((t) => `- ${t}`).join("\n");
  const objectivesList = allObjectives.map((o) => `- ${o}`).join("\n");

  const prompt = `You are analyzing the combined topics from all course materials in a single module.
Multiple documents have been analyzed individually and their topics extracted.

Here are all the topics found across ${fileCount} documents:
${topicsList}

Here are all the learning objectives found:
${objectivesList}

Consolidate these into:
- "topics": The overarching main topics (maximum 7). Remove duplicates and merge overlapping topics. Only keep topics that represent core subject matter.
- "learning_objectives": The key learning objectives (maximum 7). Merge similar objectives and keep only the most important.

Do not set a minimum. If only 1-2 core topics exist, return only those.
Return valid JSON only, no markdown formatting:
{"topics": [...], "learning_objectives": [...]}`;

  const requestBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const command = new InvokeModelCommand({
        modelId: TOPIC_EXTRACTION_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: requestBody,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BEDROCK_TIMEOUT_MS);

      let response;
      try {
        response = await bedrockClient.send(command, {
          abortSignal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const resultBody = JSON.parse(new TextDecoder().decode(response.body));
      let content = resultBody.content[0].text.trim();

      // Strip markdown fences if present
      if (content.startsWith("```")) {
        const firstNewline = content.indexOf("\n");
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : content.slice(3);
        if (content.endsWith("```")) {
          content = content.slice(0, -3);
        }
        content = content.trim();
      }

      const parsed = JSON.parse(content);

      // Validate structure
      if (!parsed.topics || !Array.isArray(parsed.topics)) {
        throw new Error("Missing or invalid 'topics' field");
      }

      // Enforce limits
      parsed.topics = parsed.topics.slice(0, 7);
      if (parsed.learning_objectives && Array.isArray(parsed.learning_objectives)) {
        parsed.learning_objectives = parsed.learning_objectives.slice(0, 7);
      } else {
        parsed.learning_objectives = [];
      }

      return parsed;
    } catch (error) {
      console.warn(`Consolidation attempt ${attempt + 1}/${MAX_RETRIES} failed:`, error.message);
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(`Topic consolidation failed after ${MAX_RETRIES} attempts: ${error.message}`);
      }
    }
  }
}

module.exports = { generateModuleTopics };
