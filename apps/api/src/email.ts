import type { Repository } from './repository.js';

export async function processEmailQueue(repository: Repository) {
  if (process.env.EMAIL_ENABLED !== 'true') return;
  const apiKey = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return;
  const jobs = await repository.mutate((db) => {
    const now = Date.now();
    const selected = db.emailJobs.filter((job) => !job.sentAt && new Date(job.nextAttemptAt).getTime() <= now && (!job.processingAt || now - new Date(job.processingAt).getTime() > 10 * 60000)).slice(0, 20);
    selected.forEach((job) => { job.processingAt = new Date(now).toISOString(); });
    return selected.map((job) => ({ ...job }));
  });
  for (const job of jobs) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': `bloom-email/${job.id}` },
        body: JSON.stringify({ from, to: [job.to], subject: job.subject, text: job.text })
      });
      if (!response.ok) throw new Error(`Resend returned ${response.status}.`);
      const result = await response.json().catch(() => ({})) as { id?: string };
      await repository.mutate((db) => { const current = db.emailJobs.find((item) => item.id === job.id); if (current) { current.sentAt = new Date().toISOString(); current.providerMessageId = result.id; current.processingAt = undefined; current.lastError = undefined; } });
    } catch (error) {
      await repository.mutate((db) => { const current = db.emailJobs.find((item) => item.id === job.id); if (current) { current.attempts += 1; current.processingAt = undefined; current.lastError = error instanceof Error ? error.message : 'Email delivery failed.'; current.nextAttemptAt = new Date(Date.now() + Math.min(6 * 3600000, 30000 * 2 ** current.attempts)).toISOString(); } });
    }
  }
}
