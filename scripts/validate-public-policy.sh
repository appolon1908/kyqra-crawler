#!/usr/bin/env bash
set -euo pipefail

npm run test:integration
echo 'PUBLIC_ROUTE_POLICY_TESTS=PASS'
