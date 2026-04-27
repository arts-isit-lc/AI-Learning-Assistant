# Phase 5 — Future Considerations (Higher Risk, Strategic)

## 5.1 React 18 → 19

React 19 is available. The app is on `^18.3.1`. React 19 brings Server Components, `use()` hook, and improved Suspense. Not urgent — React 18 is fully supported. Wait until MUI and MRT officially support React 19 before upgrading.

## 5.2 Vite 5 → 8

Vite 8 is the latest. The remaining 2 moderate npm audit vulnerabilities (`esbuild`/`vite`) would be resolved by this upgrade. However, Vite 8 may have breaking changes in config format. Evaluate when ready.

## 5.3 Python Lambda Runtime 3.11 → 3.13

Python 3.11 is still supported but 3.13 is available on Lambda. Upgrading would allow:
- PyMuPDF upgrade beyond 1.25.5 (requires C++20 / gcc 11+ from AL2023)
- Better performance from Python 3.13 optimizations
- Requires rebuilding Docker images with `python:3.13` base

## 5.4 Consider Aurora Serverless v2

The current RDS PostgreSQL instance is a fixed-size instance. Aurora Serverless v2 would:
- Auto-scale based on load
- Reduce cost during low-traffic periods
- Provide better availability with multi-AZ by default
- Support the same PostgreSQL extensions (pgvector)

## 5.5 Implement CI/CD Pipeline

No CI/CD pipeline exists. Deployments are manual. Implement:
- GitHub Actions (or CodePipeline) for automated testing on PR
- Automated `cdk diff` on PR for infrastructure review
- Automated deployment to dev on merge to main
- Manual approval gate for production deployment
