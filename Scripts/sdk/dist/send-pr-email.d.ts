/**
 * Entry point for sending PR created email from GitHub Actions YAML.
 *
 * Reads all parameters from environment variables and calls sendPRCreatedEmail().
 * Exit code 0 always — email failure must never break the pipeline.
 *
 * Required env vars: RESEND_API_KEY, OWNER_EMAIL
 * Required env vars (data): PR_URL, PR_NUMBER, ISSUE_NUMBER, ISSUE_TITLE,
 *   FILES_MODIFIED, COMPILATION, CONFIDENCE, FIX_ATTEMPTS, PIPELINE_MODE
 * Optional env vars: AUTH_TOKEN (for reject button), BUILD_NUMBER,
 *   ISSUE_BODY_FILE (path to file with issue body), QA_SUMMARY_FILE (path to QA summary)
 */
export {};
