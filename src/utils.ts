export function slugifyAgentName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'agent';
}

export function sanitizeBranchName(branch: string): string {
  const trimmed = branch.trim();
  let sanitized = '';
  for (const ch of trimmed) {
    if (/[a-zA-Z0-9_\-\/]/.test(ch)) {
      sanitized += ch;
    } else {
      sanitized += '-';
    }
  }
  while (sanitized.includes('--')) {
    sanitized = sanitized.replace(/--/g, '-');
  }
  return sanitized.replace(/^-+|-+$/g, '');
}
