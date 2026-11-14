# Public readiness implementation

Started November 13, 2026 (America/New_York). Scope: the complete repository review and Elizabeth's authorization to implement all findings.

## Work ledger

- [ ] Canonical watch queue; preserve legacy titles, visibility and shared links
- [ ] Durable Undo with production diagnostics and realistic legacy-state regressions
- [ ] Signed SceneDNA evidence, bounded profile labels and cache invalidation
- [ ] Public lists discoverable by visibility; viewer-aware navigation
- [ ] All custom-list titles and empty-list management
- [ ] Shared poster promotion / vertical section browsing without changing rank order
- [ ] Account deletion with populated team analytics
- [ ] Fresh, bounded person matching and feed eligibility
- [ ] Bounded For You retrieval and metadata enrichment path
- [ ] Concierge relevance acceptance matrix, diagnostics and operational limits
- [ ] Country-aware streaming availability
- [ ] Preview recovery, position retention and autoplay diagnostics
- [ ] Onboarding and small-screen/iPad layout review
- [ ] Public Help/legal/store-link readiness
- [ ] Regression tests, release evidence and deployment handoff

## Deployment boundary

Production frontend starts at merge `825840b702c0382af76063cfebeab6244a1de694`; backend starts at `656069ca636a53ba8394ecd33d4e1091d72aa67b`. Backend-dependent changes require the tested Cloud Shell rollout before frontend merge. Existing authorization covers this work; live credentials/device access remain practical limitations, not completed acceptance.

## Constraints

Keep beta Premium available to everyone. Preserve ratings, manual ranking, saved memberships and explicit privacy choices. Do not invent legal text, native signing identifiers or app-store destinations. Do not upload signed-in account screenshots to the repository. Actual iPhone/iPad testing must be reported separately from desktop/browser and mocked-component checks.
