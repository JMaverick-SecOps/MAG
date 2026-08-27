import test from "node:test";
import assert from "node:assert/strict";
import { securityReviewManifest, tierById, validateSecurityReview } from "../src/security-services.js";

const valid = { tier_id: "focused-code-review", organization: "Example LLC", contact_email: "security@example.com", repository_url: "https://github.com/example/project", commit_sha: "a".repeat(40), branch_context: "main", scope_paths: ["src/", "package-lock.json"], authorization_attested: true, repository_license_attested: true, safe_testing_consent: true };

test("security review catalog uses bounded fair-market entry prices", () => {
  assert.equal(tierById("static-scan-review").price_atomic, "49000000");
  assert.equal(tierById("focused-code-review").price_atomic, "149000000");
});

test("security review intake pins scope to an exact commit", () => {
  const review = validateSecurityReview(valid);
  assert.equal(review.commitSha, "a".repeat(40));
  assert.deepEqual(review.scopePaths, ["src/", "package-lock.json"]);
  assert.throws(() => validateSecurityReview({ ...valid, commit_sha: "main" }), /exact/);
  assert.throws(() => validateSecurityReview({ ...valid, scope_paths: ["../secrets"] }), /scope path/);
});

test("security review intake requires authorization and repository rights", () => {
  assert.throws(() => validateSecurityReview({ ...valid, authorization_attested: false }), /authorization/);
});

test("security manifest prohibits running untrusted code on the Worker", () => {
  const manifest = securityReviewManifest();
  assert.ok(manifest.safety.includes("untrusted code is never executed on the Worker"));
  assert.match(manifest.honesty, /currently provides priced intake/i);
});
