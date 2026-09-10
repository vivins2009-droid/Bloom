import { deleteAttachment } from './storage.js';
import type { Repository } from './repository.js';

export async function cleanExpiredChatContent(repository: Repository) {
  const cutoff = Date.now() - 365 * 86400000;
  const state = await repository.read();
  const expiredAttachments = state.chatAttachments.filter((attachment) => new Date(attachment.expiresAt).getTime() <= Date.now());
  for (const attachment of expiredAttachments) await deleteAttachment(attachment.objectKey);
  await repository.mutate((db) => {
    const expiredIds = new Set(expiredAttachments.map((attachment) => attachment.id));
    db.chatAttachments = db.chatAttachments.filter((attachment) => !expiredIds.has(attachment.id));
    db.chatMessages = db.chatMessages.filter((message) => new Date(message.createdAt).getTime() > cutoff);
  });
}
