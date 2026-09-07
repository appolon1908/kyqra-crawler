#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$root_dir/.github/workflows/publish-kyqra-production.yml"

test -f "$workflow"
test "$(grep -Ec '^    branches: \[main\]$' "$workflow")" = 1
! grep -Eq '^[[:space:]]+tags:' "$workflow"
grep -Fq "github.ref == 'refs/heads/main' && github.ref_protected == true" "$workflow"
grep -Fq 'test "$GITHUB_REF_PROTECTED" = '\''true'\''' "$workflow"
grep -Fq 'ref: ${{ github.sha }}' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'SOURCE_DATE_EPOCH=${{ steps.source.outputs.epoch }}' "$workflow"
grep -Fq 'SOURCE_COMMIT_SHA=${{ env.SOURCE_SHA }}' "$workflow"

! grep -Eq 'pull-requests:[[:space:]]*write|contents:[[:space:]]*write|issues:[[:space:]]*write' "$workflow"
test "$(grep -Ec 'uses: [a-z0-9-]+/[a-z0-9-]+@[0-9a-f]{40}$' "$workflow")" = 6
test "$(grep -Ec '@sha256:[0-9a-f]{64}$' "$workflow")" = 3
! grep -Eq 'uses:[[:space:]]+[^[:space:]]+@v[0-9]+' "$workflow"

scan_line="$(grep -n 'Scan exact candidate digest before production promotion' "$workflow" | cut -d: -f1)"
collision_line="$(grep -n 'Reject an immutable source-tag collision before signing' "$workflow" | cut -d: -f1)"
sign_line="$(grep -n 'Sign and attest the passing immutable digest' "$workflow" | cut -d: -f1)"
verify_line="$(grep -n 'Verify exact GitHub OIDC signing identity and predicates' "$workflow" | cut -d: -f1)"
promote_line="$(grep -n 'Promote only the fully certified digest to the immutable source tag' "$workflow" | cut -d: -f1)"
(( scan_line < collision_line && collision_line < sign_line && sign_line < verify_line && verify_line < promote_line ))

grep -Fq -- '--severity HIGH,CRITICAL' "$workflow"
grep -Fq 'test "$existing" = "$CANDIDATE_DIGEST"' "$workflow"
test "$(grep -Fc 'if existing=' "$workflow")" = 2
grep -Fq "if: steps.final_tag.outputs.exists != 'true'" "$workflow"
grep -Fq "echo 'exists=true' >> \"\$GITHUB_OUTPUT\"" "$workflow"
grep -Fq 'imagetools create --prefer-index=false' "$workflow"
grep -Fq 'cosign sign --yes "$exact_image"' "$workflow"
grep -Fq 'cosign attest --yes --type slsaprovenance1' "$workflow"
grep -Fq 'cosign attest --yes --type spdxjson' "$workflow"
grep -Fq 'cosign verify-attestation --type slsaprovenance1' "$workflow"
grep -Fq 'cosign verify-attestation --type spdxjson' "$workflow"
grep -Fq 'https://token.actions.githubusercontent.com' "$workflow"
grep -Fq 'sourceCommit == $source' "$workflow"
grep -Fq 'registryDigest == $digest' "$workflow"
grep -Fq 'sha256sum -c SHA256SUMS' "$workflow"

! grep -Eqi '(^|[[:space:]])(ssh|scp)[[:space:]]|docker compose (up|restart)|systemctl restart|sendmail|canary' "$workflow"
