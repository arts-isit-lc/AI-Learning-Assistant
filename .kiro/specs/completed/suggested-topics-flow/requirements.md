# Requirements Document

## Introduction

This feature improves the topic suggestion workflow on both the New Module and Edit Module pages. On the New Module page, topics are auto-generated when file processing completes and populated directly into the editable key topics list. On the Edit Module page, the current "Populate from generated topics" overwrite button is replaced with an additive "Suggested Topics" merge UI that lets instructors selectively incorporate generated suggestions into their existing key topics.

## Glossary

- **New_Module_Page**: The `InstructorNewModule.jsx` page where instructors create a new course module, upload files, and configure key topics before saving.
- **Edit_Module_Page**: The `InstructorEditCourse.jsx` page where instructors modify an existing module's properties, files, and key topics.
- **Key_Topics_List**: The editable MUI Chip list in both pages representing the instructor's curated topics for the module (stored as `key_topics`).
- **Suggested_Topics**: The list of topics returned by `POST /instructor/generate_topics` that are presented to the instructor for review and selection.
- **Processing_Poller**: The `useProcessingPoller` hook that tracks file processing statuses and detects when all tracked files reach a terminal state (complete, failed, or timed_out).
- **Generate_Topics_API**: The backend endpoint `POST /instructor/generate_topics` that aggregates per-file topic extractions into module-level topics.
- **Terminal_State**: A file processing status of `complete`, `failed`, or `timed_out` indicating the file is no longer being actively processed.
- **Merge_Selection**: The process of adding selected suggested topics to an existing Key_Topics_List without removing topics already present.

## Requirements

### Requirement 1: Auto-Generate Topics on File Processing Completion (New Module)

**User Story:** As an instructor creating a new module, I want topics to be automatically generated when my uploaded files finish processing, so that I have immediate suggestions without needing to save and navigate to the edit page.

#### Acceptance Criteria

1. WHEN all tracked files in the Processing_Poller reach a Terminal_State AND at least one tracked file has status `complete`, THE New_Module_Page SHALL call the Generate_Topics_API with the reserved `moduleId`.
2. WHEN the Generate_Topics_API returns a successful response with a `topics` array, THE New_Module_Page SHALL populate the returned topics directly into the Key_Topics_List state.
3. WHEN the Generate_Topics_API returns `status: "processing"`, THE New_Module_Page SHALL display a toast notification indicating the number of ready files versus total files.
4. IF the Generate_Topics_API returns an error or `status: "error"`, THEN THE New_Module_Page SHALL display an error toast and leave the Key_Topics_List unchanged.
5. THE New_Module_Page SHALL auto-generate topics only once per page lifecycle, preventing duplicate calls when the Processing_Poller transitions through intermediate states.
6. THE New_Module_Page SHALL remove the existing static message "Save the module first, then generate topics from the edit page."

### Requirement 2: Auto-Populated Topics Are Editable (New Module)

**User Story:** As an instructor, I want to edit, delete, or add to the auto-populated topics before saving, so that I retain full control over the final key topics for my module.

#### Acceptance Criteria

1. WHEN topics are auto-populated into the Key_Topics_List, THE New_Module_Page SHALL render each topic as an editable MUI Chip with a delete action.
2. THE New_Module_Page SHALL allow the instructor to click a Chip to inline-edit the topic text.
3. THE New_Module_Page SHALL allow the instructor to delete individual auto-populated topics via the Chip's delete icon.
4. THE New_Module_Page SHALL allow the instructor to add additional topics manually using the existing text input field.
5. WHEN auto-populated topics duplicate a topic already manually entered by the instructor, THE New_Module_Page SHALL skip the duplicate and not add it to the Key_Topics_List.

### Requirement 3: Suggested Topics Button (Edit Module)

**User Story:** As an instructor editing a module, I want a "Suggested Topics" button that regenerates topic suggestions without overwriting my existing topics, so that I can selectively incorporate new suggestions.

#### Acceptance Criteria

1. THE Edit_Module_Page SHALL replace the existing "Populate from generated topics" button with a "Suggested Topics" button.
2. WHEN the instructor clicks the "Suggested Topics" button, THE Edit_Module_Page SHALL call the Generate_Topics_API with the current `module_id`.
3. WHILE the Generate_Topics_API request is in progress, THE Edit_Module_Page SHALL display a loading indicator on the "Suggested Topics" button and disable the button.
4. WHEN the Generate_Topics_API returns a successful response, THE Edit_Module_Page SHALL present the returned topics as selectable suggestion chips in a dedicated suggestions area below the Key_Topics_List.
5. IF the Generate_Topics_API returns `status: "processing"`, THEN THE Edit_Module_Page SHALL display a toast notification with the processing progress and not open the suggestions area.
6. IF the Generate_Topics_API returns an error, THEN THE Edit_Module_Page SHALL display an error toast and not modify the suggestions area.

### Requirement 4: Selectable Suggestion Chips (Edit Module)

**User Story:** As an instructor, I want to select individual suggested topics to add to my key topics, so that I can cherry-pick relevant suggestions without losing my existing curation.

#### Acceptance Criteria

1. WHEN suggested topics are displayed, THE Edit_Module_Page SHALL render each suggestion as a selectable Chip that is visually distinct from the existing Key_Topics_List chips.
2. WHEN the instructor clicks a suggestion Chip, THE Edit_Module_Page SHALL add that topic to the Key_Topics_List and remove the chip from the suggestions area.
3. WHEN the instructor adds a suggested topic that already exists in the Key_Topics_List (case-insensitive match), THE Edit_Module_Page SHALL skip the addition and visually indicate the topic is already present.
4. THE Edit_Module_Page SHALL provide an "Add All" action that adds all remaining non-duplicate suggestions to the Key_Topics_List in a single action.
5. THE Edit_Module_Page SHALL provide a "Dismiss" action that closes the suggestions area without adding any topics.
6. WHEN all suggestion chips have been added or dismissed, THE Edit_Module_Page SHALL hide the suggestions area.

### Requirement 5: Auto-Generation on File Processing Completion (Edit Module)

**User Story:** As an instructor, I want topics to be automatically re-generated when newly uploaded files finish processing on the edit page, so that I am presented with updated suggestions reflecting the latest course materials.

#### Acceptance Criteria

1. WHEN all tracked files in the Processing_Poller reach a Terminal_State AND at least one tracked file has status `complete`, THE Edit_Module_Page SHALL call the Generate_Topics_API automatically.
2. WHEN the auto-triggered Generate_Topics_API returns a successful response, THE Edit_Module_Page SHALL present the results using the same selectable suggestion chips UI described in Requirement 4.
3. THE Edit_Module_Page SHALL NOT overwrite or modify the existing Key_Topics_List when auto-generation completes.
4. THE Edit_Module_Page SHALL auto-generate topics only once per batch of tracked files, preventing duplicate calls.

### Requirement 6: Visual Feedback During Topic Generation

**User Story:** As an instructor, I want clear visual feedback when topic generation is in progress, so that I understand the system is working and know when results are available.

#### Acceptance Criteria

1. WHILE topic generation is in progress on the New_Module_Page, THE New_Module_Page SHALL display a loading indicator near the Key_Topics_List section.
2. WHILE topic generation is in progress on the Edit_Module_Page, THE Edit_Module_Page SHALL disable the "Suggested Topics" button and show a spinner or loading text.
3. WHEN topic generation completes successfully on the New_Module_Page, THE New_Module_Page SHALL display a brief success toast notification.
4. WHEN topic generation completes successfully on the Edit_Module_Page, THE Edit_Module_Page SHALL reveal the suggestions area with the new topics.
