/**
 * Worker Pure Functions — extracted for testing
 *
 * These functions are copied from the Cloudflare Worker (bug-webhook)
 * to establish a tested behavior contract. The Worker source of truth
 * is in the private Sorting-History repo.
 */
// Check if issue labels indicate an SDK pipeline issue (content or translation)
export function isSDKPipelineIssue(labels) {
    return labels.some(l => l.name === 'content-error' || l.name === 'translation-error');
}
// Generate a unique confirmation ID
export function generateConfirmationId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `BUG-${timestamp}-${random}`.toUpperCase();
}
// Strip HTML tags from text
export function sanitizeText(text) {
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .trim();
}
// Validate the bug report payload
export function validateBugReport(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
        return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
    }
    const report = data;
    if (!report.description || typeof report.description !== 'string') {
        errors.push({ field: 'description', message: 'Description is required and must be a string' });
    }
    else {
        const desc = report.description.trim();
        if (desc.length < 10) {
            errors.push({ field: 'description', message: 'Description must be at least 10 characters' });
        }
        else if (desc.length > 5000) {
            errors.push({ field: 'description', message: 'Description must be 5000 characters or less' });
        }
    }
    if (report.category !== undefined && typeof report.category !== 'string') {
        errors.push({ field: 'category', message: 'Category must be a string' });
    }
    if (report.screenshot !== undefined) {
        if (typeof report.screenshot !== 'string') {
            errors.push({ field: 'screenshot', message: 'Screenshot must be a base64-encoded string' });
        }
        else if (report.screenshot.length > 5 * 1024 * 1024) {
            errors.push({ field: 'screenshot', message: 'Screenshot must be less than 5MB' });
        }
    }
    if (report.email !== undefined && typeof report.email === 'string' && report.email.length > 0) {
        if (!report.email.includes('@') || !report.email.includes('.')) {
            errors.push({ field: 'email', message: 'Email must be a valid email address' });
        }
    }
    if (report.deviceInfo !== undefined && typeof report.deviceInfo !== 'object') {
        errors.push({ field: 'deviceInfo', message: 'Device info must be an object' });
    }
    // BA-010.10: Validate bug_type (optional, must be from allowed set)
    const VALID_BUG_TYPES = ['ui_bug', 'gameplay_bug', 'content_error', 'crash_bug'];
    if (report.bug_type !== undefined && report.bug_type !== null) {
        if (typeof report.bug_type !== 'string') {
            errors.push({ field: 'bug_type', message: 'Bug type must be a string' });
        }
        else if (!VALID_BUG_TYPES.includes(report.bug_type)) {
            errors.push({ field: 'bug_type', message: `Bug type must be one of: ${VALID_BUG_TYPES.join(', ')}` });
        }
    }
    if (errors.length > 0) {
        return { valid: false, errors };
    }
    return {
        valid: true,
        report: {
            description: sanitizeText(report.description),
            category: report.category,
            screenshot: report.screenshot,
            email: report.email,
            bug_type: (typeof report.bug_type === 'string' && ['ui_bug', 'gameplay_bug', 'content_error', 'crash_bug'].includes(report.bug_type)) ? report.bug_type : undefined,
            deviceInfo: report.deviceInfo,
        },
    };
}
// Format the GitHub issue body
export function formatIssueBody(report, confirmationId) {
    const deviceInfo = report.deviceInfo;
    let body = `## Bug Report\n\n`;
    body += `**Confirmation ID:** \`${confirmationId}\`\n\n`;
    body += `**Expected behavior:**\nNot specified\n\n`;
    body += `**Actual behavior:**\n${report.description}\n\n`;
    body += `**Steps to reproduce:**\nSee bug report details below\n\n`;
    body += `**Current Screen:**\n${deviceInfo?.currentScreen || 'Not specified'}\n\n`;
    if (report.category) {
        body += `**Category:** ${report.category}\n\n`;
    }
    if (report.email) {
        body += `**Contact Email:** ${report.email}\n\n`;
    }
    // BA-010.10: Write reporter classification hint into issue body (Path B)
    if (report.bug_type) {
        body += `**Reporter Classification:** ${report.bug_type}\n\n`;
    }
    body += `---\n\n`;
    body += `## Device Info\n\n`;
    if (deviceInfo) {
        body += `| Field | Value |\n`;
        body += `|-------|-------|\n`;
        if (deviceInfo.model)
            body += `| Device | ${deviceInfo.model} |\n`;
        if (deviceInfo.osVersion)
            body += `| iOS | ${deviceInfo.osVersion} |\n`;
        if (deviceInfo.appVersion)
            body += `| App Version | ${deviceInfo.appVersion} |\n`;
        if (deviceInfo.buildNumber)
            body += `| Build | ${deviceInfo.buildNumber} |\n`;
        if (deviceInfo.currentScreen)
            body += `| Screen | ${deviceInfo.currentScreen} |\n`;
        if (deviceInfo.locale)
            body += `| Locale | ${deviceInfo.locale} |\n`;
        if (deviceInfo.networkStatus)
            body += `| Network | ${deviceInfo.networkStatus} |\n`;
        if (deviceInfo.availableMemoryMB)
            body += `| Memory | ${deviceInfo.availableMemoryMB} MB |\n`;
    }
    else {
        body += `_No device info provided_\n`;
    }
    body += `\n---\n\n`;
    if (report.screenshot) {
        body += `## Screenshot\n\n`;
        body += `![Screenshot](data:image/png;base64,${report.screenshot})\n\n`;
        body += `---\n\n`;
    }
    body += `_Submitted via Sorting History app_`;
    return body;
}
// Extract rejection reason from a /reject comment
export function extractRejectionReason(commentBody) {
    const reasonMatch = commentBody.match(/\/reject\s+reason:\s*(.+)/i);
    if (reasonMatch) {
        return reasonMatch[1].trim();
    }
    const plainMatch = commentBody.match(/\/reject\s+(.+)/i);
    if (plainMatch) {
        return plainMatch[1].trim();
    }
    return 'No reason provided';
}
