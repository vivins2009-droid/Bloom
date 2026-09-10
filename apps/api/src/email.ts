import type { Repository } from './repository.js';

export async function processEmailQueue(repository: Repository) {
  const apiKey = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return;
  const jobs = (await repository.read()).emailJobs.filter((job) => !job.sentAt && new Date(job.nextAttemptAt).getTime() <= Date.now()).slice(0, 20);
  for (const job of jobs) {
    try {
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [job.to], subject: job.subject, text: job.text }) });
      if (!response.ok) throw new Error(`Resend returned ${response.status}.`);
      await repository.mutate((db) => { const current = db.emailJobs.find((item) => item.id === job.id); if (current) { current.sentAt = new Date().toISOString(); current.lastError = undefined; } });
    } catch (error) {
      await repository.mutate((db) => { const current = db.emailJobs.find((item) => item.id === job.id); if (current) { current.attempts += 1; current.lastError = error instanceof Error ? error.message : 'Email delivery failed.'; current.nextAttemptAt = new Date(Date.now() + Math.min(6 * 3600000, 30000 * 2 ** current.attempts)).toISOString(); } });
    }
  }
}
