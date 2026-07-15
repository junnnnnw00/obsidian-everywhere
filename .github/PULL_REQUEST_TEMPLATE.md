## What this does

## Why

## Testing

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` all pass
- [ ] New behavior has test coverage (see "Testing conventions" in `CONTRIBUTING.md` —
      no mocking the core engine; new parser/link edge cases belong in `fixtures/test-vault/`)
- [ ] If this changes parsing/resolution behavior, I extended the fixture vault rather than only adding inline-string unit tests

## Decisions

- [ ] Any non-obvious design choice (default value, tie-break rule, new dependency) is recorded in `DECISIONS.md`
- [ ] N/A — this PR doesn't make any judgment calls the spec/existing code didn't already settle
