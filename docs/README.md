# Documentation

## Structure

```
docs/
├── guides/              # User-facing reference documentation
├── architecture/        # System design and code-level documentation
├── planning/            # Feature plans not yet implemented
├── completed-work/      # Implemented plans archived by YYYY-feature-name
├── images/              # Screenshots and diagrams referenced by guides
└── api-documentation.pdf
```

## Guides

Operational and onboarding documentation for developers, admins, and users.

| File | Purpose |
|------|---------|
| `deploymentGuide.md` | Full deployment walkthrough |
| `userGuide.md` | End-user guide (Admin, Instructor, Student) |
| `securityGuide.md` | Security posture and configuration |
| `troubleshootingGuide.md` | Common issues and fixes |
| `debugging-guide.md` | Developer debugging workflows |
| `ExistingVPCDeployment.md` | Deploying into a pre-existing VPC |
| `optionalModifications.md` | Optional configuration tweaks |

## Architecture

How the system works — system design docs and code-level module documentation.

## Planning

Feature plans that are approved but not yet implemented. Once a plan is fully implemented, move it to `completed-work/YYYY-feature-name/`.

## Completed Work

Archive of planning documents for features that have been implemented. Organized by year and feature name for historical reference.

| Folder | Feature |
|--------|---------|
| `2025-chatbot-performance` | Streaming, query optimization, architecture improvements |
| `2025-cost-optimization` | VPC endpoints, Lambda right-sizing, log retention |
| `2025-dependency-upgrades` | MUI v9, TypeScript 6, langchain-aws 1.4, Node 22 |
| `2025-frontend-improvements` | Code splitting, API client, toast consolidation |
| `2025-infrastructure-hardening` | IAM scoping, removal policies, security hardening |
| `2025-observability` | CloudWatch alarms, X-Ray, structured logging, dashboard |
