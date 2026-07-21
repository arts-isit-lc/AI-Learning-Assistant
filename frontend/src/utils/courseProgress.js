/**
 * Course-progress helpers shared by the student course page and the home grid.
 *
 * The student course-list endpoint (`student/course`) returns only course
 * identity, so per-course progress is derived from `student/course_page` (flat
 * concept -> module rows carrying `module_score`). A concept counts as complete
 * when its modules average 100 — the same rule the Learning Journey uses.
 */

/** Group flat course_page rows into concepts, each with its modules + avg score. */
export function groupConcepts(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.concept_id)) {
      map.set(row.concept_id, {
        concept_id: row.concept_id,
        concept_name: row.concept_name,
        modules: [],
      })
    }
    map.get(row.concept_id).modules.push(row)
  }
  return Array.from(map.values()).map((concept) => {
    const scores = concept.modules.map((m) => m.module_score || 0)
    const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    return { ...concept, average }
  })
}

/**
 * Compute concept + course completion from loaded course_page rows, for the
 * course view + module chat (which already have the rows). A module is complete
 * when `module_score === 100`; a concept is complete when all its active modules
 * are. Returns the concepts (with per-concept counts) + the course rollup.
 *
 * @param {Array} rows course_page rows
 */
export function computeConceptProgress(rows) {
  const concepts = groupConcepts(rows || []).map((c) => {
    const completedModules = c.modules.filter((m) => m.module_score === 100).length
    const totalModules = c.modules.length
    return {
      ...c,
      completedModules,
      totalModules,
      isComplete: totalModules > 0 && completedModules === totalModules,
    }
  })
  const totalConcepts = concepts.length
  const completedConcepts = concepts.filter((c) => c.isComplete).length
  const percent = totalConcepts ? Math.round((completedConcepts / totalConcepts) * 100) : 0
  return { concepts, totalConcepts, completedConcepts, percent }
}

// Per-course completion for the home grid is aggregated server-side instead
// (GET student/progress_summary) — see services/queries/courses.js — because the
// home doesn't load course_page. The course view + chat use computeConceptProgress.
