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

// Check if issue labels indicate an SDK pipeline issue (content or translation)
export function isSDKPipelineIssue(labels: GitHubLabel[]): boolean {
  return labels.some(l => l.name === 'content-error' || l.name === 'translation-error');
}

// Generate a unique confirmation ID
export function generateConfirmationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `BUG-${timestamp}-${random}`.toUpperCase();
}

// Strip HTML tags from text
export function sanitizeText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, ' ')
    .trim();
}

// Validate the bug report payload
export function validateBugReport(data: unknown): { valid: true; report: BugReport } | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const report = data as Record<string, unknown>;

  if (!report.description || typeof report.description !== 'string') {
    errors.push({ field: 'description', message: 'Description is required and must be a string' });
  } else {
    const desc = report.description.trim();
    if (desc.length < 10) {
      errors.push({ field: 'description', message: 'Description must be at least 10 characters' });
    } else if (desc.length > 5000) {
      errors.push({ field: 'description', message: 'Description must be 5000 characters or less' });
    }
  }

  if (report.category !== undefined && typeof report.category !== 'string') {
    errors.push({ field: 'category', message: 'Category must be a string' });
  }

  if (report.screenshot !== undefined) {
    if (typeof report.screenshot !== 'string') {
      errors.push({ field: 'screenshot', message: 'Screenshot must be a base64-encoded string' });
    } else if (report.screenshot.length > 5 * 1024 * 1024) {
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

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    report: {
      description: sanitizeText(report.description as string),
      category: report.category as string | undefined,
      screenshot: report.screenshot as string | undefined,
      email: report.email as string | undefined,
      deviceInfo: report.deviceInfo as BugReport['deviceInfo'],
    },
  };
}

// Format the GitHub issue body
export function formatIssueBody(report: BugReport, confirmationId: string): string {
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

  body += `---\n\n`;
  body += `## Device Info\n\n`;

  if (deviceInfo) {
    body += `| Field | Value |\n`;
    body += `|-------|-------|\n`;
    if (deviceInfo.model) body += `| Device | ${deviceInfo.model} |\n`;
    if (deviceInfo.osVersion) body += `| iOS | ${deviceInfo.osVersion} |\n`;
    if (deviceInfo.appVersion) body += `| App Version | ${deviceInfo.appVersion} |\n`;
    if (deviceInfo.buildNumber) body += `| Build | ${deviceInfo.buildNumber} |\n`;
    if (deviceInfo.currentScreen) body += `| Screen | ${deviceInfo.currentScreen} |\n`;
    if (deviceInfo.locale) body += `| Locale | ${deviceInfo.locale} |\n`;
    if (deviceInfo.networkStatus) body += `| Network | ${deviceInfo.networkStatus} |\n`;
    if (deviceInfo.availableMemoryMB) body += `| Memory | ${deviceInfo.availableMemoryMB} MB |\n`;
  } else {
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
export function extractRejectionReason(commentBody: string): string {
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
