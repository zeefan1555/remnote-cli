#!/usr/bin/env bash
# Code quality checker - runs all quality checks
set -e

# Ensure Node.js is available via PATH or NVM
source "$(dirname "$0")/node-check.sh" || exit 1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counter for failures
FAILURES=0

echo "========================================="
echo "Running Code Quality Checks"
echo "========================================="
echo ""

# 1. TypeScript Type Checking
echo -e "${YELLOW}[1/7] Running TypeScript type check...${NC}"
if npm run typecheck; then
  echo -e "${GREEN}✓ Type check passed${NC}"
else
  echo -e "${RED}✗ Type check failed${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 2. Release version policy
echo -e "${YELLOW}[2/7] Checking release version policy...${NC}"
if npm run check:version; then
  echo -e "${GREEN}✓ Release version policy is current${NC}"
else
  echo -e "${RED}✗ Release version policy is inconsistent${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 3. Generated SDK constants and CLI contract
echo -e "${YELLOW}[3/7] Checking generated SDK constants...${NC}"
if npm run check:sdk-constants; then
  echo -e "${GREEN}✓ Generated SDK constants is current${NC}"
else
  echo -e "${RED}✗ Generated SDK constants is stale${NC}"
  echo -e "${YELLOW}  Run 'npm run generate:sdk-constants' to update it${NC}"
  FAILURES=$((FAILURES + 1))
fi
if npm run check:cli-contract; then
  echo -e "${GREEN}✓ CLI contract is current${NC}"
else
  echo -e "${RED}✗ CLI contract is stale${NC}"
  echo -e "${YELLOW}  Run 'npm run generate:cli-contract' to update it${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 4. ESLint
echo -e "${YELLOW}[4/7] Running ESLint...${NC}"
if npm run lint; then
  echo -e "${GREEN}✓ Lint check passed${NC}"
else
  echo -e "${RED}✗ Lint check failed${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 5. Prettier Format Check
echo -e "${YELLOW}[5/7] Running Prettier format check...${NC}"
if npm run format:check; then
  echo -e "${GREEN}✓ Format check passed${NC}"
else
  echo -e "${RED}✗ Format check failed${NC}"
  echo -e "${YELLOW}  Run 'npm run format' to fix formatting${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 6. Tests and coverage
echo -e "${YELLOW}[6/7] Running tests with coverage...${NC}"
# Vitest creates worker files under coverage/.tmp. Start every coverage run from
# an empty generated directory so a preceding non-coverage test run cannot race
# its cleanup with the V8 provider.
node -e "require('node:fs').rmSync('coverage', { recursive: true, force: true })"
if npm run test:coverage; then
  echo -e "${GREEN}✓ Tests and coverage passed${NC}"
else
  echo -e "${RED}✗ Tests or coverage failed${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# 7. Build and installed-bin smoke
echo -e "${YELLOW}[7/7] Building and checking the CLI executable...${NC}"
if npm run build && npm run test:bin; then
  echo -e "${GREEN}✓ Build and executable smoke passed${NC}"
else
  echo -e "${RED}✗ Build or executable smoke failed${NC}"
  FAILURES=$((FAILURES + 1))
fi
echo ""

# Summary
echo "========================================="
if [ $FAILURES -eq 0 ]; then
  echo -e "${GREEN}All checks passed! ✓${NC}"
  exit 0
else
  echo -e "${RED}$FAILURES check(s) failed ✗${NC}"
  exit 1
fi
