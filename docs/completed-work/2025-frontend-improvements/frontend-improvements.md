# Frontend Improvements

Items to investigate during a deeper frontend review.

## Dead Dependencies

- `react-beautiful-dnd` — listed in `frontend/package.json` but not imported anywhere in `frontend/src/`. Safe to remove. Reduces install size and potential bundle impact if tree-shaking misses it.
