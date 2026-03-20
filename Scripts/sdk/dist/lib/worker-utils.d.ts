/**
 * Worker Pure Functions — extracted for testing
 *
 * These functions are copied from the Cloudflare Worker (bug-webhook)
 * to establish a tested behavior contract. The Worker source of truth
 * is in the private Sorting-History repo.
 */
export interface BugReport {
    description: string;
    category?: string;
    screenshot?: string;
    email?: string;
    bug_type?: string;
    deviceInfo?: {
        model?: string;
        osVersion?: string;
        appVersion?: string;
        buildNumber?: string;
        currentScreen?: string;
        locale?: string;
        networkStatus?: string;
        availableMemoryMB?: number;
    };
}
export interface ValidationError {
    field: string;
    message: string;
}
export interface GitHubLabel {
    name: string;
}
export declare function isSDKPipelineIssue(labels: GitHubLabel[]): boolean;
export declare function generateConfirmationId(): string;
export declare function sanitizeText(text: string): string;
export declare function validateBugReport(data: unknown): {
    valid: true;
    report: BugReport;
} | {
    valid: false;
    errors: ValidationError[];
};
export declare function formatIssueBody(report: BugReport, confirmationId: string): string;
export declare function extractRejectionReason(commentBody: string): string;
